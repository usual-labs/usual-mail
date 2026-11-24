// Search over what the server holds (docs/contract-search.md): the text through the FTS5 index, ranked by relevance
// with recency as a strong tie-break; filters on the thread's own columns and on who wrote; done, screened and blocked
// senders' threads included, trashed and removed ones not. Filters with no text list newest first, as every list does.

import {
  CATEGORIES,
  ServiceError,
  type Caller,
  type Category,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
} from "@usualmail/core";
import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { threads } from "../db/index.ts";
import { contains, endsWith } from "../db/match.ts";
import { inList } from "../db/params.ts";
import type { Ctx } from "../service/context.ts";
import { listScope } from "../service/access.ts";
import { visible } from "../service/lists.ts";
import { publishedSecond, toThread } from "../service/rows.ts";
import { check, SearchQuerySchema } from "../service/schemas.ts";
import { base64url, fromBase64url, pageLimit, parseTime } from "../util.ts";
import { matchesOf, peopleOf } from "./excerpt.ts";
import { COLUMNS, excludeExpression, matchExpression, strongExpression, WEIGHTS } from "./fts.ts";
import type { SearchIndex } from "./indexer.ts";
import { fold, parseSearch, type Parsed } from "./terms.ts";

/**
 * Recency's part of the rank: a match's relevance (bm25) is divided by the square root of 1 + its age in units of
 * 14 days, so a match of the same strength two weeks old ranks about 0.7 as high, three months old 0.37, a year old
 * about 0.2. The query orders by the square of that (the same order, with no square root in SQL).
 */
export const RECENCY_MS = 14 * 24 * 60 * 60_000;

interface RankCursor {
  k: "r";
  /** The moment the first page ranked against, so later pages rank the same. */
  n: number;
  /** The tier: 1 for a match within the subject and who wrote. */
  t: number;
  s: number;
  i: string;
}
interface ListCursor {
  k: "l";
  a: number;
  i: string;
}

/** A search the caller asked for, its scope worked out and its text read. */
export interface Prepared {
  parsed: Parsed;
  scope: string[];
}

/** Checks a search, works out its inboxes and reads its text and operators. Shared with remote search. */
export async function prepare(ctx: Ctx, caller: Caller, input: SearchQuery): Promise<Prepared & { query: SearchQuery }> {
  const query = check(SearchQuerySchema, input, "Search");
  const zone = zoneOf(query.tz, ctx.host.timeZone);
  for (const key of ["after", "before"] as const) if (query[key] !== undefined) parseTime(query[key]!, key);
  const { q, tz: _tz, cursor: _cursor, limit: _limit, ...filters } = query;
  const parsed = parseSearch(q ?? "", filters, zone);
  const scope: string[] = [];
  if (query.inboxIds?.length) {
    for (const id of new Set(query.inboxIds)) scope.push(...await listScope(ctx, caller, id));
  } else {
    scope.push(...await listScope(ctx, caller, undefined));
  }
  const u = parsed.understood;
  const hasFilter = u.kinds?.length || u.from || u.to || u.subject || u.hasAttachment !== undefined || u.after || u.before
    || u.unread !== undefined;
  if (!parsed.words.length && !parsed.phrases.length && !parsed.exclude.length && !hasFilter) {
    throw new ServiceError("invalid", "Search needs some text or a filter");
  }
  return { query, parsed, scope };
}

export async function searchLocal(ctx: Ctx, caller: Caller, input: SearchQuery, index: SearchIndex): Promise<SearchResult> {
  const { query, parsed, scope } = await prepare(ctx, caller, input);
  const result: SearchResult = { items: [], understood: parsed.understood };
  if (scope.length === 0) return result;
  await index.fresh();
  const expr = matchExpression(parsed);
  const where = filtersWhere(parsed, scope);
  const limit = pageLimit(query.limit);
  const page = expr
    ? await ranked(ctx, expr, where, limit, query.cursor)
    : await listed(ctx, where, limit, query.cursor);
  const rows = page.ids.length ? await ctx.db.select().from(threads).where(inList(threads.id, page.ids)) : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const matches = expr ? await matchesOf(ctx, expr, page.ids) : new Map();
  result.items = page.ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    const hit: SearchHit = toThread(row);
    const match = matches.get(id);
    if (match) hit.match = match;
    return [hit];
  });
  if (page.next) result.nextCursor = page.next;
  const words = [...parsed.words, ...parsed.phrases];
  if (!query.cursor && words.length) {
    const people = await peopleOf(ctx, scope, words.join(" "));
    if (people.length) result.people = people;
  }
  return result;
}

/** The filters as SQL over `threads`: scope, not trashed or gone, kinds, attachments, dates, unread, who, exclusions. */
export function filtersWhere(parsed: Parsed, scope: string[]): SQL {
  const u = parsed.understood;
  const parts: Array<SQL | undefined> = [inList(threads.inboxId, scope), visible()];
  const categories = (u.kinds ?? []).filter((kind): kind is Category => (CATEGORIES as readonly string[]).includes(kind));
  if (categories.length) parts.push(inArray(threads.category, categories));
  if (u.kinds?.includes("screened")) parts.push(eq(threads.screened, true));
  if (u.kinds?.includes("done")) parts.push(eq(threads.done, true));
  if (u.hasAttachment !== undefined) parts.push(eq(threads.hasAttachments, u.hasAttachment));
  if (u.unread !== undefined) parts.push(eq(threads.unread, u.unread));
  if (u.after) parts.push(gte(threads.lastMessageAt, Date.parse(u.after)));
  if (u.before) parts.push(lt(threads.lastMessageAt, Date.parse(u.before)));
  if (u.from) parts.push(whoWhere("from", u.from));
  if (u.to) parts.push(whoWhere("to", u.to));
  const exclude = excludeExpression(parsed.exclude);
  if (exclude) {
    parts.push(sql`${threads.id} NOT IN (SELECT search_docs.thread_id FROM search_index(${exclude}) AS ex
      JOIN search_docs ON search_docs.id = ex.rowid)`);
  }
  return and(...parts)!;
}

/**
 * Who wrote or was written to: an address exactly; a domain (with or without a leading @) and its subdomains; or
 * otherwise the start of a word of their name or address, folded.
 */
function whoWhere(role: "from" | "to", value: string): SQL {
  const v = value.trim().toLowerCase().replace(/^<|>$/g, "");
  let match: SQL;
  if (/^[^@\s]+@[^@\s]+$/.test(v)) {
    match = sql`p.email = ${v}`;
  } else if (/^@?[^@\s]+\.[^@\s.]+$/.test(v)) {
    const domain = v.replace(/^@/, "");
    match = sql`(${endsWith(sql`p.email`, `@${domain}`)} OR ${endsWith(sql`p.email`, `.${domain}`)})`;
  } else {
    const words = fold(value).trim();
    if (!words) return sql`0`;
    match = contains(sql`p.folded`, ` ${words}`);
  }
  return sql`EXISTS (SELECT 1 FROM search_people AS p WHERE p.thread_id = ${threads.id} AND p.role = ${role} AND ${match})`;
}

/**
 * A page ranked as docs/contract-search.md says: threads the text matches within the subject and who wrote first, then
 * the rest; within each, relevance (bm25 over the weighted columns) divided by the square root of 1 + the age of the
 * newest mail in units of 14 days (whole seconds, as lists publish times); then id. The cursor holds the moment the
 * first page ranked against, so later pages rank the same.
 */
async function ranked(ctx: Ctx, expr: string, where: SQL, limit: number, cursorText: string | undefined): Promise<{ ids: string[]; next?: string }> {
  const cursor = cursorText ? readCursor(cursorText, "r") : undefined;
  const now = cursor?.n ?? ctx.now();
  const weights = sql.raw(COLUMNS.map((c) => WEIGHTS[c]).join(", "));
  const after = cursor
    ? sql`AND (strong < ${cursor.t} OR (strong = ${cursor.t} AND (score < ${cursor.s} OR (score = ${cursor.s} AND id < ${cursor.i}))))`
    : sql``;
  const rows = await ctx.db.all<{ id: string; strong: number; score: number }>(sql`
    SELECT id, strong, score FROM (
      SELECT id, strong, (b * b) / (1.0 + max(0, ${now} - at) / ${sql.raw(`${RECENCY_MS}.0`)}) AS score FROM (
        SELECT ${threads.id} AS id, bm25(search_index, ${weights}) AS b,
          ${publishedSecond(threads.lastMessageAt)} * 1000 AS at,
          (search_docs.id IN (SELECT rowid FROM search_index(${strongExpression(expr)}))) AS strong
        FROM search_index JOIN search_docs ON search_docs.id = search_index.rowid
        JOIN ${threads} ON ${threads.id} = search_docs.thread_id
        WHERE search_index MATCH ${expr} AND ${where}
      )
    ) WHERE 1 ${after} ORDER BY strong DESC, score DESC, id DESC LIMIT ${limit + 1}`);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    ids: items.map((row) => row.id),
    ...(rows.length > limit && last && { next: writeCursor({ k: "r", n: now, t: Number(last.strong), s: last.score, i: last.id }) }),
  };
}

/** A page of filters alone: newest first by the whole second, then by id, as every list. */
async function listed(ctx: Ctx, where: SQL, limit: number, cursorText: string | undefined): Promise<{ ids: string[]; next?: string }> {
  const cursor = cursorText ? readCursor(cursorText, "l") : undefined;
  const second = publishedSecond(threads.lastMessageAt);
  const past = cursor && sql`(${second} < ${cursor.a} OR (${second} = ${cursor.a} AND ${threads.id} < ${cursor.i}))`;
  const rows = await ctx.db.select({ id: threads.id, at: second }).from(threads)
    .where(and(where, past)).orderBy(sql`${second} DESC`, sql`${threads.id} DESC`).limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    ids: items.map((row) => row.id),
    ...(rows.length > limit && last && { next: writeCursor({ k: "l", a: last.at, i: last.id }) }),
  };
}

function writeCursor(cursor: RankCursor | ListCursor): string {
  return base64url(new TextEncoder().encode(JSON.stringify(cursor)));
}

function readCursor<K extends "r" | "l">(text: string, kind: K): K extends "r" ? RankCursor : ListCursor {
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64url(text))) as Record<string, unknown>;
    const ok = value.k === kind && typeof value.i === "string"
      && (kind === "r" ? Number.isFinite(value.n) && Number.isFinite(value.s) && (value.t === 0 || value.t === 1) : Number.isInteger(value.a));
    if (ok) return value as never;
  } catch {
    // Not one this search gave out.
  }
  throw new ServiceError("invalid", "This cursor isn't one this search gave out");
}

/** The IANA time zone typed dates are days in: the one asked for, else the server's, else UTC. */
export function zoneOf(tz: string | undefined, server: string | undefined): string {
  for (const zone of [tz, server]) {
    if (!zone) continue;
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
    } catch {
      if (zone === tz) throw new ServiceError("invalid", "tz is an IANA time zone, like Europe/Berlin");
    }
  }
  return "UTC";
}
