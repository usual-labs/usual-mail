// The calls that change threads on purpose: act, undo, approve, reject and decide, and letting a sender in by
// address. Each answers with an `ActResult`: one record per thread it changed or proposed to change, and every named
// thread as it is now.

import {
  ServiceError,
  type ActInput,
  type ActionInput,
  type ActResult,
  type AllowSenderInput,
  type Caller,
  type Id,
  type TeachPrompt,
  type TriageDecision,
} from "@usualmail/core";
import { and, desc, eq } from "drizzle-orm";
import { threads, type ActionRow, type InboxRow, type ThreadRow } from "../db/index.ts";
import { inList } from "../db/params.ts";
import { iso, parseTime, unique } from "../util.ts";
import { isPerson, mayRead, requireInbox, requirePerson, requireThread } from "./access.ts";
import { approveRecord, assertActionable, assertFresh, assertMayUndo, perform, rejectRecord, undoRecord } from "./actions.ts";
import type { Ctx } from "./context.ts";
import { toRecord, toThread } from "./rows.ts";
import { ActInputSchema, AllowSenderSchema, check, DecisionsSchema, IdsSchema } from "./schemas.ts";
import { senderAddress, setSender } from "./senders.ts";
import { decidedBy, groupsOf } from "./state.ts";
import { emitThread, getInbox, getRecord, getThread, saveThreadState, senderStatus, threadState } from "./store.ts";
import { offerTeach } from "./teach.ts";

export async function act(ctx: Ctx, caller: Caller, input: ActInput): Promise<ActResult> {
  const data = check(ActInputSchema, input, "Action");
  const action = canonical(data.action);
  return ctx.lock.run(async () => {
    const ids = unique(data.threadIds);
    const targets: Array<{ thread: ThreadRow; inbox: InboxRow }> = [];
    for (const id of ids) targets.push(await requireThread(ctx, caller, id));
    // Every thread is checked before any is changed, so a refusal changes nothing.
    for (const { thread } of targets) {
      assertActionable(thread, action.kind);
      if ((action.kind === "allow_sender" || action.kind === "block_sender") && !thread.sender) {
        throw new ServiceError("invalid", `${thread.id} has no sender to ${action.kind === "allow_sender" ? "allow" : "block"}`);
      }
    }
    if (action.kind === "come_back" && Date.parse(action.at) <= ctx.now()) {
      throw new ServiceError("invalid", "A come-back time must be in the future");
    }
    const records: ActionRow[] = [];
    let teach: TeachPrompt | undefined;
    for (const { thread: loaded, inbox } of targets) {
      const thread = (await getThread(ctx, loaded.id)) ?? loaded;
      const record = await perform(ctx, { inbox, thread, action, actor: caller.actor, reason: data.reason });
      if (!record) continue;
      if (!records.some((row) => row.id === record.id)) records.push(record);
      // A person changing a thread's category may want that every time.
      if (!teach && isPerson(caller) && action.kind === "categorize" && thread.category !== action.category && record.state === "applied") {
        teach = await offerTeach(ctx, inbox, thread, action.category, record.id);
      }
    }
    return result(ctx, records, ids, teach);
  });
}

/**
 * Person only: lets a sender in by address. Exactly `allow_sender` on their newest thread that isn't trashed or gone,
 * through the same engine, so it is recorded there, shows in Handled and can be undone. A sender with no such thread
 * left has nothing to record it on: they are let in without a record. The threads returned are those it changed.
 */
export async function allowSender(ctx: Ctx, caller: Caller, input: AllowSenderInput): Promise<ActResult> {
  requirePerson(caller, "let a sender in by address");
  const data = check(AllowSenderSchema, input, "Sender");
  const address = senderAddress(data.address);
  return ctx.lock.run(async () => {
    const inbox = await requireInbox(ctx, caller, data.inboxId);
    const thread = await ctx.db.select().from(threads)
      .where(and(eq(threads.inboxId, inbox.id), eq(threads.sender, address), eq(threads.removed, false), eq(threads.trashed, false)))
      .orderBy(desc(threads.lastMessageAt), desc(threads.id)).limit(1).get();
    if (!thread) {
      if (await senderStatus(ctx, inbox.id, address) !== "known") await setSender(ctx, inbox.id, address, "known");
      return result(ctx, [], []);
    }
    const record = await perform(ctx, { inbox, thread, action: { kind: "allow_sender" }, actor: caller.actor });
    return result(ctx, record ? [record] : [], record ? record.before.threads.map((entry) => entry.id) : []);
  });
}

export async function undo(ctx: Ctx, caller: Caller, actionId: Id): Promise<ActResult> {
  return ctx.lock.run(async () => {
    const { record, inbox } = await visibleRecord(ctx, caller, actionId);
    assertMayUndo(caller, record, inbox);
    const categoryBefore = (await getThread(ctx, record.threadId))?.category;
    const { record: undone } = await undoRecord(ctx, caller, record);
    let teach: TeachPrompt | undefined;
    // A person correcting a rule, an agent or the server's AI may want that every time. Nobody chooses `unknown`, so
    // a category that goes back to it offers nothing.
    const thread = await getThread(ctx, record.threadId);
    if (isPerson(caller) && record.actorKind !== "person" && groupsOf(record.kind).includes("category")
      && thread && thread.category !== categoryBefore && thread.category !== "unknown") {
      teach = await offerTeach(ctx, inbox, thread, thread.category, record.id);
    }
    return result(ctx, [undone], [record.threadId], teach);
  });
}

/** Person only. Applies every named proposal or none. */
export async function approve(ctx: Ctx, caller: Caller, actionIds: Id[]): Promise<ActResult> {
  requirePerson(caller, "approve what rules and agents propose");
  const ids = unique(check(IdsSchema, actionIds, "actionIds"));
  return ctx.lock.run(async () => {
    const items = await proposals(ctx, caller, ids);
    for (const { record } of items) await assertFresh(ctx, record, await getThread(ctx, record.threadId));
    // Two proposals that change the same part of one thread can't both be applied as they were proposed.
    for (const [index, { record }] of items.entries()) {
      const clash = items.slice(index + 1).find(({ record: other }) => other.threadId === record.threadId
        && groupsOf(other.kind).some((group) => groupsOf(record.kind).includes(group)));
      if (clash) throw new ServiceError("conflict", `${record.id} and ${clash.record.id} change the same part of ${record.threadId}`);
    }
    const records: ActionRow[] = [];
    for (const { record, inbox } of items) records.push(await approveRecord(ctx, inbox, record));
    return result(ctx, records, records.map((row) => row.threadId));
  });
}

/** Person only. Turns proposals down. */
export async function reject(ctx: Ctx, caller: Caller, actionIds: Id[]): Promise<ActResult> {
  requirePerson(caller, "turn down what rules and agents propose");
  const ids = unique(check(IdsSchema, actionIds, "actionIds"));
  return ctx.lock.run(async () => {
    const items = await proposals(ctx, caller, ids);
    const records: ActionRow[] = [];
    for (const { record } of items) records.push(await rejectRecord(ctx, record));
    return result(ctx, records, records.map((row) => row.threadId));
  });
}

/**
 * One decision per thread, applied under the trust table like any action by the caller: a category that changes is
 * a `categorize`. The thread's `categorizedBy` becomes `agent` (or `person`), also when the category didn't change or
 * is only proposed, and its need and reason are stored.
 */
export async function decide(ctx: Ctx, caller: Caller, decisions: TriageDecision[]): Promise<ActResult> {
  const list = check(DecisionsSchema, decisions, "Decisions");
  if (unique(list.map((d) => d.threadId)).length !== list.length) throw new ServiceError("invalid", "One decision per thread");
  return ctx.lock.run(async () => {
    const targets = [];
    for (const decision of list) {
      const target = await requireThread(ctx, caller, decision.threadId);
      assertActionable(target.thread, "categorize");
      targets.push({ decision, ...target });
    }
    const records: ActionRow[] = [];
    for (const { decision, inbox, thread: loaded } of targets) {
      const start = (await getThread(ctx, loaded.id)) ?? loaded;
      const steps: ActionInput[] = [];
      if (decision.category !== start.category) steps.push({ kind: "categorize", category: decision.category });
      if (decision.done === true && !start.done) steps.push({ kind: "done" });
      if (decision.done === false && start.done) steps.push({ kind: "not_done" });
      for (const action of steps) {
        const thread = (await getThread(ctx, loaded.id)) ?? loaded;
        const record = await perform(ctx, { inbox, thread, action, actor: caller.actor, reason: decision.reason });
        if (record && !records.some((row) => row.id === record.id)) records.push(record);
      }
      const thread = (await getThread(ctx, loaded.id)) ?? loaded;
      const saved = await saveThreadState(ctx, thread.id, {
        ...await threadState(ctx, thread),
        ...decidedBy(caller.actor),
        need: decision.need ?? null,
        reason: decision.reason,
      });
      if (saved.version !== thread.version) emitThread(ctx, saved);
    }
    return result(ctx, records, list.map((d) => d.threadId));
  });
}

// --- Helpers -----------------------------------------------------------------------------------------------

async function visibleRecord(ctx: Ctx, caller: Caller, id: Id): Promise<{ record: ActionRow; inbox: InboxRow }> {
  const record = await getRecord(ctx, id);
  const inbox = record && await getInbox(ctx, record.inboxId);
  if (!record || !inbox || !mayRead(caller, inbox)) throw new ServiceError("not_found", "No such action");
  return { record, inbox };
}

async function proposals(ctx: Ctx, caller: Caller, ids: Id[]) {
  const items = [];
  for (const id of ids) {
    const item = await visibleRecord(ctx, caller, id);
    if (item.record.state !== "proposed") throw new ServiceError("conflict", `${id} is ${item.record.state}, not proposed`);
    items.push(item);
  }
  return items;
}

/** The answer every one of these calls gives: the records, and each named thread as it is now. */
async function result(ctx: Ctx, records: ActionRow[], threadIds: string[], teach?: TeachPrompt): Promise<ActResult> {
  const ids = unique(threadIds);
  const rows = ids.length ? await ctx.db.select().from(threads).where(inList(threads.id, ids)) : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: ActResult = {
    records: records.map(toRecord),
    threads: ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toThread(row)] : [];
    }),
  };
  if (teach) out.teach = teach;
  return out;
}

/** One spelling per action, so identical proposals compare equal and times are stored in one format. */
function canonical(action: ActionInput): ActionInput {
  if (action.kind !== "come_back") return action;
  const at = iso(parseTime(action.at, "action.at"));
  return action.ifNoReply === undefined ? { kind: "come_back", at } : { kind: "come_back", at, ifNoReply: action.ifNoReply };
}
