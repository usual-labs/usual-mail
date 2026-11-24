// Reaching back into the mailbox for mail the server doesn't hold (docs/contract-search.md, "Older mail in the
// mailbox"): a person's search sent to each inbox's provider in its own query language, results never stored, and one
// conversation brought in when the person opens it, placed as the mailbox has it. Person only: an agent's token never
// makes the server query a mailbox on its own.

import {
  FILED_CATEGORIES,
  REMOTE_SEARCH_MAX,
  ServiceError,
  type Caller,
  type FiledCategory,
  type Id,
  type MailProvider,
  type ProviderSearchHit,
  type ProviderSearchQuery,
  type RemoteHit,
  type RemoteInboxState,
  type RemoteSearchResult,
  type SearchQuery,
  type ThreadDetail,
} from "@usualmail/core";
import { and, eq } from "drizzle-orm";
import { plainLine, snippetText } from "../ai/text.ts";
import { mayProcess } from "../ai/state.ts";
import { threads, type InboxRow } from "../db/index.ts";
import { inList } from "../db/params.ts";
import { attentionWords } from "../google/credentials.ts";
import { requireInbox, requirePerson } from "../service/access.ts";
import type { Ctx } from "../service/context.ts";
import { getInbox } from "../service/store.ts";
import { threadDetail } from "../service/views.ts";
import { ingest } from "../sync/ingest.ts";
import { base64url, errorMessage, fromBase64url, iso } from "../util.ts";
import { prepare } from "./local.ts";
import type { Parsed } from "./terms.ts";

/** A remote search's page: 10 results from each inbox unless asked otherwise. */
export const REMOTE_SEARCH_DEFAULT = 10;
/** Provider pages read at most per inbox and call, to fill a page with conversations the server doesn't hold. */
const PROVIDER_PAGES = 3;
/** Remote searches and openings a device may ask for in a minute, together. */
export const REMOTE_PER_MINUTE = 10;
const MINUTE = 60_000;

/** When each device last asked the mailbox, newest last. In memory: a restart forgets it. */
const asked = new WeakMap<Ctx, Map<string, number[]>>();

export async function searchRemote(ctx: Ctx, caller: Caller, input: SearchQuery): Promise<RemoteSearchResult> {
  requirePerson(caller, "search the mailbox itself");
  const { query, parsed, scope } = await prepare(ctx, caller, { ...input, limit: undefined });
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? REMOTE_SEARCH_DEFAULT)), REMOTE_SEARCH_MAX);
  if (!Number.isFinite(limit)) throw new ServiceError("invalid", "limit must be a whole number");
  const pages = query.cursor ? readCursor(query.cursor) : {};
  limitRate(ctx, caller);
  const wanted = providerQuery(parsed);
  const result: RemoteSearchResult = { items: [], understood: parsed.understood, inboxes: [] };
  const next: Record<string, string> = {};
  for (const inboxId of scope) {
    // A later page asks only the inboxes that had more.
    if (query.cursor && pages[inboxId] === undefined) continue;
    const inbox = await getInbox(ctx, inboxId);
    if (!inbox) continue;
    const answer = await searchInbox(ctx, inbox, wanted, limit, pages[inboxId]);
    result.inboxes.push(answer.state);
    result.items.push(...answer.hits);
    if (answer.next) next[inboxId] = answer.next;
  }
  result.items.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt) || (a.id < b.id ? 1 : -1));
  if (Object.keys(next).length) result.nextCursor = base64url(new TextEncoder().encode(JSON.stringify(next)));
  return result;
}

/** One inbox's page: up to `limit` conversations it doesn't hold, and its state. */
async function searchInbox(
  ctx: Ctx,
  inbox: InboxRow,
  query: ProviderSearchQuery,
  limit: number,
  page: string | undefined,
): Promise<{ state: RemoteInboxState; hits: RemoteHit[]; next?: string }> {
  if (inbox.paused) return { state: { inboxId: inbox.id, state: "paused", message: "This inbox is paused." }, hits: [] };
  let provider: MailProvider;
  try {
    provider = await ctx.hooks.provider(inbox.id);
  } catch (error) {
    return { state: refused(inbox, error), hits: [] };
  }
  if (!provider.search) {
    return { state: { inboxId: inbox.id, state: "unsupported", message: "This mailbox can't be searched from Usual Mail yet." }, hits: [] };
  }
  const hits: RemoteHit[] = [];
  let next = page;
  try {
    for (let round = 0; round < PROVIDER_PAGES && hits.length < limit; round++) {
      const answer = await provider.search(query, { limit, ...(next !== undefined && { page: next }) });
      hits.push(...await notHeld(ctx, inbox.id, answer.hits));
      next = answer.next;
      if (next === undefined) break;
    }
  } catch (error) {
    return { state: refused(inbox, error), hits: [] };
  }
  return { state: { inboxId: inbox.id, state: "ok" }, hits, ...(next !== undefined && { next }) };
}

/** The mailbox's own hits the server doesn't hold (a thread gone from the mailbox counts as not held), as results. */
async function notHeld(ctx: Ctx, inboxId: string, hits: ProviderSearchHit[]): Promise<RemoteHit[]> {
  if (!hits.length) return [];
  const held = new Set((await ctx.db.select({ key: threads.threadKey }).from(threads).where(and(
    eq(threads.inboxId, inboxId),
    eq(threads.removed, false),
    inList(threads.threadKey, hits.map((hit) => hit.threadKey)),
  ))).map((row) => row.key));
  return hits.filter((hit) => !held.has(hit.threadKey)).map((hit) => ({
    id: remoteId(inboxId, hit.threadKey),
    inboxId,
    subject: plainLine(hit.subject),
    from: { email: hit.from.email, ...(hit.from.name && { name: plainLine(hit.from.name) }) },
    lastMessageAt: iso(Date.parse(hit.date) || 0),
    snippet: snippetText(hit.snippet, null),
    hasAttachments: hit.hasAttachments,
    messageCount: hit.messageCount,
    archived: !hit.inInbox,
  }));
}

/**
 * Brings one remote result's conversation into the store, placed as the mailbox has it, and answers with it. Already
 * held: answered as it is. Nothing is written to the mailbox, and the sync's cursor and first-sync window are untouched.
 */
export async function openRemote(ctx: Ctx, caller: Caller, id: Id): Promise<ThreadDetail> {
  requirePerson(caller, "bring mail in from the mailbox");
  const { inboxId, threadKey } = readId(id);
  const inbox = await requireInbox(ctx, caller, inboxId);
  const held = async () => ctx.db.select({ id: threads.id }).from(threads)
    .where(and(eq(threads.inboxId, inbox.id), eq(threads.threadKey, threadKey), eq(threads.removed, false))).get();
  const known = await held();
  if (known) return threadDetail(ctx, caller, known.id);
  if (inbox.paused) throw new ServiceError("conflict", "This inbox is paused: resume it to bring mail in from its mailbox");
  limitRate(ctx, caller);
  let provider: MailProvider;
  let found;
  try {
    provider = await ctx.hooks.provider(inbox.id);
    if (!provider.fetchThread) throw new ServiceError("conflict", "This mailbox can't be searched from Usual Mail yet");
    found = await provider.fetchThread(threadKey);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError("provider_error", attentionWords(inbox, error));
  }
  if (!found.length) throw new ServiceError("not_found", "The mailbox no longer has this conversation");
  const threadId = await ctx.lock.run(async () => {
    const fresh = await getInbox(ctx, inbox.id);
    if (!fresh) throw new ServiceError("not_found", "No such inbox");
    const again = await held();
    if (again) return again.id;
    await ingest(ctx, fresh, { upserted: found, removed: [], cursor: fresh.syncCursor ?? "", more: false }, true, false, { imported: true });
    return (await held())?.id;
  });
  if (!threadId) throw new ServiceError("not_found", "The mailbox no longer has this conversation");
  // A conversation that isn't done is history for the AI, as any synced mail.
  if (await mayProcess(ctx)) ctx.aiQueue.wake();
  return threadDetail(ctx, caller, threadId);
}

/** The search as the provider takes it: categories only when every kind named has a label (conversation and unknown have none). */
export function providerQuery(parsed: Parsed): ProviderSearchQuery {
  const u = parsed.understood;
  const kinds = u.kinds ?? [];
  const filed = kinds.filter((kind): kind is FiledCategory => (FILED_CATEGORIES as readonly string[]).includes(kind));
  const unlabelled = kinds.includes("conversation") || kinds.includes("unknown");
  return {
    words: parsed.words,
    phrases: parsed.phrases,
    exclude: parsed.exclude,
    ...(u.from && { from: u.from }),
    ...(u.to && { to: u.to }),
    ...(u.subject && { subject: u.subject }),
    ...(u.hasAttachment !== undefined && { hasAttachment: u.hasAttachment }),
    ...(u.after && { after: u.after }),
    ...(u.before && { before: u.before }),
    ...(u.unread !== undefined && { unread: u.unread }),
    ...(filed.length && !unlabelled && { categories: filed }),
    ...(kinds.includes("screened") && { screened: true }),
    ...(kinds.includes("done") && { archived: true }),
  };
}

/** How an inbox's refusal reads: the sign-in Google refused, or the provider's words. */
function refused(inbox: InboxRow, error: unknown): RemoteInboxState {
  const signIn = error instanceof Error && error.name === "GoogleTokenError";
  return { inboxId: inbox.id, state: signIn ? "needs_sign_in" : "provider_error", message: signIn ? attentionWords(inbox, error) : errorMessage(error) };
}

/** At most `REMOTE_PER_MINUTE` remote searches and openings per device a minute; `rate_limited` beyond, with the wait. */
function limitRate(ctx: Ctx, caller: Caller): void {
  const device = caller.actor.kind === "person" ? caller.actor.deviceId : "-";
  let byDevice = asked.get(ctx);
  if (!byDevice) asked.set(ctx, byDevice = new Map());
  const now = ctx.now();
  const recent = (byDevice.get(device) ?? []).filter((at) => at > now - MINUTE);
  if (recent.length >= REMOTE_PER_MINUTE) {
    const retryAfter = Math.max(1, Math.ceil((recent[0]! + MINUTE - now) / 1000));
    throw new ServiceError("rate_limited", "Too many searches of the mailbox in a minute; try again shortly", { retryAfter });
  }
  recent.push(now);
  byDevice.set(device, recent);
}

/** A remote result's id: the same for the same mailbox conversation, whatever the search or page. */
export function remoteId(inboxId: string, threadKey: string): string {
  return `rem_${base64url(new TextEncoder().encode(JSON.stringify([inboxId, threadKey])))}`;
}

function readId(id: string): { inboxId: string; threadKey: string } {
  try {
    if (id.startsWith("rem_")) {
      const value = JSON.parse(new TextDecoder().decode(fromBase64url(id.slice(4)))) as unknown;
      if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "string" && part)) {
        return { inboxId: value[0] as string, threadKey: value[1] as string };
      }
    }
  } catch {
    // Not one a search gave out.
  }
  throw new ServiceError("not_found", "No such result");
}

function readCursor(text: string): Record<string, string> {
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64url(text))) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)
      && Object.values(value).every((page) => typeof page === "string")) return value as Record<string, string>;
  } catch {
    // Not one this search gave out.
  }
  throw new ServiceError("invalid", "This cursor isn't one this search gave out");
}
