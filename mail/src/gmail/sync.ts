/**
 * Gmail sync. The first call takes the history id, lists the message ids in the window (`since`) and sends
 * them newest first, `limit` at a time; then history from that id brings every later change. A new message
 * is fetched whole; a label change on a known one is sent as `changed` from the labels history reports, so
 * nothing is fetched again. A message that leaves spam is fetched whole too, since the server ignored it there.
 *
 * When Gmail answers 404 because the history id is too old, the provider has lost its place. It lists the
 * whole window again and says `reset`: messages that arrived from a little before the last good sync are
 * fetched whole, older ones are sent as `changed` with their labels read from one listing per label. What
 * the listing leaves out is gone, and the server drops it.
 */
import type { ProviderChange, ProviderMessage, SyncBatch, SyncProgress } from "@usualmail/core";
import { GmailApiError, type GmailClient } from "./client.ts";
import { decodeEntry, decodeGmailCursor, encodeEntry, encodeGmailCursor, type GmailCursor } from "./cursor.ts";
import { placementFromBits, placementFromLabels, seenFromBits, STATE_BITS, STATE_KEYS, stateBits, stateLabelIds, type LabelBook } from "./labels.ts";
import { COST, type Clock } from "./limits.ts";
import { fetchLabelIds, fetchMessages, isSkipped, type ConvertContext, type MessageLimits } from "./messages.ts";
import type { AuthenticationOptions } from "../message/auth-results.ts";

export const DEFAULT_GMAIL_LIMIT = 50;
const PAGE_SIZE = 500;
const HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"];

export interface GmailSyncContext {
  labels: LabelBook;
  ownAddresses: () => Promise<readonly string[]>;
  since?: string;
  clock: Clock;
  /** A reset fetches whole the messages that arrived from this long before the last good sync on. */
  resyncWindowMs: number;
  /** Gmail's checker and the organisational-domain rule, when the server asked for `fromCheck`. */
  authentication?: AuthenticationOptions;
  /** How much of the mailbox is held at once while messages are fetched (messages.ts). */
  limits: MessageLimits;
  /** `SyncOptions.onProgress`: how far a first sync has got, once its window is listed and after each message. */
  onProgress?: (progress: SyncProgress) => void;
}

interface HistoryMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
}

interface HistoryRecord {
  id: string;
  messagesAdded?: { message: HistoryMessage }[];
  messagesDeleted?: { message: HistoryMessage }[];
  labelsAdded?: { message: HistoryMessage; labelIds?: string[] }[];
  labelsRemoved?: { message: HistoryMessage; labelIds?: string[] }[];
}

interface HistoryPage {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId: string;
}

export async function syncGmail(client: GmailClient, cursorText: string | null, limit: number, context: GmailSyncContext): Promise<SyncBatch> {
  context.labels.reset();
  if (!cursorText) return firstSync(client, limit, context);
  let cursor = decodeGmailCursor(cursorText);
  if (cursor.f && cursor.p?.length) cursor = await narrowFirstSync(client, cursor, context);
  if (cursor.p?.length || cursor.c?.length) return drain(client, cursor, limit, context, false);
  if (cursor.f) {
    // A smaller window left nothing of the first sync's listing to send, so all of it is sent. Its marks go, so ids
    // history carries later are never narrowed as if they were the listing.
    const sent = cursor.n ?? 0;
    const { f: _f, w: _w, n: _n, ...rest } = cursor;
    const batch = await incremental(client, rest, limit, context);
    return { ...batch, progress: { sent, total: sent } };
  }
  return incremental(client, cursor, limit, context);
}

async function firstSync(client: GmailClient, limit: number, context: GmailSyncContext): Promise<SyncBatch> {
  const since = context.since ? new Date(context.since).toISOString() : undefined;
  const profile = await client.request<{ historyId: string }>("GET", "/profile", { cost: COST.getProfile });
  const ids = await listIds(client, since === undefined ? undefined : Date.parse(since));
  const cursor: GmailCursor = { v: 1, h: profile.historyId, t: context.clock.now() };
  if (since) cursor.s = since;
  if (ids.length) {
    cursor.p = ids;
    cursor.f = true;
    cursor.n = 0;
  }
  // Listing a large window takes a while; the count starts once it is done.
  context.onProgress?.({ sent: 0, total: ids.length });
  const batch = await drain(client, cursor, limit, context, false);
  return ids.length ? batch : { ...batch, progress: { sent: 0, total: 0 } };
}

/**
 * The window was made smaller while the first sync was still being sent (the provider is opened with a later
 * `since` than the window so far): the ids still to send that are older than it are left out, read from one listing
 * of the new window, so they are never fetched. What was sent stays, and `s` keeps the window the first sync began
 * with, so a listing after history is lost still covers it. A larger window changes nothing: the first sync never
 * widens. Only the first sync's own listing (`f`) is narrowed, never ids carried from history, which are new mail.
 */
async function narrowFirstSync(client: GmailClient, cursor: GmailCursor, context: GmailSyncContext): Promise<GmailCursor> {
  if (!context.since) return cursor;
  const since = Date.parse(context.since);
  const window = cursor.w ?? cursor.s;
  if (Number.isNaN(since) || (window !== undefined && since <= Date.parse(window))) return cursor;
  const inside = new Set(await listIds(client, since));
  const narrowed: GmailCursor = { ...cursor, w: new Date(since).toISOString() };
  const keep = (cursor.p ?? []).filter((id) => inside.has(id));
  if (keep.length) narrowed.p = keep;
  else delete narrowed.p;
  return narrowed;
}

/** Message ids newest first, as Gmail lists them. Drafts and chats are left out; spam and trash are in. */
async function listIds(client: GmailClient, afterMs: number | undefined, labelId?: string): Promise<string[]> {
  const terms = ["-in:drafts", "-in:chats"];
  if (afterMs !== undefined && Number.isFinite(afterMs)) terms.push(`after:${Math.floor(afterMs / 1000)}`);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.request<{ messages?: { id: string }[]; nextPageToken?: string }>("GET", "/messages", {
      cost: COST.messagesList,
      query: { q: terms.join(" "), maxResults: PAGE_SIZE, includeSpamTrash: true, pageToken, labelIds: labelId },
    });
    for (const message of page.messages ?? []) ids.push(message.id);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

/**
 * Sends the next part of a listing: whole messages first, then the ones that go as `changed`. The first sync's own
 * listing (`f`) is counted: `n` sent so far, of `n` and what is left to send.
 */
async function drain(client: GmailClient, cursor: GmailCursor, limit: number, context: GmailSyncContext, reset: boolean): Promise<SyncBatch> {
  const whole = cursor.p ?? [];
  const listed = cursor.c ?? [];
  const take = whole.slice(0, limit);
  const takeListed = listed.slice(0, Math.max(0, limit - take.length));
  const counting = cursor.f === true;
  const sentBefore = cursor.n ?? 0;
  const total = sentBefore + whole.length;
  let fetched = 0;
  const report = context.onProgress;
  const onFetched = counting && report ? () => report({ sent: sentBefore + ++fetched, total }) : undefined;
  const { messages } = await fetchMessages(client, take, await convertContext(context), undefined, onFetched);
  const changed = takeListed.map((entry): ProviderChange => {
    const { id, bits } = decodeEntry(entry);
    return { ref: id, seen: seenFromBits(bits), placement: placementFromBits(bits) };
  });
  const next: GmailCursor = { ...cursor };
  const restWhole = whole.slice(take.length);
  const restListed = listed.slice(takeListed.length);
  if (restWhole.length) next.p = restWhole;
  else delete next.p;
  if (restListed.length) next.c = restListed;
  else delete next.c;
  if (counting) next.n = sentBefore + take.length;
  if (!restWhole.length) {
    // The first sync's listing is sent: nothing is left for a smaller window to narrow, or to count.
    delete next.f;
    delete next.w;
    delete next.n;
  }
  const batch: SyncBatch = {
    upserted: newestFirst(messages),
    changed,
    removed: [],
    cursor: encodeGmailCursor(next),
    more: restWhole.length + restListed.length > 0,
  };
  if (reset) batch.reset = true;
  if (counting) batch.progress = { sent: sentBefore + take.length, total };
  return batch;
}

async function incremental(client: GmailClient, cursor: GmailCursor, limit: number, context: GmailSyncContext): Promise<SyncBatch> {
  const upserts = new Set<string>();
  /** Known messages whose labels changed, with their labels as history last gave them. */
  const changes = new Map<string, string[] | undefined>();
  const removed = new Set<string>();
  let lastRecord = cursor.h;
  let pageToken: string | undefined;
  let finished = false;
  let latest = cursor.h;
  outer: for (;;) {
    let page: HistoryPage;
    try {
      page = await client.request<HistoryPage>("GET", "/history", {
        cost: COST.historyList,
        query: { startHistoryId: cursor.h, maxResults: PAGE_SIZE, historyTypes: HISTORY_TYPES, pageToken },
      });
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) return relistAfterLosingPlace(client, cursor, limit, context);
      throw error;
    }
    for (const record of page.history ?? []) {
      const touched = recordChanges(record);
      const entries = upserts.size + changes.size;
      const fresh = new Set([...touched.added, ...touched.labelled.map((l) => l.id)].filter((id) => !upserts.has(id) && !changes.has(id))).size;
      // Stop between records once the batch is full, so the next call starts exactly after the last one sent.
      if (entries > 0 && entries + fresh > limit) break outer;
      for (const id of touched.added) {
        if (removed.has(id)) continue;
        upserts.add(id);
        changes.delete(id);
      }
      for (const { id, labelIds } of touched.labelled) {
        if (removed.has(id) || upserts.has(id)) continue;
        changes.set(id, labelIds);
      }
      for (const id of touched.deleted) {
        upserts.delete(id);
        changes.delete(id);
        removed.add(id);
      }
      lastRecord = record.id;
    }
    if (!page.nextPageToken) {
      finished = true;
      latest = page.historyId;
      break;
    }
    pageToken = page.nextPageToken;
  }

  const convert = await convertContext(context);
  // One history record can name more messages than `limit` (a bulk change made elsewhere). What doesn't fit is
  // carried in the cursor and sent by the next calls, before history goes on, so no batch passes the limit.
  const carryWhole: string[] = [];
  const carryChanged: string[] = [];
  const sendWhole = [...upserts].slice(0, limit);
  carryWhole.push(...[...upserts].slice(limit));
  for (const [id, labelIds] of [...changes].slice(Math.max(0, limit - sendWhole.length))) {
    changes.delete(id);
    if (labelIds === undefined) carryWhole.push(id);
    else if (!isSkipped(labelIds)) carryChanged.push(encodeEntry(id, stateBits(labelIds, convert.labelIds)));
  }
  const { messages, missing } = await fetchMessages(client, sendWhole, convert);
  for (const id of missing) removed.add(id);
  // History normally carries each message's labels; ask Gmail only for those it left out.
  const unlabelled = [...changes].filter(([, labelIds]) => labelIds === undefined).map(([id]) => id);
  const looked = unlabelled.length ? await fetchLabelIds(client, unlabelled) : new Map<string, string[] | undefined>();
  const changed: ProviderChange[] = [];
  for (const [id, fromHistory] of changes) {
    const labelIds = fromHistory ?? looked.get(id);
    if (!labelIds) {
      removed.add(id);
      continue;
    }
    if (isSkipped(labelIds)) continue;
    changed.push({ ref: id, seen: !labelIds.includes("UNREAD"), placement: placementFromLabels(labelIds, convert.labelIds) });
  }
  const next: GmailCursor = { ...cursor, h: finished ? latest : lastRecord, t: context.clock.now() };
  if (carryWhole.length) next.p = carryWhole;
  if (carryChanged.length) next.c = carryChanged;
  const carried = carryWhole.length + carryChanged.length > 0;
  return { upserted: newestFirst(messages), changed, removed: [...removed], cursor: encodeGmailCursor(next), more: !finished || carried };
}

/**
 * What one history record says. A message that left spam (`SPAM` among the labels removed) counts as added, so it is
 * sent whole: the server ignored it while it was in spam and doesn't hold it, so it would drop a `changed` entry.
 */
function recordChanges(record: HistoryRecord): { added: string[]; labelled: { id: string; labelIds?: string[] }[]; deleted: string[] } {
  const added: string[] = [];
  for (const { message } of record.messagesAdded ?? []) if (!isSkipped(message.labelIds)) added.push(message.id);
  for (const { message, labelIds } of record.labelsRemoved ?? []) {
    if (labelIds?.includes("SPAM") && !isSkipped(message.labelIds)) added.push(message.id);
  }
  const labelled: { id: string; labelIds?: string[] }[] = [];
  for (const { message } of [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])]) {
    if (message.labelIds && isSkipped(message.labelIds)) continue;
    labelled.push(message.labelIds ? { id: message.id, labelIds: message.labelIds } : { id: message.id });
  }
  const deleted = (record.messagesDeleted ?? []).map(({ message }) => message.id);
  return { added: [...new Set(added)], labelled, deleted };
}

/**
 * Gmail no longer has history from the cursor's id. Lists the whole window again from a fresh history id:
 * what arrived from `resyncWindowMs` before the last good sync on is sent whole, since the server may not
 * have it; everything older is sent as `changed`, its labels read from one listing per label. The first
 * batch says `reset`, so the server drops what the listing leaves out once it ends.
 */
async function relistAfterLosingPlace(client: GmailClient, cursor: GmailCursor, limit: number, context: GmailSyncContext): Promise<SyncBatch> {
  const profile = await client.request<{ historyId: string }>("GET", "/profile", { cost: COST.getProfile });
  const now = context.clock.now();
  const windowStart = cursor.s ? Date.parse(cursor.s) : undefined;
  const recentStart = Math.max(windowStart ?? -Infinity, (cursor.t ?? now) - context.resyncWindowMs);
  const all = await listIds(client, windowStart);
  const recent = await listIds(client, recentStart);
  const recentSet = new Set(recent);
  const older = all.filter((id) => !recentSet.has(id));
  const entries: string[] = [];
  if (older.length) {
    const wanted = new Set(older);
    const bits = new Map<string, number>();
    const byKey = stateLabelIds(await context.labels.ids());
    for (const key of STATE_KEYS) {
      const labelId = byKey[key];
      if (labelId === undefined) continue;
      for (const id of await listIds(client, windowStart, labelId)) {
        if (wanted.has(id)) bits.set(id, (bits.get(id) ?? 0) | STATE_BITS[key]);
      }
    }
    for (const id of older) entries.push(encodeEntry(id, bits.get(id) ?? 0));
  }
  const next: GmailCursor = { v: 1, h: profile.historyId, t: now };
  if (cursor.s) next.s = cursor.s;
  if (recent.length) next.p = recent;
  if (entries.length) next.c = entries;
  return drain(client, next, limit, context, true);
}

async function convertContext(context: GmailSyncContext): Promise<ConvertContext> {
  return {
    ownAddresses: await context.ownAddresses(),
    labelIds: await context.labels.ids(),
    limits: context.limits,
    ...(context.authentication && { authentication: context.authentication }),
  };
}

function newestFirst(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.sort((a, b) => b.date.localeCompare(a.date));
}
