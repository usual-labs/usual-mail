/**
 * Mail that skips Screening without letting its sender in (docs/contract.md, "Rules and learning"; the owner's decision
 * of 2026-11-25): one-time codes, sign-in links, email confirmations, security alerts, password resets and account
 * changes, receipts and order updates, bookings, and payment alerts. The server's AI names the kind, and the server's own
 * check must also hold (contract-ai.md, "Mail is untrusted input to a model"). Such a thread stays in the category the AI
 * gave it, one of the kind's, and `Thread.skippedScreening` says which kind let it through.
 */
import type { DecidedCategory } from "./domain.ts";

/** The kinds of mail from a sender who isn't let in that may skip Screening, in the order the owner listed them. */
export const SCREENING_PASSES = [
  "code",
  "sign_in",
  "email_confirmation",
  "security",
  "account",
  "order",
  "booking",
  "payment",
] as const;
export type ScreeningPass = (typeof SCREENING_PASSES)[number];

/** What each kind is, as a person reads it after "Skipped Screening: ". */
export const SCREENING_PASS_WORDS: Record<ScreeningPass, string> = {
  code: "a one-time code",
  sign_in: "a sign-in link",
  email_confirmation: "an email confirmation",
  security: "a security alert",
  account: "a password reset or account change",
  order: "a receipt or order update",
  booking: "a booking",
  payment: "a payment alert",
};

/**
 * The categories a thread of each kind may be in. The thread keeps the category the AI gave it, and skips Screening only
 * when that category is one of its kind's: a sign-in link the AI calls a newsletter stays screened. No kind may be an
 * invoice: a bill from a stranger is the commonest fraud, so it always waits in Screening.
 */
export const SCREENING_PASS_CATEGORIES: Record<ScreeningPass, readonly DecidedCategory[]> = {
  code: ["otp"],
  sign_in: ["otp", "notification"],
  email_confirmation: ["otp", "notification"],
  security: ["notification"],
  account: ["notification", "otp"],
  order: ["receipt", "notification"],
  booking: ["notification", "receipt"],
  payment: ["notification", "receipt"],
};

export function isScreeningPass(value: unknown): value is ScreeningPass {
  return (SCREENING_PASSES as readonly unknown[]).includes(value);
}

/** "Skipped Screening: a sign-in link": the line an interface shows for `Thread.skippedScreening`. */
export function skippedScreeningLine(pass: ScreeningPass): string {
  return `Skipped Screening: ${SCREENING_PASS_WORDS[pass]}`;
}
