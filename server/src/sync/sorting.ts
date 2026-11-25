// Where new mail goes (docs/contract.md, "Rules and learning"): a brand-new thread is sorted by block, rules,
// screening and the server's AI, or keeps the person's own filing; new mail in a thread brings it back from done,
// ends a come-back-if-no-reply wait, and tells the AI what to look at again. Runs under `ctx.lock`.

import type { FiledCategory, ProviderMessage, ProviderPlacement } from "@usualmail/core";
import { FILED_CATEGORIES } from "@usualmail/core";
import { and, eq } from "drizzle-orm";
import { messages, threads, type InboxRow, type ThreadRow } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { retireUndo } from "../service/records.ts";
import { applyRule, firstIncoming, firstMatch } from "../service/rules.ts";
import { BY_MAILBOX, doneState, NO_COME_BACK, sameIn, type Group, type ThreadState } from "../service/state.ts";
import { getThread, markKnown, saveThreadState, senderStatus, threadState } from "../service/store.ts";
import { dateOf } from "./rows.ts";

export interface Sorted {
  /** The rule that sorted it, if one did. */
  ruleId?: string;
  /** The AI has work on it that should start at once: new mail the AI may process now. */
  aiNow: boolean;
  /** Threads whose screening the sorting lifted (a sender let in), to write back. */
  tidy: string[];
}

/**
 * Sorts a brand-new thread. `aiNow` says whether the server's AI may process this inbox's mail at this moment.
 *
 * The first sync is history: kept as the provider has it (`asFiled`), senders let in (not those of threads filed
 * under Screening), no rules, no screening; the AI processes it later as history. After that, new mail the provider
 * delivered outside its inbox keeps the person's own filing the same way, without letting its sender in. New mail
 * delivered to the inbox is sorted by the first that applies: a blocked sender (done, the AI never sees it), the
 * first matching rule, a sender who isn't let in (screened; the AI categorizes it first and a one-time code isn't
 * screened), or the AI. Then the AI summarizes it, unless it is a one-time code. A rule's match lets no one in.
 */
export async function classify(ctx: Ctx, inbox: InboxRow, threadId: string, history: boolean, aiNow: boolean, imported = false): Promise<Sorted> {
  const none: Sorted = { aiNow: false, tidy: [] };
  const thread = await getThread(ctx, threadId);
  if (!thread || thread.removed) return none;
  const state = await threadState(ctx, thread);
  const first = await firstIncoming(ctx, threadId);
  if (!first) {
    // Only the mailbox's own mail: nothing waits on the person, and there is nothing for the AI.
    await saveThreadState(ctx, threadId, { ...state, done: true });
    return none;
  }
  const sender = first.from.email.toLowerCase();
  if (history) {
    // A thread filed under a category is not done, however old inside the synced window; archived history without a
    // category, a stack or Screening is (docs/contract-sync.md, "Sync").
    const filed = await asFiled(ctx, threadId, first.placement, state);
    if (imported) {
      // An old conversation opened from a search of the mailbox: placed as the mailbox has it, its sender not let in
      // by being opened; a blocked sender's mail is done wherever it arrives.
      if (await senderStatus(ctx, inbox.id, sender) === "blocked") {
        await saveState(ctx, threadId, { ...doneState(filed), reason: "You blocked this sender" });
        return none;
      }
      await setDue(ctx, threadId, filed);
      return none;
    }
    // Senders in the history are let in, except those of threads filed under Screening there. Nothing already
    // screened is lifted by it: the person's filing under Screening stands.
    if (!filed.screened) await markKnown(ctx, inbox.id, [sender], { unscreen: false });
    await setDue(ctx, threadId, filed);
    return none;
  }
  const status = await senderStatus(ctx, inbox.id, sender);
  const incoming = await ctx.db.select({ placement: messages.placement }).from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.outgoing, false)));
  if (!incoming.some((m) => m.placement.inInbox)) {
    // Filed by the person's own filter or server rule: their filing stands. A block still makes it done.
    let filed = await asFiled(ctx, threadId, first.placement, state);
    if (status === "blocked") {
      filed = await saveState(ctx, threadId, { ...doneState(filed), reason: "You blocked this sender" });
      return none;
    }
    await setDue(ctx, threadId, filed);
    return { aiNow: aiNow && !filed.done, tidy: [] };
  }
  if (status === "blocked") {
    // Done, and its sender still isn't let in. The AI never sees it.
    await saveState(ctx, threadId, { ...doneState(state), screened: true, reason: "You blocked this sender" });
    return none;
  }
  const rule = await firstMatch(ctx, inbox.id, first);
  if (rule) {
    const { decidedCategory } = await applyRule(ctx, inbox, thread, rule);
    const after = await getThread(ctx, threadId);
    if (after) await setDue(ctx, threadId, await threadState(ctx, after), !decidedCategory);
    return { ruleId: rule.id, aiNow: aiNow && after !== undefined && !after.done && !after.trashed, tidy: [] };
  }
  if (status !== "known") {
    // A stranger: screened. While the AI's answer is awaited the thread isn't written back, so a one-time code isn't
    // moved to Screening and out again at the provider.
    const screened = await saveState(ctx, threadId, { ...state, screened: true, reason: "First mail from this sender" });
    await setDue(ctx, threadId, screened);
    if (aiNow) await ctx.db.update(threads).set({ gatePending: true }).where(eq(threads.id, threadId));
    return { aiNow, tidy: [] };
  }
  await setDue(ctx, threadId, state);
  return { aiNow, tidy: [] };
}

async function saveState(ctx: Ctx, threadId: string, state: ThreadState): Promise<ThreadState> {
  await saveThreadState(ctx, threadId, state);
  return state;
}

/**
 * What the AI should do for a new thread: categorize it while nobody has decided it (and `categorize` allows it),
 * and summarize it unless it is a one-time code. Done threads wait: the AI processes them only if new mail brings
 * them back.
 */
async function setDue(ctx: Ctx, threadId: string, state: ThreadState, categorize = true): Promise<void> {
  await ctx.db.update(threads).set({
    categoryDue: categorize && state.category === "unknown" && state.categorizedBy === null,
    summaryDue: state.category !== "otp",
  }).where(eq(threads.id, threadId));
}

function isFiled(category: unknown): category is FiledCategory {
  return (FILED_CATEGORIES as readonly unknown[]).includes(category);
}

/**
 * As the provider has it: a filed category's label or folder is that category (decided by the mailbox), the
 * Screening label or folder screens it, and a stack's label or keyword is that stack. A thread out of the inbox, in
 * the first sync's history or new, is done only when nothing else holds it: no category, no Screening and no stack.
 * So a new server's category lists show the mail the first sync took (all of it since 2026-11-18, when the AI's
 * history became all synced mail; before, only what was inside the history days) (docs/contract.md, "Rules and
 * learning").
 */
async function asFiled(
  ctx: Ctx,
  threadId: string,
  placement: ProviderPlacement,
  state: ThreadState,
): Promise<ThreadState> {
  const incoming = await ctx.db.select({ placement: messages.placement }).from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.outgoing, false)));
  const inInbox = incoming.some((m) => m.placement.inInbox);
  const stack = placement.stack ?? null;
  const filed = isFiled(placement.category) ? placement.category : null;
  const held = stack !== null || placement.screened || filed !== null;
  const next: ThreadState = {
    ...state,
    ...(filed && { category: filed, ...BY_MAILBOX }),
    ...(filed === "otp" && { summary: null }),
    screened: placement.screened,
    screenedByMailbox: placement.screened,
    stack,
    done: !inInbox && !held,
  };
  return saveState(ctx, threadId, next);
}

/**
 * Whether the thread is out of Screening only because the server's own check let it skip it (`skippedScreening`) and
 * its sender still isn't let in. Mail written into it lets nobody in, and the AI doesn't move it to `conversation`.
 */
export async function skippedWhileUnknown(ctx: Ctx, row: ThreadRow): Promise<boolean> {
  if (row.screened || !row.skippedScreening) return false;
  return !row.sender || await senderStatus(ctx, row.inboxId, row.sender) !== "known";
}

/**
 * Someone else wrote into a thread that already existed. It ends a come-back-if-no-reply wait that is still
 * running, and brings a done thread back unless the writer is blocked or the thread is trashed. Mail older
 * than the thread's newest message (a provider catching up out of order) brings nothing back. Incoming mail that
 * isn't from a blocked sender makes the summary out of date (unless it is a one-time code), and the category too when
 * nobody has decided it or the AI filed it elsewhere than `conversation`. Returns whether the AI has new work.
 */
export async function newMailInThread(ctx: Ctx, thread: ThreadRow, message: ProviderMessage, lastBefore: number): Promise<boolean> {
  const row = await getThread(ctx, thread.id);
  if (!row || row.trashed || row.removed) return false;
  // A blocked sender writing in changes nothing a person sees: no wait ends, nothing comes back, nothing is due.
  if (await senderStatus(ctx, row.inboxId, message.from.email.toLowerCase()) === "blocked") return false;
  const date = dateOf(message, ctx.now());
  const state = await threadState(ctx, row);
  let next = state;
  if (row.comeBackAt !== null && row.comeBackAt > ctx.now() && row.comeBackIfNoReply
    && row.comeBackSetAt !== null && date > row.comeBackSetAt) {
    next = { ...next, ...NO_COME_BACK };
  }
  if (row.done && date > lastBefore) next = { ...next, done: false };
  const changed = (["done", "comeBack"] as Group[]).filter((group) => !sameIn([group], state, next));
  if (changed.length) {
    await saveThreadState(ctx, row.id, next);
    await retireUndo(ctx, [row.id], changed);
  }
  // A thread that skipped Screening while its sender isn't let in is never asked again: the AI may only move it to
  // `conversation`, and that would put a stranger's mail in Home.
  const recategorize = ((row.category === "unknown" && row.categorizedBy === null)
    || (row.categorizedBy === "ai" && row.category !== "conversation" && row.category !== "unknown"))
    && !await skippedWhileUnknown(ctx, row);
  const summarize = row.category !== "otp";
  if (!recategorize && !summarize) return false;
  await ctx.db.update(threads).set({
    ...(recategorize && { categoryDue: true }),
    ...(summarize && { summaryDue: true }),
  }).where(eq(threads.id, row.id));
  return !next.done;
}
