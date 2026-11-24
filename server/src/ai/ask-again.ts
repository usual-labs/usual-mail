// Asking the AI again, once, about categories it chose itself under words that have since changed (docs/contract-ai.md,
// "What the AI processes, and when"; the decisions of 2026-11-19, after two audits of the AI's labels on the owner's
// mail). At a start, before the AI's queue runs, once per `AskAgain.id`: every thread the server's AI filed in one of
// the plan's categories, or in one of its `ifStubText` categories when the message the AI reads has a stub text part
// (text.ts), or in one of its `ifNeverWrittenIn` categories when the mailbox never wrote in it (no message the provider
// or the server says the mailbox sent), that isn't done, trashed or gone and holds incoming mail is due a category
// again and marked `categoryAskAgain`, so its next categorize may take any of the six answers (process.ts), even out
// of `conversation` when the plan names it. The answer then takes the normal path: applied through the action engine
// as the AI's (recorded silently, written back, undoable), or left where it is when it is the same or dropped.
// Nothing a person, a rule, an agent or the mailbox decided is marked.

import { PAYMENT_CATEGORIES, type DecidedCategory } from "@usualmail/core";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { messages, threads } from "../db/index.ts";
import { inList } from "../db/params.ts";
import type { Ctx } from "../service/context.ts";
import { incoming } from "./process.ts";
import { loadState, saveState } from "./state.ts";
import { isStubText } from "./text.ts";

/**
 * The start-up passes over what is stored, together: this module's, the payment rules' (`payment-store.ts`), the
 * snippets' (`service/snippets.ts`) and the notification groups' by moment (`event-regroup.ts`).
 */
export { applyPaymentRulesOnce } from "./payment-store.ts";
export { remakeSnippetsOnce } from "../service/snippets.ts";
export { regroupEventsOnce } from "./event-regroup.ts";
import { hasIncoming } from "./work.ts";

/** One asking-again: what marks it done in a store, and which of the AI's own filings it asks about. */
export interface AskAgain {
  /** Kept in `server_state.categories_asked_again` once done: a later start with the same id asks nothing. */
  id: string;
  /** The AI's filings in these categories are asked again. */
  categories: readonly DecidedCategory[];
  /** ... and in these only when the newest incoming message's text part is a stub of its HTML (`isStubText`), */
  ifStubText: readonly DecidedCategory[];
  /** ... and in these only when the mailbox never wrote in the thread (no `outgoing` message: evidence, not a From). */
  ifNeverWrittenIn: readonly DecidedCategory[];
}

/**
 * This build's, the second of 2026-11-19 (the first, "2026-11-19 sorting words", asked the AI's receipts, invoices and
 * notifications and its newsletters read from a stub): the AI's receipts and notifications again, for the receipt's
 * new sentence and the nudges rule, and, by the owner's explicit exception for this one-off only, its conversations
 * nobody in the mailbox wrote in. The one place its scope is set.
 */
export const ASK_AGAIN: AskAgain = {
  id: "2026-11-19 second round",
  categories: ["receipt", "notification"],
  ifStubText: [],
  ifNeverWrittenIn: ["conversation"],
};

/** Filed by the server's AI in one of the categories, not done, trashed or gone, with incoming mail a model may read. */
export function filedByAi(categories: readonly DecidedCategory[]): SQL {
  return and(
    eq(threads.categorizedBy, "ai"),
    inArray(threads.category, [...categories]),
    eq(threads.done, false),
    eq(threads.trashed, false),
    eq(threads.removed, false),
    hasIncoming(),
  )!;
}

/** The mailbox never wrote in the thread: no message in it is the mailbox's own (`outgoing`, from evidence only). */
export function neverWrittenIn(): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.threadId} = ${threads.id} AND ${messages.outgoing} = 1)`;
}

/**
 * At a start: marks the threads `plan` asks about, unless this store has had it. Returns how many. Under the lock.
 * Logs only the count, nothing of the mail.
 */
export async function askAgainOnce(ctx: Ctx, plan: AskAgain = ASK_AGAIN): Promise<number> {
  const row = await loadState(ctx);
  if (row.categoriesAskedAgain === plan.id) return 0;
  const ids = plan.categories.length === 0 ? [] : (await ctx.db.select({ id: threads.id }).from(threads).where(filedByAi(plan.categories))).map((thread) => thread.id);
  if (plan.ifStubText.length > 0) {
    const candidates = await ctx.db.select({ id: threads.id, inboxId: threads.inboxId }).from(threads).where(filedByAi(plan.ifStubText));
    for (const thread of candidates) {
      // The message the categorize job would read: the newest incoming one a model may see.
      const newest = (await incoming(ctx, thread)).at(-1);
      if (newest && isStubText(newest.text, newest.html)) ids.push(thread.id);
    }
  }
  if (plan.ifNeverWrittenIn.length > 0) {
    const quiet = await ctx.db.select({ id: threads.id }).from(threads).where(and(filedByAi(plan.ifNeverWrittenIn), neverWrittenIn()));
    ids.push(...quiet.map((thread) => thread.id));
  }
  const marked = [...new Set(ids)];
  for (let start = 0; start < marked.length; start += 500) {
    await ctx.db.update(threads).set({ categoryDue: true, categoryAskAgain: true }).where(inList(threads.id, marked.slice(start, start + 500)));
  }
  await saveState(ctx, { categoriesAskedAgain: plan.id });
  if (marked.length > 0) ctx.host.log.info(`The AI is asked again about the category of ${marked.length} threads it filed`);
  return marked.length;
}

/**
 * The asking-again of payment details: once per store, every receipt and invoice that isn't done, trashed or gone and
 * holds incoming mail is due its details again (`paymentAgain`), whoever filed it. The one place its id is set. This
 * build's (2026-11-19, the owner's payment state): the answer gives the state and fills only facts the thread has none
 * of (`fillDetails`). The one before it ("2026-11-19 payment wording") replaced the details whole.
 */
export const PAYMENT_AGAIN = "2026-11-19 payment state";

/**
 * The asking-again of notifications' references (2026-11-19, notification groups): once per store, every notification
 * that isn't done, trashed or gone and holds incoming mail is due its event again (`paymentAgain`), whoever filed it;
 * only the answer's reference is taken, and the thread's group worked out from it, or for an appointment from what is
 * stored; the event and summary it has stay (process.ts, event-group.ts). A thread with no event yet takes its answer
 * as any. The one place its id is set. The ones before it on this marker: "2026-11-19 event dates" (a status and no
 * moment, only filling) and "2026-11-19 event audit" (status and moment together).
 */
export const EVENT_AGAIN = "2026-11-19 event groups";

/**
 * The askings-again that share `server_state.details_asked_again`, in the order builds brought them: the store keeps
 * the last one it had, and has had every one before it.
 */
const DETAILS_AGAIN_ORDER: readonly string[] = [PAYMENT_AGAIN, "2026-11-19 event dates", "2026-11-19 event audit", EVENT_AGAIN];

/** Whether a store whose marker is `marker` has had the asking-again `id`. */
function hadAskingAgain(marker: string | null, id: string): boolean {
  if (marker === id) return true;
  const [had, asked] = [DETAILS_AGAIN_ORDER.indexOf(marker ?? ""), DETAILS_AGAIN_ORDER.indexOf(id)];
  return had >= 0 && asked >= 0 && had > asked;
}

/** At a start: marks the receipts and invoices `id` asks about again, unless this store has had it. Under the lock. */
export async function askDetailsAgainOnce(ctx: Ctx, id: string = PAYMENT_AGAIN): Promise<number> {
  const row = await loadState(ctx);
  if (hadAskingAgain(row.detailsAskedAgain, id)) return 0;
  const marked = await ctx.db.update(threads).set({ summaryDue: true, paymentAgain: true }).where(and(
    inArray(threads.category, [...PAYMENT_CATEGORIES]),
    eq(threads.done, false),
    eq(threads.trashed, false),
    eq(threads.removed, false),
    hasIncoming(),
  )).returning({ id: threads.id });
  await saveState(ctx, { detailsAskedAgain: id });
  if (marked.length > 0) ctx.host.log.info(`The AI is asked again about the payment details of ${marked.length} threads`);
  return marked.length;
}

/**
 * At a start, after `askDetailsAgainOnce`: marks the notifications `id` asks about again (`EVENT_AGAIN`), unless this
 * store has had it. Under the lock. Logs only the count.
 */
export async function askEventsAgainOnce(ctx: Ctx, id: string = EVENT_AGAIN): Promise<number> {
  const row = await loadState(ctx);
  if (hadAskingAgain(row.detailsAskedAgain, id)) return 0;
  const marked = await ctx.db.update(threads).set({ summaryDue: true, paymentAgain: true }).where(and(
    eq(threads.category, "notification"),
    eq(threads.done, false),
    eq(threads.trashed, false),
    eq(threads.removed, false),
    hasIncoming(),
  )).returning({ id: threads.id });
  await saveState(ctx, { detailsAskedAgain: id });
  if (marked.length > 0) ctx.host.log.info(`The AI is asked again about the events of ${marked.length} notifications`);
  return marked.length;
}
