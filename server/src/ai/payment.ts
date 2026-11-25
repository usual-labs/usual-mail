// The server's checks on what a model says about a receipt or an invoice (docs/contract-ai.md, "Payment details").
// Nothing the model says is kept unless the server can check it against the text the model was given: an amount only
// when the same number is written there, in its currency's ISO 4217 minor units with its ISO 4217 code; a due date
// only when it is a real date written there; the party and what it was for only as safe plain lines; a refund only on
// a receipt. A fact that fails is dropped with a reason code, never anything of the mail. Pure.

import { ADDRESS_STAND_IN, PAYMENT_PARTY_LIMIT, PAYMENT_STATES, PAYMENT_WHAT_LIMIT, type Category, type PaymentDetails, type PaymentState } from "@usualmail/core";
import { minorUnits } from "./currencies.ts";
import { checkDueDate, type DatedText } from "./payment-dates.ts";
import { cutDisplayText, orSenderName, partyName } from "./payment-party.ts";

export { dateWrittenIn, type DatedText } from "./payment-dates.ts";
export { canonicalParty, cutDisplayText, partyName, samePartyForm } from "./payment-party.ts";
import { acceptLine } from "./prompt.ts";

/** What the model is asked for, as it answers: the amount as written, its currency as it names it. */
export interface RawDetails {
  party: string | null;
  amount: string | null;
  currency: string | null;
  refund: boolean;
  state: string | null;
  dueDate: string | null;
  what: string | null;
}

/** A fact the server dropped, and why: a reason code only. */
export interface DetailsDrop {
  field: "answer" | "party" | "amount" | "state" | "dueDate" | "what";
  reason: string;
}

// ---- Amounts

/** Signs that name one currency only. "$", "¥" and "kr" name several, so they resolve to nothing. */
const SIGNS: Record<string, string> = {
  "€": "EUR", "euro": "EUR", "euros": "EUR", "£": "GBP", "₹": "INR", "₩": "KRW", "₺": "TRY", "₽": "RUB", "₪": "ILS",
  "₫": "VND", "฿": "THB", "₴": "UAH", "₦": "NGN", "₱": "PHP", "zł": "PLN", "kč": "CZK", "us$": "USD", "ca$": "CAD",
  "c$": "CAD", "a$": "AUD", "au$": "AUD", "chf": "CHF", "fr.": "CHF",
};
/** How a currency is written besides its code and English signs. */
const ALSO_WRITTEN: Record<string, string[]> = { EUR: ["euro", "euros"], PLN: ["zł"], CZK: ["kč"], SEK: ["kr"], NOK: ["kr"], DKK: ["kr"], CHF: ["fr."] };

/**
 * An ISO 4217 code with minor units (`currencies.ts`): the model's when it is one, else an unambiguous sign it gave,
 * else one in the amount as written; null for anything else, so its decimals are never guessed.
 */
export function resolveCurrency(currency: string | null, written: string | null): string | null {
  const named = currency?.trim().toLowerCase() ?? "";
  if (/^[a-z]{3}$/.test(named) && minorUnits(named.toUpperCase()) !== null) return named.toUpperCase();
  if (SIGNS[named]) return SIGNS[named]!;
  const inAmount = (written ?? "").toLowerCase();
  const code = /(?<![a-z])([a-z]{3})(?![a-z])/.exec(inAmount)?.[1]?.toUpperCase();
  if (code && minorUnits(code) !== null) return code;
  const sign = Object.keys(SIGNS).filter((key) => !/^[a-z]+$/.test(key)).find((key) => inAmount.includes(key));
  return sign ? SIGNS[sign]! : null;
}

/** How many minor units a listed currency has after the decimal point, as ISO 4217 gives them (EUR 2, JPY 0, KWD 3). */
export function exponentOf(currency: string): number {
  const units = minorUnits(currency);
  if (units === null) throw new Error("Not an ISO 4217 code with minor units");
  return units;
}

/**
 * An amount as written ("€1.234,56", "1,234.56 USD", "49,-") in minor units, or null when it can't be read for sure.
 * The last `.` or `,` is the decimal point when one or two digits follow it (three, for a currency with three
 * decimals); otherwise separators group thousands, and every group after the first must have three digits. Signs,
 * codes and a minus are ignored: a refund says so itself.
 */
export function parseAmount(written: string, exponent: number): number | null {
  const cleaned = written.replace(/[  '’]/g, " ").replace(/[^\d., ]/g, "").replace(/,-$|\.-$/, "").trim();
  const text = withoutEdgeSeparators(cleaned);
  if (!/\d/.test(text)) return null;
  const last = Math.max(text.lastIndexOf("."), text.lastIndexOf(","));
  const after = last >= 0 ? text.slice(last + 1) : "";
  const decimal = last >= 0 && /^\d+$/.test(after) && (after.length <= 2 || (after.length === 3 && exponent === 3));
  const whole = decimal ? text.slice(0, last) : text;
  const groups = whole.split(/[., ]/);
  if (groups.some((group) => !/^\d+$/.test(group))) return null;
  if (groups.length > 1 && (groups[0]!.length > 3 || groups.slice(1).some((group) => group.length !== 3))) return null;
  let fraction = decimal ? after : "";
  if (fraction.length > exponent) {
    if (!/^0+$/.test(fraction.slice(exponent))) return null;
    fraction = fraction.slice(0, exponent);
  }
  const minor = Number(groups.join("")) * 10 ** exponent + Number(fraction.padEnd(exponent, "0") || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

/** How a currency is written: its code, its English sign and narrow sign, and the words for it. Lower case. */
function markersOf(currency: string): string[] {
  const sign = (display: "symbol" | "narrowSymbol") => new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: display })
    .formatToParts(1).find((part) => part.type === "currency")?.value.toLowerCase();
  return [...new Set([currency.toLowerCase(), sign("symbol"), sign("narrowSymbol"), ...(ALSO_WRITTEN[currency] ?? [])])]
    .filter((marker): marker is string => Boolean(marker));
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A currency marker, as a word when it is letters. */
function markerPattern(marker: string): string {
  return /^[a-z.]+$/.test(marker) ? `(?<![a-z])${escape(marker)}(?![a-z])` : escape(marker);
}

/** Whether the currency's code, sign or name stands anywhere in the text. */
export function currencyIn(currency: string, text: string): boolean {
  const lower = text.toLowerCase();
  return markersOf(currency).some((marker) => new RegExp(markerPattern(marker)).test(lower));
}

/**
 * The text without the separators (".", "," and spaces) it starts or ends with, as `/^[., ]+|[., ]+$/g` takes them out,
 * in linear time: that pattern reads from every separator of a long run inside the text to the run's end (0.1.3).
 */
function withoutEdgeSeparators(text: string): string {
  const separator = (at: number) => text[at] === "." || text[at] === "," || text[at] === " ";
  let start = 0;
  let end = text.length;
  while (start < end && separator(start)) start++;
  while (end > start && separator(end - 1)) end--;
  return text.slice(start, end);
}

/**
 * Whether the amount is written in the text, standing alone (no digit, and no separator with a digit, right before or
 * after it). Forms: the whole part plain or grouped by `,` `.` space `'` or `’`, then `.` or `,` and its minor digits,
 * trailing zeros may be left out ("1,240.00", "1.240,00", "1 240,00", "18.6" for 18.60), or a dash for none ("49,-"). A whole amount may also be written without
 * decimals ("49", "1,240"), but only right next to its currency's code, sign or name ("€49", "49 EUR").
 */
export function writtenIn(minor: number, currency: string, text: string): boolean {
  const exponent = exponentOf(currency);
  const scale = 10 ** exponent;
  const whole = Math.floor(minor / scale);
  const fraction = exponent ? String(minor % scale).padStart(exponent, "0") : "";
  const plain = String(whole);
  const grouped = whole >= 1000 ? [",", ".", " ", "'", "’"].map((sep) => plain.replace(/\B(?=(\d{3})+(?!\d))/g, sep)) : [];
  const forms: Array<{ form: string; marked: boolean }> = [];
  // Fewer decimal digits than the currency has, when only zeros are left out ("18.6" for 18.60), never more.
  const fractions = [fraction];
  while (fractions.at(-1)!.length > 1 && fractions.at(-1)!.endsWith("0")) fractions.push(fractions.at(-1)!.slice(0, -1));
  for (const wholeForm of [plain, ...grouped]) {
    for (const point of [".", ","]) {
      if (wholeForm.includes(point)) continue;
      if (exponent) for (const digits of fractions) forms.push({ form: `${wholeForm}${point}${digits}`, marked: false });
      if (exponent && /^0+$/.test(fraction)) forms.push({ form: `${wholeForm}${point}-`, marked: false });
    }
    if (!exponent || /^0+$/.test(fraction)) forms.push({ form: wholeForm, marked: true });
  }
  const lower = text.toLowerCase();
  const markers = markersOf(currency).map((marker) => new RegExp(markerPattern(marker)));
  return forms.some(({ form, marked }) => {
    const pattern = new RegExp(`(?<!\\d)(?<!\\d[.,'’ ])${escape(form)}(?!\\d)(?![.,'’]\\d)${marked ? "(?! \\d)" : ""}`, "g");
    for (const match of lower.matchAll(pattern)) {
      if (!marked) return true;
      const around = `${lower.slice(Math.max(0, match.index - 6), match.index)} ${lower.slice(match.index + form.length, match.index + form.length + 6)}`;
      if (markers.some((marker) => marker.test(around))) return true;
    }
    return false;
  });
}

// ---- A model's answer

/** The model's object, if it has the shape asked for (a missing field reads as nothing), else null. */
export function readRaw(value: unknown): RawDetails | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string): string | null | undefined => {
    const field = record[key];
    return field === undefined || field === null ? null : typeof field === "string" ? field : undefined;
  };
  const raw = { party: text("party"), amount: text("amount"), currency: text("currency"), state: text("state"), dueDate: text("dueDate"), what: text("what") };
  if (Object.values(raw).some((field) => field === undefined)) return null;
  if (record.refund !== undefined && typeof record.refund !== "boolean") return null;
  return { ...(raw as Omit<RawDetails, "refund">), refund: record.refund === true };
}

/** All a line says is that a payment was made, maybe to someone, maybe through a processor: no word on what for. */
const ONLY_PAYMENT = /^(?:your\s+)?(?:payment|purchase|order|transaction|charge)(?:\s+(?:was\s+|has\s+been\s+)?(?:made|received|sent|completed|confirmed|successful|processed))?(?:\s+to\s+(?:(?!\bfor\b)[^,;])+?)?(?:\s+(?:via|through|with|using|by)\s+[^,;]+?)?[.!]?$/i;
/** What may stand between a party's name and the rest of a line. */
const AFTER_NAME = /^\s*(?:[:\-–—|·,]|\.\s)\s*/;

/**
 * `what` without the party's name it starts with ("Hetzner: cloud server" → "Cloud server"), or why it says nothing:
 * only the party (`only_party`), or only that a payment was made (`only_payment`).
 */
function withoutParty(what: string, names: Array<string | null>): { what: string } | { dropped: string } {
  let line = what;
  for (const name of names) {
    if (!name || !line.toLowerCase().startsWith(name.toLowerCase())) continue;
    const rest = line.slice(name.length);
    if (!/[\p{L}\p{N}]/u.test(rest)) return { dropped: "only_party" };
    const separator = AFTER_NAME.exec(rest);
    if (separator) line = rest.slice(separator[0].length);
  }
  if (!/[\p{L}\p{N}]/u.test(line)) return { dropped: "only_party" };
  if (ONLY_PAYMENT.test(line.trim())) return { dropped: "only_payment" };
  return { what: line === what ? line : line.charAt(0).toUpperCase() + line.slice(1) };
}

/**
 * The sender's display name as a party, when the model gives none: checked like a summary, cut at display text, without
 * a legal suffix.
 */
export function senderParty(name: string): string | null {
  const verdict = plainLine(name, PAYMENT_PARTY_LIMIT);
  const cut = verdict && "line" in verdict ? cutDisplayText(verdict.line) : null;
  return cut ? partyName(cut) : null;
}

/** A plain line the model wrote, checked like a summary and shortened to `limit`; never an address. */
export function plainLine(value: string | null, limit: number): { line: string } | { dropped: string } | null {
  if (value === null) return null;
  if (value.includes(ADDRESS_STAND_IN) || value.includes("@")) return { dropped: "address" };
  const verdict = acceptLine(value, limit);
  return "summary" in verdict ? { line: verdict.summary } : { dropped: verdict.dropped };
}

/**
 * The facts of one answer that check out against `text`, the text the model was given, and those dropped. On an
 * invoice a refund makes no sense (it is money owed): the refund is false, and an amount read as one is dropped
 * (`refund_on_invoice`), since it would read as money to be paid. `sources` (each message's text with its date, and
 * the subject with the thread's first) let a due date be checked against the message it was read from.
 */
export function checkDetails(value: unknown, text: string, category: Category = "receipt", sources?: readonly DatedText[]): { checked: PaymentDetails; drops: DetailsDrop[]; swapped: boolean } {
  const none: PaymentDetails = { party: null, amount: null, refund: false, state: null, dueDate: null, what: null };
  if (value === null || value === undefined) return { checked: none, drops: [{ field: "answer", reason: "no_answer" }], swapped: false };
  const raw = readRaw(value);
  if (!raw) return { checked: none, drops: [{ field: "answer", reason: "shape" }], swapped: false };
  const drops: DetailsDrop[] = [];
  const checked: PaymentDetails = { ...none, refund: raw.refund };
  let swapped = false;
  const party = plainLine(raw.party, PAYMENT_PARTY_LIMIT);
  if (party && "line" in party) {
    const cut = cutDisplayText(party.line);
    const name = cut && partyName(cut);
    if (name) checked.party = name;
    else drops.push({ field: "party", reason: cut ? "empty" : "display_text" });
  } else if (party) drops.push({ field: "party", reason: party.dropped });
  const what = plainLine(raw.what, PAYMENT_WHAT_LIMIT);
  if (what && "line" in what) {
    const kept = withoutParty(what.line, [party && "line" in party ? party.line : null, checked.party]);
    if ("what" in kept) checked.what = kept.what;
    else drops.push({ field: "what", reason: kept.dropped });
  } else if (what) drops.push({ field: "what", reason: what.dropped });
  const refundOnInvoice = category === "invoice" && raw.refund;
  if (refundOnInvoice) checked.refund = false;
  if (raw.amount !== null && raw.amount.trim() && refundOnInvoice) drops.push({ field: "amount", reason: "refund_on_invoice" });
  else if (raw.amount !== null && raw.amount.trim()) {
    const amount = checkAmount(raw.amount, raw.currency, text);
    if ("minor" in amount) checked.amount = amount;
    else drops.push({ field: "amount", reason: amount.dropped });
  }
  const state = raw.state?.trim().toLowerCase() ?? null;
  if (state && (PAYMENT_STATES as readonly string[]).includes(state)) checked.state = state as PaymentState;
  else if (state) drops.push({ field: "state", reason: "unknown_state" });
  // A refund came back: it is paid.
  if (checked.refund) checked.state = "paid";
  if (raw.dueDate !== null && raw.dueDate.trim()) {
    const due = raw.dueDate.trim();
    // A date only while money is still to move.
    if (stateOf(checked, category) === "paid") drops.push({ field: "dueDate", reason: "paid" });
    else {
      const verdict = checkDueDate(due, text, sources);
      if ("dropped" in verdict) drops.push({ field: "dueDate", reason: verdict.dropped });
      else ({ dueDate: checked.dueDate, swapped } = verdict);
    }
  }
  return { checked, drops, swapped };
}

function checkAmount(written: string, currency: string | null, text: string): { minor: number; currency: string } | { dropped: string } {
  const code = resolveCurrency(currency, written);
  if (!/\d/.test(written)) return { dropped: "unparsable" };
  if (!code) return { dropped: "currency" };
  const exponent = exponentOf(code);
  const minor = parseAmount(written, exponent);
  if (minor === null) return { dropped: precisionOnly(written, exponent) ? "precision" : "unparsable" };
  // Nothing is paid or owed with nothing: a shop's "Total 0" line is never the amount, whatever the text says.
  if (minor === 0) return { dropped: "zero" };
  if (!writtenIn(minor, code, text)) return { dropped: "not_in_text" };
  if (!currencyIn(code, text)) return { dropped: "currency_not_in_text" };
  return { minor, currency: code };
}

/** Readable but for more decimals than the currency has. */
function precisionOnly(written: string, exponent: number): boolean {
  return parseAmount(written, exponent + 3) !== null && /[.,]\d+\s*$/.test(written.replace(/[^\d.,\s]/g, "").trim());
}

/**
 * The thread's details after an answer: a fact the answer gave wins; one it didn't is kept from before (a shipping
 * notice in an order's thread states no amount); the party falls back to the sender's name, and so does a party that is
 * one lowercase word. `refund` goes with the amount it was read with.
 */
export function combineDetails(before: PaymentDetails | null, checked: PaymentDetails, senderName: string | null): PaymentDetails {
  const earlier = before && servedPayment(before);
  const amountFrom = checked.amount ? checked : earlier?.amount ? earlier : checked;
  const party = checked.party ?? earlier?.party ?? senderName;
  return {
    // One lowercase word (a district, not a name) gives way to the sender's name when there is one.
    party: party === null ? null : orSenderName(party, senderName),
    amount: amountFrom.amount,
    refund: amountFrom.refund,
    state: checked.state ?? earlier?.state ?? null,
    dueDate: checked.dueDate ?? earlier?.dueDate ?? null,
    what: checked.what ?? earlier?.what ?? null,
  };
}

/**
 * Details asked once more for their state (2026-11-19): the answer's `state`, and each other fact only where the
 * thread had none, so a right fact is never overwritten; `refund` goes with the amount. The date then follows the
 * state (`settleDetails`).
 */
export function fillDetails(stored: PaymentDetails | null, answer: PaymentDetails): PaymentDetails {
  const kept = stored && servedPayment(stored);
  if (!kept) return answer;
  const amountFrom = kept.amount ? kept : answer.amount ? answer : kept;
  return {
    party: kept.party ?? answer.party,
    amount: amountFrom.amount,
    refund: amountFrom.refund,
    state: answer.state,
    dueDate: kept.dueDate ?? answer.dueDate,
    what: kept.what ?? answer.what,
  };
}

/** Where the money stands for a title: the state, else the category's (an invoice is due, a receipt paid). */
export function stateOf(payment: Pick<PaymentDetails, "state">, category: Category): PaymentState {
  return payment.state ?? (category === "invoice" ? "due" : "paid");
}

/** Details made whole: a refund is paid, and nothing paid carries a date. */
export function settleDetails(payment: PaymentDetails, category: Category): PaymentDetails {
  const state = payment.refund ? "paid" : payment.state;
  const settled = { ...payment, state };
  return stateOf(settled, category) === "paid" ? { ...settled, dueDate: null } : settled;
}

/**
 * Details as they may be served: an amount of zero, which builds before 2026-11-19's `zero` check could store, reads
 * as no amount. Anything else as stored.
 */
export function servedPayment(payment: PaymentDetails | null): PaymentDetails | null {
  if (!payment) return null;
  // Rows from before the state have none.
  const withState = payment.state === undefined ? { ...payment, state: null } : payment;
  return withState.amount?.minor === 0 ? { ...withState, amount: null } : withState;
}
