// Store helpers shared by the service and the sync engine. Callers hold `ctx.lock` when they write.

import { and, asc, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { PAYMENT_CATEGORIES, type Address, type Category } from "@usualmail/core";
import type { SenderStatus } from "../db/index.ts";
import { actions, inboxes, messages, senders, threads, type ActionRow, type InboxRow, type ThreadRow } from "../db/index.ts";
import { inList, insertChunks } from "../db/params.ts";
import type { Ctx } from "./context.ts";
import { settleSenders, settleThreadAvatars } from "../avatars/settle.ts";
import { retireUndo } from "./records.ts";
import { toThread } from "./rows.ts";
import { stateColumns, stateOf, type ThreadState } from "./state.ts";

/** Runs statements together, all or nothing. */
export async function runBatch(ctx: Ctx, statements: BatchItem<"sqlite">[]): Promise<void> {
  if (statements.length === 0) return;
  await ctx.db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

export async function getInbox(ctx: Ctx, id: string): Promise<InboxRow | undefined> {
  return ctx.db.select().from(inboxes).where(eq(inboxes.id, id)).get();
}

export async function getThread(ctx: Ctx, id: string): Promise<ThreadRow | undefined> {
  return ctx.db.select().from(threads).where(eq(threads.id, id)).get();
}

export async function requireThreadRow(ctx: Ctx, id: string): Promise<ThreadRow> {
  const row = await getThread(ctx, id);
  if (!row) throw new Error(`Thread ${id} vanished while it was being changed`);
  return row;
}

export async function getRecord(ctx: Ctx, id: string): Promise<ActionRow | undefined> {
  return ctx.db.select().from(actions).where(eq(actions.id, id)).get();
}

/**
 * Whether a person sees a message of a thread whose sender is `sender`: every message but what a blocked sender wrote
 * into someone else's thread, which changes nothing a person sees (docs/contract-sync.md, "Sync"). A thread a blocked
 * sender started still shows their messages; it is done, in no list but search.
 */
export function shownIn(sender: string | null, blocked: Set<string>): (message: { outgoing: boolean; from: Address }) => boolean {
  return (message) => {
    if (message.outgoing) return true;
    const from = message.from.email.toLowerCase();
    return from === sender || !blocked.has(from);
  };
}

/** The thread's messages a person sees, oldest first, with what state needs. */
export async function messageFlags(ctx: Ctx, row: Pick<ThreadRow, "id" | "inboxId" | "sender">) {
  const list = await ctx.db.select({ id: messages.id, unread: messages.unread, outgoing: messages.outgoing, from: messages.from })
    .from(messages).where(eq(messages.threadId, row.id)).orderBy(asc(messages.date), asc(messages.id));
  return list.filter(shownIn(row.sender, await blockedSenders(ctx, row.inboxId)));
}

export async function threadState(ctx: Ctx, row: ThreadRow): Promise<ThreadState> {
  return stateOf(row, await messageFlags(ctx, row));
}

/** The newest incoming message a person sees, or the newest at all: what `unread` marks. */
export async function newestMessageId(ctx: Ctx, row: Pick<ThreadRow, "id" | "inboxId" | "sender">): Promise<string | null> {
  const flags = await messageFlags(ctx, row);
  const incoming = flags.filter((m) => !m.outgoing);
  return (incoming.at(-1) ?? flags.at(-1))?.id ?? null;
}

/**
 * Writes a state to a thread and its messages' unread flags. When that changes anything, the thread's version
 * goes up by one; its revision goes up only when where it is changes: its category, screened, done, stack, come-back
 * time or trash. A one-time code needs no summary, and a thread no longer screened no longer waits at the gate.
 * Returns the thread as it is now; the caller sends the event.
 */
export async function saveThreadState(ctx: Ctx, threadId: string, state: ThreadState): Promise<ThreadRow> {
  const row = await requireThreadRow(ctx, threadId);
  const columns = stateColumns(state);
  const unreadNow = new Set((await ctx.db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.unread, true)))).map((m) => m.id));
  const flagsChange = state.unreadMessageIds.some((id) => !unreadNow.has(id))
    || state.readMessageIds.some((id) => unreadNow.has(id));
  const columnsChange = (Object.keys(columns) as Array<keyof typeof columns>)
    .some((key) => JSON.stringify(row[key] ?? null) !== JSON.stringify(columns[key] ?? null));
  if (!flagsChange && !columnsChange) return row;
  // A new come-back time is announced when it passes; one that has passed already (an undo putting it back)
  // needs no announcement, since this change sends the thread anyway.
  const announced = state.comeBackAt !== row.comeBackAt
    ? { comeBackAnnounced: state.comeBackAt !== null && state.comeBackAt <= ctx.now() }
    : {};
  // Undoing an allow or a block counts a thread as changed since only when where it is changed (docs/contract.md).
  const moved = (["category", "screened", "done", "stack", "comeBackAt", "comeBackIfNoReply", "trashed"] as const)
    .some((key) => row[key] !== columns[key]);
  // A receipt's or an invoice's details go when its category changes (from a receipt to an invoice too: a refund
  // only makes sense on a receipt, so they are asked again), and when it leaves those categories a summary is due in
  // their place; a thread that has none and is a receipt or an invoice needs them. Either way the queue looks again.
  const leaving = isPayment(row.category) && !isPayment(state.category);
  const entering = isPayment(state.category) && row.category !== state.category;
  // A notification's event likewise, with the key that joins it to others: gone when it leaves `notification` (a summary
  // is due), none when it enters.
  const leavingNotice = row.category === "notification" && state.category !== "notification";
  const enteringNotice = state.category === "notification" && row.category !== "notification";
  await runBatch(ctx, [
    ctx.db.update(threads).set({
      ...columns,
      ...announced,
      ...(row.gatePending && !state.screened && { gatePending: false }),
      ...((leaving || entering) && { payment: null }),
      ...((leavingNotice || enteringNotice) && { event: null, eventKey: null }),
      ...((leaving || leavingNotice) && { summaryDue: true }),
      ...(state.category === "otp" && { summaryDue: false }),
      version: sql`${threads.version} + 1`,
      ...(moved && { revision: sql`${threads.revision} + 1` }),
    }).where(eq(threads.id, threadId)),
    ...(state.unreadMessageIds.length
      ? [ctx.db.update(messages).set({ unread: true }).where(inList(messages.id, state.unreadMessageIds))]
      : []),
    ...(state.readMessageIds.length
      ? [ctx.db.update(messages).set({ unread: false }).where(inList(messages.id, state.readMessageIds))]
      : []),
  ]);
  if (leaving || entering || leavingNotice || enteringNotice) ctx.aiQueue.wake();
  // Its sender picture follows its category and screening; a change raises the version once more.
  await settleThreadAvatars(ctx, [threadId]);
  return requireThreadRow(ctx, threadId);
}

/** A receipt or an invoice: its summary is its payment details. */
function isPayment(category: Category): boolean {
  return (PAYMENT_CATEGORIES as readonly Category[]).includes(category);
}

/**
 * A come-back time passed: only the version rises (not the revision, so it ends no undo), and the time is marked
 * announced. Clients that keep the higher version then take the thread again.
 */
export async function announceComeBack(ctx: Ctx, threadId: string): Promise<ThreadRow> {
  await ctx.db.update(threads).set({ version: sql`${threads.version} + 1`, comeBackAnnounced: true }).where(eq(threads.id, threadId));
  return requireThreadRow(ctx, threadId);
}

/** `thread.removed` for a thread that no longer exists at the provider; `thread.changed` otherwise, trashed too. */
export function emitThread(ctx: Ctx, row: ThreadRow): void {
  if (row.removed) ctx.emit({ type: "thread.removed", threadId: row.id, inboxId: row.inboxId });
  else ctx.emit({ type: "thread.changed", thread: toThread(row) });
}

/** The addresses blocked in an inbox, lower case. */
export async function blockedSenders(ctx: Ctx, inboxId: string): Promise<Set<string>> {
  const rows = await ctx.db.select({ email: senders.email }).from(senders)
    .where(and(eq(senders.inboxId, inboxId), eq(senders.status, "blocked")));
  return new Set(rows.map((row) => row.email));
}

/**
 * Whether the thread is out of Screening only because the server's own check let it skip it (`skippedScreening`) and
 * its sender still isn't let in. Mail written into it lets nobody in, and the AI never moves it to `conversation`.
 */
export async function skippedWhileUnknown(ctx: Ctx, row: ThreadRow): Promise<boolean> {
  if (row.screened || !row.skippedScreening) return false;
  return !row.sender || await senderStatus(ctx, row.inboxId, row.sender) !== "known";
}

export async function senderStatus(ctx: Ctx, inboxId: string, email: string): Promise<SenderStatus | null> {
  return (await senderRow(ctx, inboxId, email)).status;
}

/** A sender's standing and mark. No row means unknown, with no mark. */
export async function senderRow(ctx: Ctx, inboxId: string, email: string): Promise<{ status: SenderStatus | null; mark: string | null }> {
  const row = await ctx.db.select({ status: senders.status, mark: senders.mark }).from(senders)
    .where(and(eq(senders.inboxId, inboxId), eq(senders.email, email))).get();
  return { status: row?.status ?? null, mark: row?.mark ?? null };
}

/** Sets a sender's standing; null makes them unknown again. Returns the sender's new mark (null when unknown). */
export async function setSenderStatus(ctx: Ctx, inboxId: string, email: string, status: SenderStatus | null): Promise<string | null> {
  if (status === null) {
    await ctx.db.delete(senders).where(and(eq(senders.inboxId, inboxId), eq(senders.email, email)));
    await settleSenders(ctx, inboxId, [email]);
    return null;
  }
  const mark = ctx.id("snd");
  await ctx.db.insert(senders).values({ inboxId, email, status, updatedAt: ctx.now(), mark })
    .onConflictDoUpdate({ target: [senders.inboxId, senders.email], set: { status, updatedAt: ctx.now(), mark } });
  // A sender let in may now show their picture, a blocked one never does.
  await settleSenders(ctx, inboxId, [email]);
  return mark;
}

/**
 * Lets addresses in: the inbox sent them mail, they wrote into a thread that isn't screened, or they are in the
 * first sync's history. Never lifts a block. Each gets a new mark, also when already let in, since that is
 * something else letting them in. A sender let in here for the first time is no longer screening anything: every
 * screened thread of theirs stops being screened (docs/contract.md, "Words"), with an event each, unless `unscreen` is
 * false (the first sync's history, where a person's filing under Screening stands). Returns the threads that changed,
 * for the caller to write back.
 */
export async function markKnown(ctx: Ctx, inboxId: string, emails: Iterable<string>, options: { unscreen?: boolean } = {}): Promise<string[]> {
  // The inbox's own address is never let in by itself: anyone can write it as From, so letting it in would let
  // every forgery of it past screening. A person may still let it in on purpose (`allow_sender`).
  const own = (await getInbox(ctx, inboxId))?.address.toLowerCase();
  const list = [...new Set([...emails].map((e) => e.toLowerCase()).filter((e) => e && e !== own))];
  if (!list.length) return [];
  const before = await ctx.db.select({ email: senders.email }).from(senders)
    .where(and(eq(senders.inboxId, inboxId), inList(senders.email, list)));
  const fresh = list.filter((email) => !before.some((row) => row.email === email));
  // In chunks within one batch (the upsert binds two parameters of its own), so they still land together.
  const rows = list.map((email) => ({ inboxId, email, status: "known" as const, updatedAt: ctx.now(), mark: ctx.id("snd") }));
  await runBatch(ctx, insertChunks(senders, rows, 2).map((chunk) => ctx.db.insert(senders).values(chunk)
    .onConflictDoUpdate({
      target: [senders.inboxId, senders.email],
      set: { mark: sql`excluded.mark`, updatedAt: ctx.now() },
      setWhere: eq(senders.status, "known"),
    })));
  const changed = options.unscreen === false ? [] : await unscreenSenders(ctx, inboxId, fresh);
  // Senders let in for the first time may now show their picture.
  await settleSenders(ctx, inboxId, fresh);
  return changed;
}

/** Every screened thread of these senders stops being screened. Returns the threads that changed. */
export async function unscreenSenders(ctx: Ctx, inboxId: string, emails: string[]): Promise<string[]> {
  if (!emails.length) return [];
  const rows = await ctx.db.select().from(threads).where(and(
    eq(threads.inboxId, inboxId),
    inList(threads.sender, emails),
    eq(threads.screened, true),
    eq(threads.removed, false),
  ));
  const changed: string[] = [];
  for (const row of rows) {
    const saved = await saveThreadState(ctx, row.id, { ...await threadState(ctx, row), screened: false, screenedByMailbox: false });
    if (saved.version === row.version) continue;
    await retireUndo(ctx, [row.id], ["screened"]);
    emitThread(ctx, saved);
    changed.push(row.id);
  }
  return changed;
}
