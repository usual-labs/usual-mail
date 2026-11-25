// The action engine: trust, proposals, applying with an exact before-state, undo, approve and reject, and
// putting things back when the provider refuses. Callers hold `ctx.lock`.

import {
  NEEDS_PERSON,
  ServiceError,
  type ActionInput,
  type ActionKind,
  type Actor,
  type Caller,
  type ScreeningPass,
  type TrustLevel,
} from "@usualmail/core";
import { and, eq, gt, ne } from "drizzle-orm";
import { actions, threads, type ActionRow, type InboxRow, type SenderStatus, type ThreadRow } from "../db/index.ts";
import type { Ctx } from "./context.ts";
import { insertRecord, retireSenderUndo, retireUndo, updateRecord } from "./records.ts";
import { senderChanged, setSender } from "./senders.ts";
import {
  emitThread,
  getThread,
  newestMessageId,
  saveThreadState,
  senderRow,
  senderStatus,
  setSenderStatus,
  threadState,
} from "./store.ts";
import {
  allowState,
  applyAction,
  blockState,
  groupsOf,
  isSenderAction,
  decidedBy,
  sameIn,
  WHERE,
  withGroups,
  type Before,
  type Group,
  type ThreadState,
} from "./state.ts";

const ALL_GROUPS: readonly Group[] = ["category", "screened", "done", "stack", "comeBack", "unread", "trashed"];

/**
 * Whether an action by this actor is applied or only proposed. A person's own action is always applied, and so is
 * what a rule the person taught does (`taught`: the person's own instruction) and what the server's AI decides: trust
 * doesn't govern them. Trust governs outside agents and rules an agent made (docs/contract.md, "Trust").
 */
export function gate(actor: Actor, trust: TrustLevel, kind: ActionKind, taught = false): "applied" | "proposed" {
  if (actor.kind === "person" || actor.kind === "system" || actor.kind === "ai") return "applied";
  if (actor.kind === "rule" && taught) return "applied";
  if (NEEDS_PERSON.includes(kind)) return "proposed";
  return trust === "suggest" ? "proposed" : "applied";
}

/**
 * What a rule or an agent applies alone in an act_silently inbox is silent, and so is everything the server's AI
 * applies. A person's action never is.
 */
function silentFor(actor: Actor, trust: TrustLevel): boolean {
  if (actor.kind === "ai") return true;
  return (actor.kind === "rule" || actor.kind === "agent") && trust === "act_silently";
}

/** Throws `conflict` for a thread no action may touch now. Checked for every named thread before any changes. */
export function assertActionable(thread: ThreadRow, kind: ActionKind): void {
  if (thread.removed) throw new ServiceError("conflict", `${thread.id} is no longer in the mailbox`);
  if (thread.trashed && kind !== "trash") {
    throw new ServiceError("conflict", `${thread.id} is in the trash. Undo the trash first.`);
  }
}

interface Change {
  targetId: string;
  before: Before;
  /** The new state of every thread the action reaches. */
  after: Map<string, ThreadState>;
  sender?: { email: string; to: SenderStatus };
}

async function planChange(ctx: Ctx, inbox: InboxRow, thread: ThreadRow, action: ActionInput): Promise<Change> {
  const targetState = await threadState(ctx, thread);
  if (!isSenderAction(action.kind)) {
    // Deciding a category lets nobody in (docs/contract.md, "Rules and learning").
    const after = applyAction(targetState, action, ctx.now(), await newestMessageId(ctx, thread));
    return { targetId: thread.id, before: { threads: [{ id: thread.id, state: targetState }] }, after: new Map([[thread.id, after]]) };
  }
  const allow = action.kind === "allow_sender";
  if (!thread.sender) throw new ServiceError("invalid", `This thread has no sender to ${allow ? "allow" : "block"}`);
  const status = await senderStatus(ctx, inbox.id, thread.sender);
  const fromSender = await ctx.db.select().from(threads).where(and(
    eq(threads.inboxId, inbox.id),
    eq(threads.sender, thread.sender),
    eq(threads.removed, false),
    eq(threads.trashed, false),
    ne(threads.id, thread.id),
  ));
  const before: Before = { threads: [{ id: thread.id, state: targetState }], sender: { email: thread.sender, status } };
  const after = new Map([[thread.id, allow ? allowState(targetState) : blockState(targetState)]]);
  for (const row of fromSender) {
    const state = await threadState(ctx, row);
    const next = allow ? allowState(state) : blockState(state);
    if (sameIn(ALL_GROUPS, state, next)) continue;
    before.threads.push({ id: row.id, state });
    after.set(row.id, next);
  }
  return { targetId: thread.id, before, after, sender: { email: thread.sender, to: allow ? "known" : "blocked" } };
}

function isNoop(change: Change, groups: readonly Group[]): boolean {
  if (change.sender && change.sender.to !== change.before.sender?.status) return false;
  return change.before.threads.every(({ id, state }) => sameIn(groups, state, change.after.get(id) ?? state));
}

/**
 * Who decided the category, and why. A `categorize` records who decided (also when only proposed); the AI gives no
 * reason and clears the one there was, and so does a person's own categorize without one, since the old reason was
 * someone else's. Any other action keeps who decided the category, and sets the reason when one is given. Reading
 * and marking unread decide nothing.
 */
function withDecision(state: ThreadState, actor: Actor, action: ActionInput, reason: string | undefined): ThreadState {
  if (action.kind === "read" || action.kind === "unread") return state;
  if (action.kind !== "categorize") return reason ? { ...state, reason } : state;
  const nextReason = actor.kind === "ai" ? null : reason ?? (actor.kind === "person" ? null : state.reason);
  return { ...state, ...(decidedBy(actor) ?? {}), reason: nextReason };
}

export interface PerformInput {
  inbox: InboxRow;
  thread: ThreadRow;
  action: ActionInput;
  actor: Actor;
  reason?: string;
  /** The actor is a rule the person taught (source `person` or `correction`): it applies whatever the trust. */
  taught?: boolean;
  /**
   * The server's AI categorized a thread at the screening gate (its sender isn't let in; not filed under Screening by
   * the mailbox). With `pass`, the kind of mail the server's own check confirmed, the thread stops being screened and
   * says why, its sender still not let in; with null it stays screened, whatever the category (docs/contract.md,
   * "Rules and learning").
   */
  gate?: { pass: ScreeningPass | null };
}

/**
 * Does one action to one thread under the trust table. Returns the new record (or the same open proposal),
 * or null when the action wouldn't change the thread: such an action gets no record.
 */
export async function perform(ctx: Ctx, input: PerformInput): Promise<ActionRow | null> {
  const { inbox, thread, action } = input;
  assertActionable(thread, action.kind);
  if (action.kind === "come_back" && Date.parse(action.at) <= ctx.now()) {
    throw new ServiceError("invalid", "A come-back time must be in the future");
  }
  const change = await planChange(ctx, inbox, thread, action);
  if (input.gate) {
    const before = change.before.threads[0]!.state;
    const after = change.after.get(thread.id)!;
    change.after.set(thread.id, input.gate.pass
      ? { ...after, screened: false, screenedByMailbox: false, skippedScreening: input.gate.pass }
      : { ...after, screened: before.screened, screenedByMailbox: before.screenedByMailbox, skippedScreening: before.skippedScreening ?? null });
  }
  if (isNoop(change, groupsOf(action.kind))) return null;
  if (gate(input.actor, inbox.trust, action.kind, input.taught) === "proposed") return propose(ctx, input, change);
  return commit(ctx, { ...input, change });
}

async function propose(ctx: Ctx, input: PerformInput, change: Change): Promise<ActionRow> {
  const { inbox, thread, action, actor, reason } = input;
  const open = await ctx.db.select().from(actions)
    .where(and(eq(actions.threadId, thread.id), eq(actions.state, "proposed"), eq(actions.kind, action.kind)));
  const same = open.find((row) => JSON.stringify(row.action) === JSON.stringify(action));
  if (same) return same;
  // A proposal still says at once who decided and why, so the thread leaves the triage queue.
  const current = change.before.threads[0]!.state;
  const decided = withDecision(current, actor, action, reason);
  const saved = await saveThreadState(ctx, thread.id, decided);
  if (saved.version !== thread.version) emitThread(ctx, saved);
  return insertRecord(ctx, { inbox, threadId: thread.id, action, actor, reason, state: "proposed", undoable: false, before: change.before });
}

interface CommitInput extends PerformInput {
  change: Change;
  /** An approved proposal: updated instead of a new record. */
  existing?: ActionRow;
}

async function commit(ctx: Ctx, input: CommitInput): Promise<ActionRow> {
  const { inbox, action, actor, reason, change, existing } = input;
  const groups = groupsOf(action.kind);
  const changed: ThreadRow[] = [];
  // Each thread's revision after the action, so undoing an allow or a block can tell which were changed since.
  const before: Before = { threads: [] };
  for (const { id, state } of change.before.threads) {
    let next = change.after.get(id) ?? state;
    if (id === change.targetId) next = withDecision(next, actor, action, reason);
    const prior = await getThread(ctx, id);
    const saved = await saveThreadState(ctx, id, next);
    if (saved.version !== prior?.version) changed.push(saved);
    before.threads.push({ id, state, revision: saved.revision, after: next });
  }
  if (change.sender && change.before.sender) {
    const mark = await setSenderStatus(ctx, inbox.id, change.sender.email, change.sender.to);
    before.sender = { ...change.before.sender, mark };
  }
  // As they are now: letting a sender in or blocking them may have changed their picture since (`settleSenders`).
  for (const row of changed) emitThread(ctx, (await getThread(ctx, row.id)) ?? row);

  const record = existing
    ? await updateRecord(ctx, existing.id, { state: "applied", at: ctx.now(), undoable: true, before, error: null, silent: false })
    : await insertRecord(ctx, {
      inbox, threadId: change.targetId, action, actor, reason, state: "applied", undoable: true, before, silent: silentFor(actor, inbox.trust),
    });

  // A block began or ended: people's devices are told once its record exists, so the item says who blocked.
  if (change.sender && change.before.sender && (change.before.sender.status === "blocked") !== (change.sender.to === "blocked")) {
    await senderChanged(ctx, inbox.id, change.sender.email);
  }

  // An earlier action on the same parts of these threads can no longer be undone exactly; nor an earlier
  // allow or block of the same sender, once this one is an allow or a block.
  await retireUndo(ctx, before.threads.map((t) => t.id), groups, record.id);
  if (isSenderAction(action.kind) && change.sender) await retireSenderUndo(ctx, inbox.id, change.sender.email, record.id);

  ctx.hooks.writeBack({ inboxId: inbox.id, threadIds: before.threads.map((t) => t.id), recordIds: [record.id] });
  if (groups.includes("comeBack") || groups.includes("trashed")) ctx.hooks.timersChanged();
  return record;
}

// --- Undo ------------------------------------------------------------------------------------------------

/** Whether this caller could have applied the opposite itself, and so may undo the action. */
export function assertMayUndo(caller: Caller, record: ActionRow, inbox: InboxRow): void {
  if (caller.actor.kind === "person") return;
  if (gate(caller.actor, inbox.trust, record.kind) !== "applied") {
    throw new ServiceError("needs_person", "Only a person can undo this here");
  }
}

/**
 * Whether a thread the record changed is put back. An allow or a block changes every thread from a sender, so it
 * puts back only threads nobody changed since: their revision is still the one the action left. A come-back time
 * passing raises only the version, so it doesn't count. Other actions are retired as soon as a later change
 * touches what they changed, so their thread is always put back.
 */
function putsBack(record: ActionRow, row: ThreadRow, revision: number | undefined): boolean {
  if (!isSenderAction(record.kind)) return true;
  return revision !== undefined && row.revision === revision;
}

/**
 * The sender as the record found them, put back: always for an allow or a block, which are about the sender. A record
 * from before the fifth revision whose move out of Screening let the sender in puts them back only while nothing
 * else has let them in or blocked them since. Returns the sender as they were before this, or undefined when they
 * were left alone.
 */
async function restoreSender(ctx: Ctx, record: ActionRow): Promise<Before["sender"]> {
  const saved = record.before.sender;
  if (!saved) return undefined;
  const current = await senderRow(ctx, record.inboxId, saved.email);
  if (!isSenderAction(record.kind) && (saved.mark === undefined || current.mark !== saved.mark)) return undefined;
  await setSender(ctx, record.inboxId, saved.email, saved.status);
  return { email: saved.email, status: current.status };
}

/** Puts the record's threads back as they were. The record becomes `undone`. */
export async function undoRecord(ctx: Ctx, caller: Caller, record: ActionRow): Promise<{ record: ActionRow; threads: ThreadRow[] }> {
  if (record.state !== "applied") throw new ServiceError("conflict", `This action is ${record.state}, so there is nothing to undo`);
  if (!record.undoable) throw new ServiceError("conflict", "This action can no longer be undone");
  const groups = groupsOf(record.kind);
  const preUndo: Before = { threads: [] };
  const changed: ThreadRow[] = [];
  for (const { id, state: before, revision } of record.before.threads) {
    const row = await getThread(ctx, id);
    if (!row || row.removed || !putsBack(record, row, revision)) continue;
    const current = await threadState(ctx, row);
    preUndo.threads.push({ id, state: current });
    let next = withGroups(groups, current, before);
    if (id === record.threadId) {
      if (record.kind === "categorize") {
        // Undoing a category decides it: whoever undid it has, so the AI doesn't decide it again
        // (docs/contract.md, "Actions and undo").
        next = {
          ...next,
          ...(decidedBy(caller.actor) ?? { categorizedBy: before.categorizedBy, categorizedByActor: before.categorizedByActor ?? null }),
          need: before.need,
          reason: before.reason,
        };
        if (caller.actor.kind !== record.actorKind) next.reason = null;
      } else if (caller.actor.kind === record.actorKind) {
        next = { ...next, need: before.need, reason: before.reason };
      }
    }
    const saved = await saveThreadState(ctx, id, next);
    if (saved.version !== row.version) emitThread(ctx, saved);
    changed.push(saved);
  }
  const sender = await restoreSender(ctx, record);
  if (sender) {
    preUndo.sender = sender;
    // Putting the sender back may change their picture; the threads are returned as they are now.
    for (const [i, row] of changed.entries()) changed[i] = (await getThread(ctx, row.id)) ?? row;
  }
  const undone = await updateRecord(ctx, record.id, { state: "undone", undoneAt: ctx.now(), undoable: false, error: null });
  ctx.hooks.writeBack({
    inboxId: record.inboxId,
    threadIds: changed.map((row) => row.id),
    recordIds: [record.id],
    undo: { recordId: record.id, before: preUndo },
  });
  if (groups.includes("comeBack") || groups.includes("trashed")) ctx.hooks.timersChanged();
  return { record: undone, threads: changed };
}

// --- Approve and reject ----------------------------------------------------------------------------------

/** Throws `conflict` when the thread changed since the proposal, in the parts the action touches. */
export async function assertFresh(ctx: Ctx, record: ActionRow, thread: ThreadRow | undefined): Promise<void> {
  if (!thread || thread.removed) throw new ServiceError("conflict", "The thread is no longer in the mailbox");
  if (thread.trashed && record.kind !== "trash") throw new ServiceError("conflict", "The thread is in the trash");
  const before = record.before.threads.find((t) => t.id === record.threadId)?.state;
  const current = await threadState(ctx, thread);
  if (!before || !sameIn(groupsOf(record.kind), current, before)) {
    throw new ServiceError("conflict", `The thread changed since this was proposed (${record.id})`);
  }
  if (isSenderAction(record.kind) && record.before.sender) {
    const now = await senderStatus(ctx, record.inboxId, record.before.sender.email);
    if (now !== record.before.sender.status) throw new ServiceError("conflict", `The sender's standing changed since this was proposed (${record.id})`);
  }
}

export async function approveRecord(ctx: Ctx, inbox: InboxRow, record: ActionRow): Promise<ActionRow> {
  const thread = await getThread(ctx, record.threadId);
  if (!thread) throw new ServiceError("conflict", "The thread is no longer in the mailbox");
  const change = await planChange(ctx, inbox, thread, record.action);
  return commit(ctx, {
    inbox,
    thread,
    action: record.action,
    actor: record.actor,
    reason: record.reason ?? undefined,
    change,
    existing: record,
  });
}

export async function rejectRecord(ctx: Ctx, record: ActionRow): Promise<ActionRow> {
  return updateRecord(ctx, record.id, { state: "rejected" });
}

// --- When the provider refuses ---------------------------------------------------------------------------

/**
 * Puts a thread's parts back to `to`, but only the parts still as `left` has them: a part something changed
 * since (a later action, a change at the provider) keeps that later change. Who decided and why go back too when
 * every part did. Returns the parts that were left alone.
 */
async function putBackUnchanged(
  ctx: Ctx,
  row: ThreadRow,
  groups: readonly Group[],
  left: ThreadState | undefined,
  to: ThreadState,
  decision: boolean,
): Promise<{ saved: ThreadRow; kept: Group[] }> {
  const current = await threadState(ctx, row);
  const parts = left ? groups.filter((group) => sameIn([group], current, left)) : groups;
  const kept = groups.filter((group) => !parts.includes(group));
  let next = withGroups(parts, current, to);
  if (decision && kept.length === 0) {
    next = { ...next, categorizedBy: to.categorizedBy, categorizedByActor: to.categorizedByActor ?? null, need: to.need, reason: to.reason };
  }
  const saved = await saveThreadState(ctx, row.id, next);
  if (saved.version !== row.version) emitThread(ctx, saved);
  return { saved, kept };
}

/**
 * A record that failed never happened. Later applied records that changed a part it changed found that part as
 * it left it; they now remember the part as it was before it, so their undo or failure puts it back there.
 * `before` isn't part of a record as clients see it, so nothing is sent.
 */
async function rebaseLater(ctx: Ctx, record: ActionRow, threadId: string, kept: Group[], left: ThreadState, to: ThreadState): Promise<void> {
  if (kept.length === 0) return;
  const later = await ctx.db.select().from(actions).where(and(
    eq(actions.inboxId, record.inboxId),
    eq(actions.state, "applied"),
    gt(actions.id, record.id),
  ));
  for (const other of later) {
    let touched = false;
    const threads = other.before.threads.map((entry) => {
      if (entry.id !== threadId) return entry;
      const parts = kept.filter((group) => groupsOf(other.kind).includes(group) && sameIn([group], entry.state, left));
      if (parts.length === 0) return entry;
      touched = true;
      return { ...entry, state: withGroups(parts, entry.state, to) };
    });
    if (touched) await ctx.db.update(actions).set({ before: { ...other.before, threads } }).where(eq(actions.id, other.id));
  }
}

/**
 * The provider refused to carry out these records: each becomes `failed` (and never silent) and its threads are
 * put back, in each part nothing has changed since. A part a later action changed keeps that change, and that
 * action now remembers the part as it was before the failed one.
 */
export async function failRecords(ctx: Ctx, recordIds: string[], error: string): Promise<void> {
  for (const id of [...recordIds].reverse()) {
    const record = await ctx.db.select().from(actions).where(eq(actions.id, id)).get();
    if (!record || record.state !== "applied") continue;
    const groups = groupsOf(record.kind);
    for (const { id: threadId, state: before, revision, after } of record.before.threads) {
      const row = await getThread(ctx, threadId);
      if (!row || !putsBack(record, row, revision)) continue;
      const { kept } = await putBackUnchanged(ctx, row, groups, after, before, threadId === record.threadId);
      if (after) await rebaseLater(ctx, record, threadId, kept, after, before);
    }
    await restoreSender(ctx, record);
    await updateRecord(ctx, id, { state: "failed", undoable: false, error, silent: false });
    if (groups.includes("comeBack")) ctx.hooks.timersChanged();
  }
}

/**
 * The provider refused an undo: the threads go back to how they were before it, in each part nothing has changed
 * since the undo, and the record stays applied with the error. It stays undoable, so the person can try again,
 * unless a later action changed a part it changed (then that action keeps its change and remembers the part as it
 * was before the undo). It is never silent again. The record's revisions and the sender's mark are taken afresh,
 * so the next undo still finds the threads unchanged.
 */
export async function failUndo(ctx: Ctx, recordId: string, preUndo: Before, error: string): Promise<void> {
  const record = await ctx.db.select().from(actions).where(eq(actions.id, recordId)).get();
  if (!record || record.state !== "undone") return;
  const groups = groupsOf(record.kind);
  const revisions = new Map<string, number>();
  let overtaken = false;
  for (const { id, state } of preUndo.threads) {
    const row = await getThread(ctx, id);
    if (!row) continue;
    // The undo left each part as the record found it.
    const entry = record.before.threads.find((item) => item.id === id);
    const left = entry?.state;
    const { saved, kept } = await putBackUnchanged(ctx, row, groups, left, state, id === record.threadId);
    if (left && kept.length) {
      overtaken = true;
      await rebaseLater(ctx, record, id, kept, left, state);
    }
    // Only a thread that is again where the action left it counts as unchanged for the next undo; one changed
    // since the undo keeps its old revision, so undoing an allow or a block again leaves it alone.
    const back = kept.length === 0 && (!entry?.after || sameIn(WHERE, await threadState(ctx, saved), entry.after));
    if (back) revisions.set(id, saved.revision);
  }
  const before: Before = {
    ...record.before,
    threads: record.before.threads.map((t) => (revisions.has(t.id) ? { ...t, revision: revisions.get(t.id)! } : t)),
  };
  if (preUndo.sender && record.before.sender) {
    const mark = await setSender(ctx, record.inboxId, preUndo.sender.email, preUndo.sender.status);
    before.sender = { ...record.before.sender, mark };
  }
  await updateRecord(ctx, recordId, {
    state: "applied",
    undoneAt: null,
    // Allow and block stay undoable whatever happened to their threads since.
    undoable: !overtaken || isSenderAction(record.kind),
    silent: false,
    before,
    error: `Undo failed at the provider: ${error}`,
  });
  if (groups.includes("comeBack")) ctx.hooks.timersChanged();
}
