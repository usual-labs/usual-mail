// Which threads the AI has work on and may process (docs/contract-ai.md, "What the AI processes, and when"), as SQL
// the queue, the status and the triage queue share.

import { PAYMENT_CATEGORIES } from "@usualmail/core";
import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { messages, senders, threads } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { loadState } from "./state.ts";

/**
 * Needs categorizing: nobody has decided it, or the AI filed it in a category other than `conversation` and incoming
 * mail has joined it since or it is asked again (`categoryDue`). A thread in `conversation` is never categorized again
 * by the AI, except once when an asking-again marks it (ask-again.ts; this build's marks those the mailbox never
 * wrote in, by the owner's exception of 2026-11-19).
 */
export function wantsCategory(): SQL {
  return and(
    eq(threads.categoryDue, true),
    or(
      and(eq(threads.category, "unknown"), isNull(threads.categorizedBy)),
      and(eq(threads.categorizedBy, "ai"), ne(threads.category, "unknown"), or(ne(threads.category, "conversation"), eq(threads.categoryAskAgain, true))),
    ),
  )!;
}

/**
 * Needs a summary: it has none or incoming mail joined since (`summaryDue`), and it isn't a one-time code; or it is a
 * receipt or an invoice without its payment details yet, whoever filed it.
 */
export function wantsSummary(): SQL {
  return or(
    and(eq(threads.summaryDue, true), ne(threads.category, "otp")),
    and(inArray(threads.category, [...PAYMENT_CATEGORIES]), isNull(threads.payment)),
    and(eq(threads.category, "notification"), isNull(threads.event)),
  )!;
}

/** It holds mail someone sent the inbox, not only the mailbox's own, from a sender who isn't blocked. */
export function hasIncoming(): SQL {
  return sql`exists (SELECT 1 FROM ${messages} WHERE ${messages.threadId} = ${threads.id} AND ${messages.outgoing} = 0
    AND NOT EXISTS (SELECT 1 FROM ${senders} WHERE ${senders.inboxId} = ${messages.inboxId}
      AND ${senders.email} = lower(json_extract(${messages.from}, '$.email')) AND ${senders.status} = 'blocked'))`;
}

/** The thread side of "may process": not done, not trashed, still at the provider, with mail someone sent the inbox. */
export function processable(): SQL {
  return and(eq(threads.done, false), eq(threads.trashed, false), eq(threads.removed, false), hasIncoming())!;
}

/** Work the AI would do now, in every inbox: once a key is set, every inbox's mail is processed. */
export function work(): SQL {
  return and(processable(), or(wantsCategory(), wantsSummary()))!;
}

/**
 * `pending`: threads that need a category or a summary and that the AI would process if it worked now: every synced
 * thread that isn't done (the owner's decision of 2026-11-18: history is all synced mail). Counted whatever the AI's
 * state.
 */
export async function pendingWork(ctx: Ctx): Promise<{ pending: number }> {
  const row = await loadState(ctx);
  // Without a key no mail goes anywhere, so nothing waits for the AI.
  if (row.aiCredentials === null) return { pending: 0 };
  const counted = await ctx.db.select({ pending: sql<number>`count(*)` }).from(threads).where(work()).get();
  return { pending: counted?.pending ?? 0 };
}

/** History to process: every synced thread with work, newest first by each thread's newest message. A few at a time. */
export async function historyBatch(ctx: Ctx, limit = 20): Promise<Array<{ id: string }>> {
  return ctx.db.select({ id: threads.id }).from(threads)
    .where(work())
    .orderBy(desc(threads.lastMessageAt), desc(threads.id)).limit(limit);
}

/**
 * Why the AI won't process an undecided thread, as SQL for the triage queue: the AI isn't working (every undecided
 * thread then qualifies), or the AI's answer for it was dropped and no mail has joined since.
 */
export function aiWontDecide(working: boolean): SQL | undefined {
  if (!working) return undefined;
  return eq(threads.categoryDue, false);
}
