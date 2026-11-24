// Drafts: anyone with access to an inbox may write them; an agent may change or delete only drafts an agent
// wrote; only a person may send. A sent draft with a provider's note is kept for a day so the note can be shown;
// one without a note is removed once sent.

import { ServiceError, type Caller, type Draft, type DraftInput, type ListQuery, type OutgoingMessage, type Page } from "@usualmail/core";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { drafts, messages, sentMessageIds, type DraftRow } from "../db/index.ts";
import { inList } from "../db/params.ts";
import { decodeCursor, encodeCursor, errorMessage, pageLimit, withoutNul } from "../util.ts";
import { isPerson, listScope, mayRead, requireInbox, requirePerson } from "./access.ts";
import type { Ctx } from "./context.ts";
import { publishedSecond, toDraft, wholeSecond } from "./rows.ts";
import { check, DraftInputSchema, ListQuerySchema } from "./schemas.ts";
import { assertNotPaused } from "./inboxes.ts";
import { getInbox, getThread, markKnown } from "./store.ts";

/** How long a sent draft with a note is kept, so its thread can show the note. */
export const SENT_NOTE_KEPT_MS = 24 * 60 * 60_000;

/** Drafts and failed sends, newest first by the whole second of `updatedAt`, equal times by id, descending. */
export async function listDrafts(ctx: Ctx, caller: Caller, input: ListQuery): Promise<Page<Draft>> {
  const query = check(ListQuerySchema, input, "Query");
  const scope = await listScope(ctx, caller, query.inboxId);
  if (scope.length === 0) return { items: [] };
  const limit = pageLimit(query.limit);
  const after = query.cursor ? decodeCursor(query.cursor) : undefined;
  const second = publishedSecond(drafts.updatedAt);
  const rows = await ctx.db.select().from(drafts).where(and(
    inList(drafts.inboxId, scope),
    inArray(drafts.state, ["draft", "failed"]),
    after && sql`(${second} < ${after.at} OR (${second} = ${after.at} AND ${drafts.id} < ${String(after.tie)}))`,
  )).orderBy(desc(second), desc(drafts.id)).limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return rows.length > limit && last
    ? { items: items.map(toDraft), nextCursor: encodeCursor({ at: wholeSecond(last.updatedAt), tie: last.id }) }
    : { items: items.map(toDraft) };
}

async function requireDraft(ctx: Ctx, caller: Caller, id: string): Promise<DraftRow> {
  const row = await ctx.db.select().from(drafts).where(eq(drafts.id, id)).get();
  const inbox = row && await getInbox(ctx, row.inboxId);
  if (!row || !inbox || !mayRead(caller, inbox)) throw new ServiceError("not_found", "No such draft");
  return row;
}

/** An agent may change or delete only a draft an agent wrote; a person any. */
function assertMayChange(caller: Caller, row: DraftRow, doing: string): void {
  if (isPerson(caller) || row.createdBy.kind === "agent") return;
  throw new ServiceError("needs_person", `Only a person can ${doing} a draft a person wrote`);
}

export async function saveDraft(ctx: Ctx, caller: Caller, input: DraftInput): Promise<Draft> {
  const data = check(DraftInputSchema, input, "Draft");
  await requireInbox(ctx, caller, data.inboxId);
  if (data.threadId) {
    const thread = await getThread(ctx, data.threadId);
    if (!thread || thread.inboxId !== data.inboxId) throw new ServiceError("invalid", "threadId isn't a thread in this inbox");
  }
  if (data.inReplyToMessageId) {
    const message = await ctx.db.select({ threadId: messages.threadId }).from(messages)
      .where(eq(messages.id, data.inReplyToMessageId)).get();
    if (!message || message.threadId !== data.threadId) {
      throw new ServiceError("invalid", "inReplyToMessageId must be a message in the draft's thread");
    }
  }
  const fields = {
    threadId: data.threadId ?? null,
    inReplyToMessageId: data.inReplyToMessageId ?? null,
    to: data.to,
    cc: data.cc ?? [],
    bcc: data.bcc ?? [],
    // Without U+0000: SQLite would keep only what comes before it.
    subject: withoutNul(data.subject),
    body: withoutNul(data.body),
    updatedAt: ctx.now(),
  };
  let row: DraftRow;
  if (data.id) {
    const existing = await requireDraft(ctx, caller, data.id);
    assertMayChange(caller, existing, "change");
    if (existing.inboxId !== data.inboxId) throw new ServiceError("invalid", "A draft can't move to another inbox");
    if (existing.state === "sending" || existing.state === "sent") {
      throw new ServiceError("conflict", `This draft is ${existing.state} and can't be changed`);
    }
    row = { ...existing, ...fields, state: "draft", error: null, note: null, version: existing.version + 1 };
    await ctx.db.update(drafts).set({ ...fields, state: "draft", error: null, note: null, version: row.version }).where(eq(drafts.id, data.id));
  } else {
    row = {
      id: ctx.id("drf"),
      inboxId: data.inboxId,
      ...fields,
      createdBy: caller.actor,
      state: "draft",
      error: null,
      note: null,
      createdAt: ctx.now(),
      version: 1,
    };
    await ctx.db.insert(drafts).values(row);
  }
  const draft = toDraft(row);
  ctx.emit({ type: "draft.changed", draft });
  return draft;
}

export async function deleteDraft(ctx: Ctx, caller: Caller, id: string): Promise<void> {
  const row = await requireDraft(ctx, caller, id);
  assertMayChange(caller, row, "delete");
  if (row.state === "sending") throw new ServiceError("conflict", "This draft is being sent");
  await ctx.db.delete(drafts).where(eq(drafts.id, id));
  ctx.emit({ type: "draft.removed", draftId: id, inboxId: row.inboxId });
}

/** Marks the draft `sending` and builds what the provider sends. Under the lock. */
export async function startSending(ctx: Ctx, caller: Caller, id: string): Promise<{ draft: DraftRow; message: OutgoingMessage }> {
  requirePerson(caller, "send mail");
  const row = await requireDraft(ctx, caller, id);
  if (row.state !== "draft" && row.state !== "failed") throw new ServiceError("conflict", `This draft is already ${row.state}`);
  if (row.to.length + row.cc.length + row.bcc.length === 0) throw new ServiceError("invalid", "A draft needs at least one recipient");
  const inbox = await requireInbox(ctx, caller, row.inboxId);
  assertNotPaused(inbox, "send mail");
  const message: OutgoingMessage = {
    from: { name: inbox.name, email: inbox.address },
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    text: row.body,
  };
  if (row.inReplyToMessageId) {
    const parent = await ctx.db.select().from(messages).where(eq(messages.id, row.inReplyToMessageId)).get();
    if (parent?.messageId) {
      message.inReplyTo = parent.messageId;
      message.references = [...parent.references, parent.messageId];
    }
  }
  // A reply names its conversation, so the provider needn't search for it.
  const thread = row.threadId ? await getThread(ctx, row.threadId) : undefined;
  if (thread) message.threadKey = thread.threadKey;
  const sending: DraftRow = { ...row, state: "sending", error: null, note: null, updatedAt: ctx.now(), version: row.version + 1 };
  await ctx.db.update(drafts).set({ state: "sending", error: null, note: null, updatedAt: sending.updatedAt, version: sending.version })
    .where(eq(drafts.id, id));
  ctx.emit({ type: "draft.changed", draft: toDraft(sending) });
  return { draft: sending, message };
}

/**
 * Records how sending went: `sent`, with the provider's note if it gave one, or `failed` with the error. A sent
 * draft with a note is kept for a day; one without is removed at once, after `draft.changed` says it was sent.
 * Under the lock.
 */
export async function finishSending(ctx: Ctx, draft: DraftRow, outcome: { error: unknown } | { note?: string; sentKey?: string }): Promise<Draft> {
  const version = draft.version + 1;
  const done: DraftRow = "error" in outcome
    ? { ...draft, state: "failed", error: errorMessage(outcome.error ?? "Sending failed"), note: null, updatedAt: ctx.now(), version }
    : { ...draft, state: "sent", error: null, note: outcome.note ?? null, updatedAt: ctx.now(), version };
  if (done.state === "sent" && done.note === null) {
    await ctx.db.delete(drafts).where(eq(drafts.id, draft.id));
  } else {
    await ctx.db.update(drafts).set({ state: done.state, error: done.error, note: done.note, updatedAt: done.updatedAt, version })
      .where(eq(drafts.id, draft.id));
  }
  if (done.state === "sent" && "sentKey" in outcome && outcome.sentKey) {
    // A copy of exactly this that comes back without the provider's evidence is still the inbox's own (sync/ingest.ts).
    await ctx.db.insert(sentMessageIds).values({ inboxId: draft.inboxId, messageId: outcome.sentKey, sentAt: ctx.now() })
      .onConflictDoNothing();
  }
  if (done.state === "sent") {
    // The inbox wrote to them: they are let in, and their screened threads go where they belong.
    const unscreened = await markKnown(ctx, draft.inboxId, [...draft.to, ...draft.cc, ...draft.bcc].map((a) => a.email));
    if (unscreened.length) ctx.hooks.writeBack({ inboxId: draft.inboxId, threadIds: unscreened, recordIds: [] });
  }
  const result = toDraft(done);
  ctx.emit({ type: "draft.changed", draft: result });
  if (done.state === "sent" && done.note === null) ctx.emit({ type: "draft.removed", draftId: draft.id, inboxId: draft.inboxId });
  if (done.note !== null) ctx.hooks.timersChanged();
  return result;
}

/** How long the server remembers the Message-IDs it sent: copies come back within minutes. */
const SENT_IDS_KEPT_MS = 90 * 24 * 60 * 60_000;

/** At start: forgets Message-IDs sent more than 90 days ago. Under the lock. */
export async function pruneSentIds(ctx: Ctx): Promise<void> {
  await ctx.db.delete(sentMessageIds).where(lte(sentMessageIds.sentAt, ctx.now() - SENT_IDS_KEPT_MS));
}

/**
 * Whether the server itself sent exactly this from this inbox: `key` is the Message-ID with a hash of what was sent
 * (`sentKey` in sync/identity.ts). Rows written before the hash was added hold the Message-ID alone and match nothing.
 */
export async function sentByServer(ctx: Ctx, inboxId: string, key: string): Promise<boolean> {
  const row = await ctx.db.select({ id: sentMessageIds.messageId }).from(sentMessageIds)
    .where(and(eq(sentMessageIds.inboxId, inboxId), eq(sentMessageIds.messageId, key))).get();
  return row !== undefined;
}

/** The error a draft left `sending` by a stop carries once it has failed at the next start. */
export const STOPPED_WHILE_SENDING =
  "The server stopped while sending this draft, so it may have gone out. Check the Sent folder before sending it again.";

/**
 * At start: a draft still `sending` was being sent when the server stopped, and nobody knows whether it went out. It
 * becomes `failed` with an error that says so, and can then be changed, deleted or sent again like any failed draft.
 * Each sends `draft.changed`. Under the lock.
 */
export async function failStoppedSends(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.select().from(drafts).where(eq(drafts.state, "sending"));
  for (const row of rows) {
    const failed: DraftRow = { ...row, state: "failed", error: STOPPED_WHILE_SENDING, note: null, updatedAt: ctx.now(), version: row.version + 1 };
    await ctx.db.update(drafts)
      .set({ state: "failed", error: failed.error, note: null, updatedAt: failed.updatedAt, version: failed.version })
      .where(eq(drafts.id, row.id));
    ctx.emit({ type: "draft.changed", draft: toDraft(failed) });
  }
}

/** Whether a sent draft is still kept: it carries a note and was sent less than a day ago. */
export function keptSent(ctx: Ctx) {
  return and(eq(drafts.state, "sent"), isNotNull(drafts.note), sql`${drafts.updatedAt} > ${ctx.now() - SENT_NOTE_KEPT_MS}`);
}

/**
 * Removes sent drafts that are no longer kept: those whose day has passed, and any without a note (from a store
 * before the fourth revision kept every sent draft). Each sends `draft.removed`. Under the lock.
 */
export async function expireSentDrafts(ctx: Ctx): Promise<void> {
  const gone = await ctx.db.select({ id: drafts.id, inboxId: drafts.inboxId }).from(drafts).where(and(
    eq(drafts.state, "sent"),
    or(isNull(drafts.note), lte(drafts.updatedAt, ctx.now() - SENT_NOTE_KEPT_MS)),
  ));
  if (gone.length === 0) return;
  await ctx.db.delete(drafts).where(inList(drafts.id, gone.map((row) => row.id)));
  for (const row of gone) ctx.emit({ type: "draft.removed", draftId: row.id, inboxId: row.inboxId });
}

/** When the next kept sent draft is due to go, if any. */
export async function nextSentExpiry(ctx: Ctx): Promise<number | null> {
  const row = await ctx.db.select({ at: drafts.updatedAt }).from(drafts)
    .where(and(eq(drafts.state, "sent"), isNotNull(drafts.note))).orderBy(asc(drafts.updatedAt)).limit(1).get();
  return row ? row.at + SENT_NOTE_KEPT_MS : null;
}
