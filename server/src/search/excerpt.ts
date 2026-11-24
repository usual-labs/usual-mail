// What a local result says beyond its thread (docs/contract-search.md, "What a result carries"): which fields the text
// matched, the subject with its matched words marked, and a short excerpt around a match elsewhere, as runs of plain
// text a client draws without trusting any markup. And the people a search finds: senders whose name or address
// matches the text.

import type { SearchField, SearchMatch, SearchPerson, SearchRun } from "@usualmail/core";
import { sql } from "drizzle-orm";
import { contains } from "../db/match.ts";
import { inList } from "../db/params.ts";
import type { Ctx } from "../service/context.ts";
import { iso as isoTime } from "../util.ts";
import { COLUMNS, type Column } from "./fts.ts";
import { fold } from "./terms.ts";

/** Marks FTS5 puts around a match: control characters, which the indexed text never holds (it is cleaned like a snippet). */
const OPEN = "\u0002";
const CLOSE = "\u0003";
/** An excerpt is at most about this long, like a snippet. */
export const EXCERPT_LIMIT = 200;
/** How many words of a field FTS5 takes around a match. */
const TOKENS: Record<Column, number> = { subject: 64, sender: 12, people: 12, summary: 24, facts: 20, attachments: 16, body: 24 };
/** Where an excerpt comes from: the first of these that matched (the subject is marked on its own). */
const EXCERPT_ORDER: Column[] = ["body", "summary", "facts", "attachments", "people", "sender"];

/** For each thread of the page, where `expr` matched it. */
export async function matchesOf(ctx: Ctx, expr: string, threadIds: string[]): Promise<Map<string, SearchMatch>> {
  const out = new Map<string, SearchMatch>();
  if (!threadIds.length) return out;
  const cuts = sql.join(COLUMNS.map((column, i) => column === "subject"
    ? sql.raw(`highlight(search_index, ${i}, char(2), char(3)) AS c${i}`)
    : sql.raw(`snippet(search_index, ${i}, char(2), char(3), '…', ${TOKENS[column]}) AS c${i}`)), sql`, `);
  // The page's ids, bound as one JSON parameter, drive the join (CROSS JOIN keeps that order), so each thread's index
  // row is looked up by its rowid as a literal list did; with `IN (SELECT … json_each)` SQLite ran the MATCH over the
  // whole index instead (docs/agents/decisions.md, 2026-11-21).
  const rows = await ctx.db.all<Record<string, string | null>>(sql`
    SELECT search_docs.thread_id AS id, ${cuts}
    FROM json_each(${JSON.stringify(threadIds)}) AS page
    CROSS JOIN search_docs ON search_docs.thread_id = page.value
    CROSS JOIN search_index ON search_index.rowid = search_docs.id
    WHERE search_index MATCH ${expr}`);
  for (const row of rows) {
    const cut = (column: Column) => row[`c${COLUMNS.indexOf(column)}`] ?? "";
    const fields = COLUMNS.filter((column) => cut(column).includes(OPEN)).map(fieldOf);
    const match: SearchMatch = { fields };
    if (cut("subject").includes(OPEN)) match.subject = runsOf(cut("subject"), Number.POSITIVE_INFINITY);
    const from = EXCERPT_ORDER.find((column) => cut(column).includes(OPEN));
    if (from) match.excerpt = { field: fieldOf(from), runs: runsOf(cut(from), EXCERPT_LIMIT) };
    out.set(String(row.id), match);
  }
  return out;
}

function fieldOf(column: Column): SearchField {
  return column;
}

/**
 * Text with FTS5's marks as runs: plain text, matched or not, neighbours of the same kind joined, empty ones dropped, at
 * most `limit` characters (the text after the first match cut at a word, with "…").
 */
export function runsOf(marked: string, limit: number): SearchRun[] {
  const runs: SearchRun[] = [];
  let match = false;
  for (const piece of marked.split(/([\u0002\u0003])/)) {
    if (piece === OPEN) match = true;
    else if (piece === CLOSE) match = false;
    else if (piece) {
      const text = piece.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
      const last = runs.at(-1);
      if (last && last.match === match) last.text += text;
      else runs.push({ text, match });
    }
  }
  let room = limit;
  const out: SearchRun[] = [];
  for (const run of runs) {
    if (room <= 0) break;
    if (run.text.length <= room) {
      out.push(run);
      room -= run.text.length;
      continue;
    }
    const space = run.text.slice(0, room).lastIndexOf(" ");
    const kept = (space > 0 ? run.text.slice(0, space) : run.text.slice(0, room)).replace(/[\ud800-\udbff]$/, "").trimEnd();
    if (kept) out.push({ text: run.match ? kept : `${kept}…`, match: run.match });
    break;
  }
  return out;
}

/**
 * Senders whose name or address has each of the text's words as a word start (folded: case, accents, ß), in the
 * inboxes searched, with how many of their threads aren't trashed or gone and their newest mail's time; the inboxes' own
 * addresses left out. Most threads first, then newest. Up to five.
 */
export async function peopleOf(ctx: Ctx, scope: string[], text: string): Promise<SearchPerson[]> {
  const words = fold(text).trim().split(" ").filter(Boolean).slice(0, 6);
  if (!words.length || !scope.length) return [];
  const inScope = inList(sql`p.inbox_id`, scope);
  const rows = await ctx.db.all<{ email: string; threads: number; last: number }>(sql`
    SELECT p.email AS email, count(DISTINCT p.thread_id) AS threads, max(p.last_at) AS last
    FROM search_people AS p JOIN threads AS t ON t.id = p.thread_id
    WHERE p.role = 'from' AND ${inScope} AND t.trashed = 0 AND t.removed = 0
      AND p.email NOT IN (SELECT lower(address) FROM inboxes)
      AND ${sql.join(words.map((word) => contains(sql`p.folded`, ` ${word}`)), sql` AND `)}
    GROUP BY p.email ORDER BY threads DESC, last DESC, email ASC LIMIT 5`);
  if (!rows.length) return [];
  const names = await ctx.db.all<{ email: string; name: string }>(sql`
    SELECT email, name FROM search_people AS p
    WHERE p.role = 'from' AND p.name IS NOT NULL AND ${inScope}
      AND ${inList(sql`p.email`, rows.map((row) => row.email))}
    ORDER BY p.last_at DESC`);
  return rows.map((row) => {
    const name = names.find((n) => n.email === row.email)?.name;
    return { email: row.email, ...(name && { name }), threads: Number(row.threads), lastMessageAt: isoTime(Number(row.last)) };
  });
}
