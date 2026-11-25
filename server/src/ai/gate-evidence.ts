// What the mail itself must show for each kind of mail that may skip Screening (docs/contract-ai.md, "A model's answer
// at the screening gate"): a link with sign-in, confirm or reset words; security words; an order, booking or tracking
// reference or an amount; a card's last digits; a day or time. (A code's is in gate.ts.) Words are matched whole and in
// any case, with up to three spaces or hyphens or nothing between a phrase's words ("sign in", "sign-in", "signin").
// Read on the message as the gate reads it (gate.ts: the subject and the text as the model read it, links cut to their
// site); a link also counts in the stored text or HTML. Every quantifier is bounded, so each pattern runs in linear
// time on any text (the security review of 2026-11-25: "card " and 80,000 "*" took 7.6 seconds under the server's
// lock). Pure.

import type { ScreeningPass } from "@usualmail/core";
import { ISO_4217_MINOR_UNITS } from "./currencies.ts";

/** A message as the gate reads it: subject and text together, and whether it holds a web link anywhere. */
export interface Reading {
  words: string;
  link: boolean;
}

/** Any of the phrases, whole, in any case, each space in a phrase standing for up to three spaces or hyphens, or none. */
function phrases(list: readonly string[]): RegExp {
  const alternatives = list.map((phrase) => phrase.split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s-]{0,3}"));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

const SIGN_IN = phrases(["sign in", "log in", "magic link"]);
const CONFIRM = phrases(["confirm", "confirmation", "verify", "verification", "activate", "activation", "validate"]);
const CONFIRMED = phrases(["e mail", "address", "account", "sign up", "registration", "subscription"]);
const SECURITY = phrases([
  "security alert", "security notice", "security notification", "security settings", "security key",
  "new sign in", "new log in", "new device", "new browser", "new location", "signed in", "logged in",
  "sign in attempt", "log in attempt", "was this you", "is this you", "was it you", "wasn't you", "was not you",
  "suspicious", "unusual activity", "unusual sign in", "unrecognized", "unrecognised",
  "password changed", "password was changed", "password has been changed", "password updated",
  "two factor", "2fa", "two step", "2 step", "multi factor", "mfa", "recovery email", "recovery phone",
  "recovery codes", "backup codes", "passkey", "authenticator",
]);
const RESET = phrases(["reset your password", "password reset", "reset password", "forgot your password", "forgot password", "set a new password"]);
const ACCOUNT_CHANGE = phrases([
  "email address changed", "email address was changed", "email address has been changed", "email address updated",
  "email changed", "changed your email", "plan changed", "plan was changed", "plan has been changed", "plan has changed",
  "plan updated", "plan has been updated", "account deleted", "account was deleted", "account has been deleted",
  "account will be deleted", "account closed", "account has been closed", "account deactivated", "data export",
  "export is ready", "download your data", "your data is ready", "archive is ready",
]);
const ORDER = phrases([
  "order", "ordered", "receipt", "purchase", "purchased", "shipped", "shipping", "shipment", "dispatched", "delivery",
  "delivered", "tracking", "package", "parcel", "return", "refund",
]);
const BOOKING = phrases([
  "booking", "booked", "reservation", "reserved", "itinerary", "flight", "train", "hotel", "check in", "boarding pass",
  "ticket", "tickets", "e ticket", "appointment",
]);
const PAYMENT = phrases([
  "payment", "paid", "charge", "charged", "card", "renewal", "renew", "renews", "renewed", "subscription", "declined",
  "failed", "fraud", "transaction", "refund", "refunded", "billing", "bank", "direct debit", "withdrawal", "transfer",
]);
/** The words a reference follows: an order, booking, ticket or tracking number. */
const REFERENCE_WORD = phrases([
  "order", "booking", "reservation", "confirmation", "tracking", "reference", "ref", "ticket", "pnr", "locator",
  "shipment", "itinerary", "parcel", "package",
]);
/**
 * A reference: five to thirty capital letters, digits and hyphens with at least one digit, alone (`#112-3456789`,
 * `K9XQ2B`, `1Z999AA10123456784`). Case-sensitive, so an ordinary word isn't one.
 */
const REFERENCE = /(?<![\p{L}\p{N}])#?(?=[A-Z0-9-]{0,29}\d)[A-Z0-9][A-Z0-9-]{4,29}(?![\p{L}\p{N}])/gu;
/** How far after its word a reference may start, in characters. */
const REFERENCE_NEAR = 40;

const SYMBOLS = "[$€£¥₹₩₽₺₪]";
const CODES = `(?<![\\p{L}])(?:${[...ISO_4217_MINOR_UNITS.keys()].join("|")})(?![\\p{L}])`;
const NUMBER = "\\d{1,3}(?:[.,'\\u00a0 ]\\d{3}){1,5}(?:[.,]\\d{1,3})?|\\d{1,9}(?:[.,]\\d{1,3})?";
/** An amount: a currency's symbol or ISO code next to a number, before or after it ("€12.50", "12,50 EUR"). */
const AMOUNT = new RegExp(`(?:${SYMBOLS}|${CODES})\\s?(?:${NUMBER})|(?<![\\d.,])(?:${NUMBER})\\s?(?:${SYMBOLS}|${CODES})`, "u");
/** A card's last four digits: "ending in 4242", "•••• 4242". */
const CARD = /(?:ending(?:\s{1,3}(?:in|with))?|ends\s{1,3}in|last\s{1,3}(?:4|four)\s{1,3}digits|[•*·xX]{2,8})[\s:]{0,3}\d{4}(?!\d)/iu;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]{0,6}\\.?";
/** A day or a time: "10:30", "3 Dec", "Dec 3", "2026-12-03", "03/12/2026". */
const DAY_OR_TIME = new RegExp(
  `(?<!\\d)\\d{1,2}:\\d{2}(?!\\d)|(?<![\\p{L}])${MONTH}\\s{1,3}\\d{1,2}(?!\\d)|(?<!\\d)\\d{1,2}\\.?\\s{1,3}${MONTH}(?![\\p{L}])`
    + "|(?<!\\d)\\d{4}-\\d{2}-\\d{2}(?!\\d)|(?<!\\d)\\d{1,2}[./]\\d{1,2}[./]\\d{2,4}(?!\\d)",
  "iu",
);
/** A web link: in the text, or one of the HTML's own links. */
const TEXT_LINK = /https?:\/\/[^\s<>"')]/i;
const HTML_LINK = /\bhref\s{0,8}=\s{0,8}["']?\s{0,8}https?:\/\//i;

function has(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

/** Whether a reference starts within 40 characters after a word a reference follows. One pass over both, in order. */
function holdsReference(text: string): boolean {
  const ends = [...text.matchAll(REFERENCE_WORD)].map((match) => match.index + match[0].length);
  let next = 0;
  for (const match of text.matchAll(REFERENCE)) {
    while (next < ends.length && ends[next]! < match.index - REFERENCE_NEAR) next++;
    if (next < ends.length && ends[next]! <= match.index) return true;
  }
  return false;
}

/** Whether the message holds a web link, in its text or among its HTML's links. */
export function holdsLink(text: string | null, html: string | null): boolean {
  return TEXT_LINK.test(text ?? "") || HTML_LINK.test(html ?? "");
}

/** What each kind needs the mail to show, besides the proof, machine-sent mail and the shape every kind needs. */
export const EVIDENCE: Record<Exclude<ScreeningPass, "code">, (reading: Reading) => boolean> = {
  sign_in: ({ words, link }) => link && has(SIGN_IN, words),
  email_confirmation: ({ words, link }) => link && has(CONFIRM, words) && has(CONFIRMED, words),
  security: ({ words }) => has(SECURITY, words),
  account: ({ words, link }) => (link && has(RESET, words)) || has(ACCOUNT_CHANGE, words),
  order: ({ words }) => has(ORDER, words) && (holdsReference(words) || AMOUNT.test(words)),
  booking: ({ words }) => has(BOOKING, words) && (holdsReference(words) || AMOUNT.test(words) || DAY_OR_TIME.test(words)),
  payment: ({ words }) => has(PAYMENT, words) && (AMOUNT.test(words) || CARD.test(words)),
};
