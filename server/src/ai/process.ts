// Processing one thread with the server's AI (docs/contract-ai.md): categorize it if it needs it, then summarize it
// unless it is a one-time code. Each request is built under the lock, sent outside it, and its answer applied under
// the lock again, checked against the thread as it is by then. An answer the server doesn't accept is dropped and
// the thread isn't asked about again until incoming mail joins it; a dropped summary is logged with the thread's id
// and a reason code, never anything of the mail or the answer. The AI only categorizes (recorded, silently,
// through the action engine) and summarizes (not recorded); it never does anything else. Nothing a blocked sender
// wrote is ever sent: not their message, not the subject they gave a thread, in either job.

import { isScreeningPass, PAYMENT_CATEGORIES, SCREENING_PASS_CATEGORIES, type AiJob, type Category, type DecidedCategory, type PaymentDetails } from "@usualmail/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { messages, threads, type InboxRow, type MessageRow, type ThreadRow } from "../db/index.ts";
import { perform } from "../service/actions.ts";
import type { Ctx } from "../service/context.ts";
import { blockedSenders, emitThread, getInbox, getThread, saveThreadState, skippedWhileUnknown, threadState } from "../service/store.ts";
import { gateCheck, type GateCheck } from "./gate.ts";
import { acceptPass, passRequest } from "./pass-prompt.ts";
import { AiServiceError, type AiAnswer, type AiModels, type AiObjectAnswer, type ChoiceRequest, type ObjectRequest, type TextRequest } from "./models.ts";
import { checkEvent, combineEvent, type EventChange } from "./event.ts";
import { saveEvent, withGroup } from "./event-group.ts";
import { oneNamePerSender } from "./payment-store.ts";
import { serverTimeZone } from "./payment-dates.ts";
import { checkDetails, combineDetails, fillDetails, senderParty, servedPayment, settleDetails, type DatedText } from "./payment.ts";
import { acceptCategory, acceptSummary, boundaryId, categorizeRequest, detailsRequest, eventRequest, summarizeRequest, summarizeSender, type CategorizeInput, type SummarizeMessage } from "./prompt.ts";
import { effectiveModels, loadState } from "./state.ts";
import { recordAnswer, recordFailure } from "./status.ts";
import { recordUsage } from "./usage.ts";

export type Outcome = "done" | "failed";

/** What the queue opens models with. */
export type OpenModels = () => Promise<AiModels | null>;

/** The thread side of "may process", for a thread already loaded. Every inbox's mail is processed alike. */
export function processableNow(thread: ThreadRow, _inbox: InboxRow): boolean {
  return !thread.done && !thread.trashed && !thread.removed;
}

/**
 * Needs categorizing: nobody decided it, or the AI filed it elsewhere than `conversation` and mail joined since, or it
 * is asked again (ask-again.ts; a conversation only then, and only if an asking-again names it).
 */
export function wantsCategoryNow(thread: ThreadRow): boolean {
  if (!thread.categoryDue) return false;
  if (thread.category === "unknown") return thread.categorizedBy === null;
  return thread.categorizedBy === "ai" && (thread.category !== "conversation" || thread.categoryAskAgain);
}

/** A receipt or an invoice: summarized as its payment details. */
export function isPayment(category: Category): boolean {
  return (PAYMENT_CATEGORIES as readonly Category[]).includes(category);
}

/**
 * Needs a summary (for a receipt or an invoice, its details; for a notification, its summary and event): mail joined
 * since, or a receipt or a notification has none yet.
 */
export function wantsSummaryNow(thread: ThreadRow): boolean {
  return (thread.summaryDue && thread.category !== "otp") || (isPayment(thread.category) && thread.payment === null)
    || (thread.category === "notification" && thread.event === null);
}

/** Whether a message may go to a model: the mailbox's own, or from a sender who isn't blocked now. */
function sendable(blocked: Set<string>): (message: MessageRow) => boolean {
  return (message) => message.outgoing || !blocked.has(message.from.email.toLowerCase());
}

/** The thread's messages a model may see, oldest first: none from a sender blocked now. */
async function sendableMessages(ctx: Ctx, thread: Pick<ThreadRow, "id" | "inboxId">): Promise<MessageRow[]> {
  const all = await ctx.db.select().from(messages).where(eq(messages.threadId, thread.id)).orderBy(asc(messages.date), asc(messages.id));
  return all.filter(sendable(await blockedSenders(ctx, thread.inboxId)));
}

/** Incoming mail a model may see, oldest first. */
export async function incoming(ctx: Ctx, thread: Pick<ThreadRow, "id" | "inboxId">): Promise<MessageRow[]> {
  return (await sendableMessages(ctx, thread)).filter((message) => !message.outgoing);
}

/**
 * The subject a request carries: the thread's, unless a blocked sender wrote the message it comes from (the thread's
 * oldest); then the subject of the oldest message that may be sent. `sent` is every message that may be sent.
 */
async function subjectToSend(ctx: Ctx, thread: ThreadRow, sent: MessageRow[]): Promise<string> {
  const oldest = await ctx.db.select().from(messages).where(eq(messages.threadId, thread.id)).orderBy(asc(messages.date), asc(messages.id)).limit(1).get();
  if (!oldest || sent.some((message) => message.id === oldest.id)) return thread.subject;
  return sent[0]?.subject ?? "";
}

/**
 * The screening gate no longer waits for the AI: the thread is written back where it now belongs. Under the lock.
 */
export async function releaseGate(ctx: Ctx, threadId: string): Promise<void> {
  const row = await getThread(ctx, threadId);
  if (!row?.gatePending) return;
  await ctx.db.update(threads).set({ gatePending: false }).where(eq(threads.id, threadId));
  ctx.hooks.writeBack({ inboxId: row.inboxId, threadIds: [threadId], recordIds: [] });
}

/** Clears what the AI was asked about, unless incoming mail joined the thread since the request was built. */
async function clearDue(ctx: Ctx, threadId: string, job: AiJob, newestId: string): Promise<void> {
  const thread = await getThread(ctx, threadId);
  if (!thread) return;
  const newest = (await incoming(ctx, thread)).at(-1);
  if (newest?.id !== newestId) return;
  await ctx.db.update(threads).set(job === "categorize" ? { categoryDue: false } : { summaryDue: false }).where(eq(threads.id, threadId));
}

interface Planned<R> {
  request: R;
  newestId: string;
  model: string;
}

/** Processes one thread: categorize, then summarize. "failed" when the service couldn't be used. */
export async function processThread(ctx: Ctx, threadId: string, open: OpenModels): Promise<Outcome> {
  const models = await open();
  if (!models) {
    await ctx.lock.run(() => releaseGate(ctx, threadId));
    return "failed";
  }
  const categorize = await ctx.lock.run(() => planCategorize(ctx, threadId));
  if (categorize) {
    let answer: AiAnswer;
    try {
      answer = await models.choose(categorize.request);
    } catch (error) {
      await recordUsage(ctx, "categorize", categorize.model, { failed: true });
      return failed(ctx, threadId, error, "categorize");
    }
    // Every request counts, whatever the server then makes of the answer.
    await recordUsage(ctx, "categorize", categorize.model, { usage: answer.usage, generation: answer.generation ?? null });
    // At the screening gate, which kind of mail it is is asked once more, only when the server's own check could let
    // it through; the thread is written back once, with both answers.
    const question = await ctx.lock.run(() => planPass(ctx, threadId, categorize, answer.value));
    let asked: Asked | null = null;
    if (question) {
      try {
        const passAnswer = await models.choose(question);
        await recordUsage(ctx, "categorize", categorize.model, { usage: passAnswer.usage, generation: passAnswer.generation ?? null });
        asked = { request: question, value: passAnswer.value };
      } catch (error) {
        // The category stands, screened; the service's failure counts as any other.
        await recordUsage(ctx, "categorize", categorize.model, { failed: true });
        await ctx.lock.run(() => applyCategory(ctx, threadId, categorize, answer.value, null));
        return failed(ctx, threadId, error, "categorize");
      }
    }
    await ctx.lock.run(() => applyCategory(ctx, threadId, categorize, answer.value, asked));
  } else {
    await ctx.lock.run(() => releaseGate(ctx, threadId));
  }
  const summarize = await ctx.lock.run(() => planSummarize(ctx, threadId));
  if (!summarize) return "done";
  // A receipt's or an invoice's details are the summarize job too: its model, its usage, its status.
  let answer: AiAnswer | AiObjectAnswer;
  try {
    answer = "given" in summarize ? await models.extract(summarize.request) : await models.write(summarize.request);
  } catch (error) {
    await recordUsage(ctx, "summarize", summarize.model, { failed: true });
    return failed(ctx, threadId, error, "summarize");
  }
  await recordUsage(ctx, "summarize", summarize.model, { usage: answer.usage, generation: answer.generation ?? null });
  const value = answer.value;
  await ctx.lock.run(() => !("given" in summarize)
    ? applySummary(ctx, threadId, summarize, typeof value === "string" ? value : null)
    : summarize.kind === "event" ? applyEvent(ctx, threadId, summarize, value) : applyDetails(ctx, threadId, summarize, value));
  return "done";
}

async function failed(ctx: Ctx, threadId: string, error: unknown, job: AiJob): Promise<Outcome> {
  // Only a service error's own message is kept: never the error object, which may hold what was sent.
  const known = error instanceof AiServiceError ? error : new AiServiceError("unavailable", "The AI request failed in an unexpected way.");
  await ctx.lock.run(async () => {
    await recordFailure(ctx, known, job);
    await releaseGate(ctx, threadId);
  });
  return "failed";
}

async function loaded(ctx: Ctx, threadId: string): Promise<{ thread: ThreadRow; inbox: InboxRow; mail: MessageRow[] } | null> {
  const thread = await getThread(ctx, threadId);
  const inbox = thread && await getInbox(ctx, thread.inboxId);
  if (!thread || !inbox || !processableNow(thread, inbox)) return null;
  const mail = await incoming(ctx, thread);
  return mail.length ? { thread, inbox, mail } : null;
}

/** A categorize request, with what it carried (the screening gate's question carries the same). */
type PlannedCategory = Planned<ChoiceRequest> & { onlyConversation: boolean; input: CategorizeInput };

/** The screening gate's question as sent, and the model's answer. */
interface Asked {
  request: ChoiceRequest;
  value: string | null;
}

async function planCategorize(ctx: Ctx, threadId: string): Promise<PlannedCategory | null> {
  const found = await loaded(ctx, threadId);
  if (!found || !wantsCategoryNow(found.thread)) return null;
  const model = effectiveModels(ctx, await loadState(ctx))?.categorize;
  if (!model) return null;
  const newest = found.mail.at(-1)!;
  const input: CategorizeInput = {
    subject: await subjectToSend(ctx, found.thread, await sendableMessages(ctx, found.thread)),
    from: newest.from,
    listId: newest.listId,
    automated: newest.automated,
    text: newest.text,
    html: newest.html,
  };
  const request = categorizeRequest(model, input, boundaryId(ctx.host.random.bytes(9)));
  // A thread the AI filed elsewhere may only be moved to `conversation` (docs/contract-ai.md), unless it is asked
  // again about it, once, under today's words (ask-again.ts), or the gate holds it to judge its newest message again
  // (a stranger wrote into a thread that skipped Screening: sync/sorting.ts).
  const onlyConversation = found.thread.categorizedBy === "ai" && !found.thread.categoryAskAgain && !judging(found.thread);
  return { request, newestId: newest.id, model, onlyConversation, input };
}

/** At the sender's screening gate: screened because its sender isn't let in, not filed under Screening by the mailbox. */
function atGate(thread: ThreadRow): boolean {
  return thread.screened && !thread.screenedByMailbox;
}

/**
 * The gate holds the thread for the AI's answer (`gatePending`): new mail from a stranger, kept unwritten. Only then may
 * the answer let it skip Screening, so a thread is written back once, never under Screening and out again: mail that
 * arrived while the AI was off, paused or failing, or whose answer failed, stays screened.
 */
function judging(thread: ThreadRow): boolean {
  return atGate(thread) && thread.gatePending;
}

/**
 * The server's own check on the message the model read, when it may let the thread skip Screening: the gate is judging
 * the thread, and that message is still its newest incoming one (mail that joined meanwhile isn't judged by it). It
 * reads the subject the model read (the thread's, `subjectToSend`), not that message's own (the final security review
 * of 2026-11-26).
 */
function checkAtGate(ctx: Ctx, found: { thread: ThreadRow; inbox: InboxRow; mail: MessageRow[] }, planned: PlannedCategory): GateCheck | null {
  const read = found.mail.at(-1);
  if (!judging(found.thread) || read?.id !== planned.newestId) return null;
  return gateCheck({ ...read, subject: planned.input.subject }, { suffixes: ctx.avatars?.suffixes ?? null, inbox: found.inbox });
}

/** Whether a category may be the thread's: any, unless it skipped Screening while its sender isn't let in. */
async function fitsItsKind(ctx: Ctx, thread: ThreadRow, category: DecidedCategory): Promise<boolean> {
  if (!await skippedWhileUnknown(ctx, thread)) return true;
  return isScreeningPass(thread.skippedScreening) && SCREENING_PASS_CATEGORIES[thread.skippedScreening].includes(category);
}

/**
 * The screening gate's question, when it is worth asking: the gate is judging the thread, the AI's category may be a
 * kind that skips Screening, and the server's own check could hold for the message the model read (gate.ts). Under the
 * lock.
 */
async function planPass(ctx: Ctx, threadId: string, planned: PlannedCategory, answer: string | null): Promise<ChoiceRequest | null> {
  const accepted = acceptCategory(answer, planned.onlyConversation);
  const found = await loaded(ctx, threadId);
  if (!accepted || !found || !wantsCategoryNow(found.thread)) return null;
  if (!checkAtGate(ctx, found, planned)?.worthAsking(accepted)) return null;
  return passRequest(planned.model, planned.input, accepted, boundaryId(ctx.host.random.bytes(9)));
}

async function applyCategory(ctx: Ctx, threadId: string, planned: PlannedCategory, answer: string | null, asked: Asked | null): Promise<void> {
  await recordAnswer(ctx, true);
  const accepted: DecidedCategory | null = acceptCategory(answer, planned.onlyConversation);
  const found = await loaded(ctx, threadId);
  // Someone may have decided it meanwhile, or it may be done now: then the answer is moot. A thread that skipped
  // Screening while its sender isn't let in keeps to its kind's categories: never a conversation (a stranger's mail in
  // Home), never an invoice, whoever asks again.
  if (accepted && found && wantsCategoryNow(found.thread) && await fitsItsKind(ctx, found.thread, accepted)) {
    // A model's answer alone never lifts the screening gate: the server's own check must hold for the message it read,
    // for the kind the model named (or for a code, the AI's `otp`). Otherwise it stays screened, in this category.
    const chosen = asked ? acceptPass(asked.value, asked.request) : null;
    const pass = checkAtGate(ctx, found, planned)?.pass(accepted, chosen) ?? null;
    await perform(ctx, {
      inbox: found.inbox,
      thread: found.thread,
      action: { kind: "categorize", category: accepted },
      actor: { kind: "ai", job: "categorize", model: planned.model },
      ...(atGate(found.thread) && { gate: { pass } }),
    });
  }
  // Asked again once: from now on only mail joining asks, as for any thread the AI filed.
  await ctx.db.update(threads).set({ categoryAskAgain: false }).where(and(eq(threads.id, threadId), eq(threads.categoryAskAgain, true)));
  await clearDue(ctx, threadId, "categorize", planned.newestId);
  await releaseGate(ctx, threadId);
}

/**
 * A details or event request, with the text the model was given, the sender's name as a party (for details, the
 * party to fall back on; for an event, what `about` must not be alone) and the time zone its messages' days were
 * stated in (for an event's time said "today").
 */
type PlannedDetails = Planned<ObjectRequest> & { kind: "details" | "event"; given: string; sources: DatedText[]; senderName: string | null; timeZone: string };

async function planSummarize(ctx: Ctx, threadId: string): Promise<Planned<TextRequest> | PlannedDetails | null> {
  const found = await loaded(ctx, threadId);
  if (!found || !wantsSummaryNow(found.thread)) return null;
  const model = effectiveModels(ctx, await loadState(ctx))?.summarize;
  if (!model) return null;
  const sent = await sendableMessages(ctx, found.thread);
  const newestFirst: SummarizeMessage[] = [...sent].reverse().map((message) => ({
    fromName: summarizeSender(message.from, message.outgoing),
    text: message.text,
    html: message.html,
    at: message.date,
  }));
  const subject = await subjectToSend(ctx, found.thread, sent);
  const id = boundaryId(ctx.host.random.bytes(9));
  // Each message goes with the day it was sent where the server runs (docs/contract-ai.md, "What leaves the server").
  const timeZone = serverTimeZone(ctx.host.timeZone);
  const newest = found.mail.at(-1)!;
  // The sender's name as the summarize job names them, never an address, cleaned as a party.
  const name = summarizeSender(newest.from, false);
  const senderName = name === summarizeSender({}, false) ? null : senderParty(name);
  if (isPayment(found.thread.category)) {
    const { request, given, sources } = detailsRequest(model, subject, newestFirst, id, found.thread.category, sent[0]?.date ?? 0, timeZone);
    return { kind: "details", request, given, sources, newestId: newest.id, model, senderName, timeZone };
  }
  if (found.thread.category === "notification") {
    const { request, given, sources } = eventRequest(model, subject, newestFirst, id, sent[0]?.date ?? 0, timeZone);
    return { kind: "event", request, given, sources, newestId: newest.id, model, senderName, timeZone };
  }
  return { request: summarizeRequest(model, subject, newestFirst, id, timeZone), newestId: newest.id, model };
}

/**
 * A receipt's or an invoice's details: each fact the model gave is checked against the text it was given (a dropped
 * one is logged with its field and a reason code, never content), combined with what the thread had, and saved with
 * `what` as the summary. Even an unusable answer saves details (the sender's name, if any), so the thread isn't asked
 * again until mail joins it. Under the lock.
 */
async function applyDetails(ctx: Ctx, threadId: string, planned: PlannedDetails, value: unknown): Promise<void> {
  await recordAnswer(ctx, true);
  const found = await loaded(ctx, threadId);
  const { checked, drops, swapped } = checkDetails(value, planned.given, found?.thread.category, planned.sources);
  for (const drop of drops) ctx.host.log.info(`AI details for ${threadId} dropped ${drop.field}: ${drop.reason}`);
  if (swapped) ctx.host.log.info(`AI details for ${threadId} read the due date's day and month the other way round`);
  if (found && wantsSummaryNow(found.thread) && isPayment(found.thread.category)) {
    const kept = servedPayment(found.thread.payment);
    const unusable = drops.some((drop) => drop.field === "answer");
    // Asked once more for the state (`paymentAgain`): its state, and only facts the thread had none of; an unusable
    // answer keeps what it had. Otherwise the answer's facts win and the rest stay (`combineDetails`).
    const next = found.thread.paymentAgain
      ? unusable && kept ? kept : fillDetails(kept, combineDetails(null, checked, planned.senderName))
      : combineDetails(kept, checked, planned.senderName);
    // A refund is paid, and nothing paid carries a date; then one name for one sender (theirs follow, with events).
    const { payment } = await oneNamePerSender(ctx, found.thread, settleDetails(next, found.thread.category));
    const saved = await saveDetails(ctx, found.thread, payment);
    if (saved.version !== found.thread.version) emitThread(ctx, saved);
  }
  await askedAgain(ctx, threadId);
  // A thread that left receipts and invoices meanwhile now needs a summary: that stays due.
  if (!found || isPayment(found.thread.category)) await clearDue(ctx, threadId, "summarize", planned.newestId);
}

/**
 * A notification's summary and event: each fact checked against the text the model was given (a dropped one logged
 * with its field and a reason code, never content), the event combined with what the thread had (`combineEvent`:
 * status and moment together), the summary replaced only when the answer gives one, and the thread's group worked
 * out (`saveEvent`, event-group.ts). Asked once more for its reference (`paymentAgain`, ask-again.ts): only the
 * reference is taken, and the event and summary it has stay. An unusable answer still leaves an event (all of it null
 * when there was none), so the thread isn't asked again until mail joins it. Under the lock.
 */
async function applyEvent(ctx: Ctx, threadId: string, planned: PlannedDetails, value: unknown): Promise<void> {
  await recordAnswer(ctx, true);
  const found = await loaded(ctx, threadId);
  const { summary, event, reference, drops, swapped, changes } = checkEvent(value, planned.given, planned.sources, planned.senderName, planned.timeZone);
  for (const drop of drops) ctx.host.log.info(`AI event for ${threadId} dropped ${drop.field}: ${drop.reason}`);
  if (swapped) ctx.host.log.info(`AI event for ${threadId} read the date's day and month the other way round`);
  for (const change of changes) ctx.host.log.info(`AI event for ${threadId} ${CHANGED[change]}`);
  if (found && wantsSummaryNow(found.thread) && found.thread.category === "notification") {
    const thread = found.thread;
    const unusable = drops.some((drop) => drop.field === "answer");
    const stored = thread.event && withGroup(thread.event, null);
    // Asked once more for its reference alone (ask-again.ts): the event and summary it has stay as they are.
    const onlyReference = thread.paymentAgain && stored !== null;
    const next = onlyReference || (unusable && stored) ? stored! : combineEvent(stored, event);
    await saveEvent(ctx, thread, next, onlyReference ? thread.summary : summary ?? thread.summary, reference);
  }
  await askedAgain(ctx, threadId);
  // A thread that left `notification` meanwhile now needs a summary: that stays due.
  if (!found || found.thread.category === "notification") await clearDue(ctx, threadId, "summarize", planned.newestId);
}

/** How a change the server made to an event is logged: its code's words, never content. */
const CHANGED: Record<EventChange, string> = {
  dated: "took its date from the day its message was sent",
  relative_word: "took a relative word out of the status",
  arriving: "named a dispatch with a later date Arriving",
  from_utc: "converted a time marked UTC to the server's time zone",
};

/** Asked again once (ask-again.ts), whatever came of it: from now on mail joining asks as before. */
async function askedAgain(ctx: Ctx, threadId: string): Promise<void> {
  await ctx.db.update(threads).set({ paymentAgain: false }).where(and(eq(threads.id, threadId), eq(threads.paymentAgain, true)));
}

/** The details and their `what` as the summary, with a new version when either changed. */
async function saveDetails(ctx: Ctx, thread: ThreadRow, payment: PaymentDetails): Promise<ThreadRow> {
  const summary = payment.what;
  if (JSON.stringify(thread.payment) === JSON.stringify(payment) && thread.summary === summary) return thread;
  await ctx.db.update(threads).set({ payment, summary, version: sql`${threads.version} + 1` }).where(eq(threads.id, thread.id));
  return (await getThread(ctx, thread.id))!;
}

async function applySummary(ctx: Ctx, threadId: string, planned: Planned<TextRequest>, text: string | null): Promise<void> {
  await recordAnswer(ctx, true);
  const verdict = acceptSummary(text);
  // Only the thread's id and the reason: never the answer, the mail, a name or an address.
  if ("dropped" in verdict) ctx.host.log.info(`AI summary for ${threadId} dropped: ${verdict.dropped}`);
  const found = await loaded(ctx, threadId);
  if ("summary" in verdict && found && wantsSummaryNow(found.thread)) {
    const saved = await saveThreadState(ctx, threadId, { ...await threadState(ctx, found.thread), summary: verdict.summary });
    if (saved.version !== found.thread.version) emitThread(ctx, saved);
  }
  await askedAgain(ctx, threadId);
  await clearDue(ctx, threadId, "summarize", planned.newestId);
}
