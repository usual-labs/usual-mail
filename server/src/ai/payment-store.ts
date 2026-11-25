// The payment details' rules that read other rows (docs/contract-ai.md, "Payment details"): one name for one sender's
// receipts and invoices, a sender being a domain (its registrable domain when the server carries the Public Suffix
// List), and, once per store, the latest rules applied to the details already stored. No model is asked. Callers hold
// the lock.

import { isPublicMailDomain, isSharedPlatform, PAYMENT_CATEGORIES, type PaymentDetails } from "@usualmail/core";
import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { messages, threads, type ThreadRow } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { emitThread, getThread } from "../service/store.ts";
import { checkDueDate, type DatedText } from "./payment-dates.ts";
import { canonicalParty, cutDisplayText, isOneLowercaseWord, orSenderName, partyName, samePartyForm } from "./payment-party.ts";
import { isPaymentService } from "./payment-services.ts";
import type { SuffixList } from "../avatars/suffixes.ts";
import { hadRulePass, PAYMENT_RULES } from "./passes.ts";
import { senderParty } from "./payment.ts";
import { loadState, saveState } from "./state.ts";
import { modelText } from "./text.ts";

/** This build's once-only pass over the stored details; its id and the order of the passes are in passes.ts. */
export { PAYMENT_RULES } from "./passes.ts";

/**
 * Which senders share one name: the domain after the @, or its registrable domain when the server carries the Public
 * Suffix List (the sender pictures' list); the whole address at a free mailbox or a shared platform, whose senders are
 * people or customers, not one brand (the sender pictures' lists of those); null for a payment service, whose
 * party is a different shop each time.
 */
export function senderKey(address: string, suffixes: SuffixList | null): string | null {
  if (isPaymentService(address)) return null;
  const lower = address.toLowerCase();
  const domain = lower.split("@")[1] ?? "";
  if (!domain) return lower;
  const registrable = suffixes?.registrableDomain(domain) ?? null;
  if (isPublicMailDomain(registrable ?? domain) || isSharedPlatform(domain)) return lower;
  return registrable ?? domain;
}

/** Writes a thread's details alone (its summary stays), with a new version and a `thread.changed`. */
async function savePayment(ctx: Ctx, threadId: string, payment: PaymentDetails): Promise<void> {
  await ctx.db.update(threads).set({ payment, version: sql`${threads.version} + 1` }).where(eq(threads.id, threadId));
  const row = await getThread(ctx, threadId);
  if (row) emitThread(ctx, row);
}

/** The inbox's other receipts and invoices with details whose sender has this key, oldest first. */
async function sameSender(ctx: Ctx, thread: Pick<ThreadRow, "id" | "inboxId">, key: string, suffixes: SuffixList | null): Promise<ThreadRow[]> {
  const rows = await ctx.db.select().from(threads).where(and(
    eq(threads.inboxId, thread.inboxId),
    isNotNull(threads.sender),
    ne(threads.id, thread.id),
    inArray(threads.category, [...PAYMENT_CATEGORIES]),
    isNotNull(threads.payment),
    eq(threads.removed, false),
  )).orderBy(asc(threads.lastMessageAt), asc(threads.id));
  return rows.filter((row) => senderKey(row.sender!, suffixes) === key);
}

/**
 * One name for one sender: a thread's party takes the form the same sender's (`senderKey`) other receipts and invoices
 * in the same inbox share with it (`samePartyForm`), and theirs take that form too, each with a `thread.changed`.
 * Never across senders, and never for a payment service's mail. Returns the details with the party to keep, and how
 * many other threads changed.
 */
export async function oneNamePerSender(ctx: Ctx, thread: Pick<ThreadRow, "id" | "inboxId" | "sender">, payment: PaymentDetails): Promise<{ payment: PaymentDetails; others: number }> {
  const suffixes = ctx.avatars?.suffixes ?? null;
  const key = thread.sender && senderKey(thread.sender, suffixes);
  if (!payment.party || !key) return { payment, others: 0 };
  const rows = await sameSender(ctx, thread, key, suffixes);
  const party = canonicalParty(payment.party, rows.map((row) => row.payment?.party).filter((name): name is string => Boolean(name)));
  let others = 0;
  for (const row of rows) {
    const theirs = row.payment!.party;
    if (theirs && theirs !== party && samePartyForm(theirs, party) === party) {
      await savePayment(ctx, row.id, { ...row.payment!, party });
      others++;
    }
  }
  return { payment: { ...payment, party }, others };
}

/** A thread's incoming messages a model may read, as text with their dates, and the subject with the first one's. */
async function datedTexts(ctx: Ctx, thread: ThreadRow): Promise<{ text: string; sources: DatedText[]; senderName: string | null }> {
  const list = await ctx.db.select().from(messages)
    .where(and(eq(messages.threadId, thread.id), eq(messages.outgoing, false))).orderBy(asc(messages.date), asc(messages.id));
  const sources: DatedText[] = [{ text: thread.subject, at: list[0]?.date ?? 0 }, ...list.map((message) => ({ text: modelText(message.text, message.html), at: message.date }))];
  const name = list.at(-1)?.from.name;
  return { text: sources.map((source) => source.text).join("\n"), sources, senderName: name && !name.includes("@") ? senderParty(name) : null };
}

/**
 * Once per store, at a start: the last round's rules on the details already stored, by rule only. A due date that
 * lies before its message is read the other way round when that fits, else dropped (and none is kept on a receipt);
 * a party of display text is cut, or falls back to the sender's name, and so does one that is a single lowercase
 * word; then one name per sender. Each thread that
 * changes gets a new version and a `thread.changed`; only counts are logged. Returns them.
 */
export async function applyPaymentRulesOnce(ctx: Ctx, suffixes: SuffixList | null, id: string = PAYMENT_RULES): Promise<{ swapped: number; dropped: number; cleaned: number; named: number; unified: number }> {
  const counts = { swapped: 0, dropped: 0, cleaned: 0, named: 0, unified: 0 };
  if (hadRulePass((await loadState(ctx)).paymentRulesApplied, id)) return counts;
  const rows = await ctx.db.select().from(threads).where(and(
    inArray(threads.category, [...PAYMENT_CATEGORIES]),
    isNotNull(threads.payment),
    eq(threads.removed, false),
  )).orderBy(asc(threads.lastMessageAt), asc(threads.id));
  const fixed = new Map<string, PaymentDetails>();
  for (const row of rows) {
    const stored = row.payment!;
    let next = stored;
    if (stored.dueDate && row.category === "receipt") {
      next = { ...next, dueDate: null };
      counts.dropped++;
    } else if (stored.dueDate) {
      const { text, sources } = await datedTexts(ctx, row);
      const verdict = checkDueDate(stored.dueDate, text, sources);
      // Only what this rule is about: a date that is no longer written in the mail as given is left alone.
      if ("dueDate" in verdict && verdict.swapped) {
        next = { ...next, dueDate: verdict.dueDate };
        counts.swapped++;
      } else if ("dropped" in verdict && verdict.dropped === "before_message") {
        next = { ...next, dueDate: null };
        counts.dropped++;
      }
    }
    if (stored.party) {
      const cut = cutDisplayText(stored.party);
      const name = cut && partyName(cut);
      if (name !== stored.party) {
        next = { ...next, party: name ?? (await datedTexts(ctx, row)).senderName };
        counts.cleaned++;
      }
      // One lowercase word (a district an earlier cut left): the sender's name, when there is one; else as it is.
      if (next.party && isOneLowercaseWord(next.party)) {
        const named = orSenderName(next.party, (await datedTexts(ctx, row)).senderName);
        if (named !== next.party) {
          next = { ...next, party: named };
          counts.named++;
        }
      }
    }
    fixed.set(row.id, next);
  }
  // One name per sender, among the threads as they now stand.
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const sender = row.sender && senderKey(row.sender, suffixes);
    if (!sender) continue;
    const key = `${row.inboxId}\u0000${sender}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    const names = group.map((row) => fixed.get(row.id)!.party).filter((name): name is string => Boolean(name));
    if (names.length < 2) continue;
    const party = canonicalParty(names[0]!, names.slice(1));
    for (const row of group) {
      const theirs = fixed.get(row.id)!.party;
      if (theirs && theirs !== party && samePartyForm(theirs, party) === party) {
        fixed.set(row.id, { ...fixed.get(row.id)!, party });
        counts.unified++;
      }
    }
  }
  for (const row of rows) {
    const next = fixed.get(row.id)!;
    if (JSON.stringify(next) !== JSON.stringify(row.payment)) await savePayment(ctx, row.id, next);
  }
  await saveState(ctx, { paymentRulesApplied: id });
  if (Object.values(counts).some((count) => count > 0)) {
    ctx.host.log.info(`Payment details by rule: ${counts.swapped} due dates read the other way round, ${counts.dropped} dropped, `
      + `${counts.cleaned} parties cleaned, ${counts.named} one-word parties named, ${counts.unified} unified`);
  }
  return counts;
}
