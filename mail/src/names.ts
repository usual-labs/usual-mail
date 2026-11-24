/**
 * Names of the labels, folders and keywords that hold categories, the screening gate and stacks at the provider.
 * Defaults live under "Usual Mail/" as docs/contract-sync.md says. `conversation` and `unknown` never have a label.
 */
import { FILED_CATEGORIES, STACKS, type FiledCategory, type ProviderOptions, type Stack } from "@usualmail/core";

/** Everything that has its own label or folder: the five filed categories and Screening. */
export type Filing = FiledCategory | "screening";
export const FILINGS: readonly Filing[] = [...FILED_CATEGORIES, "screening"];

export const DEFAULT_NAMES: Record<Filing | Stack, string> = {
  newsletter: "Usual Mail/Newsletters",
  invoice: "Usual Mail/Invoices",
  receipt: "Usual Mail/Receipts",
  notification: "Usual Mail/Notifications",
  otp: "Usual Mail/One-Time Codes",
  screening: "Usual Mail/Screening",
  reply_later: "Usual Mail/Reply Later",
  set_aside: "Usual Mail/Set Aside",
};

export type Names = Record<Filing | Stack, string>;

/** Merges the caller's names over the defaults. */
export function resolveNames(options?: ProviderOptions): Names {
  const names: Names = { ...DEFAULT_NAMES };
  for (const key of [...FILINGS, ...STACKS]) {
    const custom = options?.names?.[key]?.trim();
    if (custom) names[key] = custom.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
  }
  return names;
}

/**
 * The IMAP keyword for a stack, derived from its name: "Usual Mail/Reply Later" becomes
 * "$UsualMail_ReplyLater". Keywords are atoms, so spaces and most punctuation can't appear.
 */
export function keywordFor(name: string): string {
  const parts = name
    .split("/")
    .map((part) => part.replace(/[^A-Za-z0-9]+/g, ""))
    .filter(Boolean);
  return `$${parts.join("_") || "Usual"}`;
}

export function filingForName(names: Names, name: string): Filing | undefined {
  return FILINGS.find((filing) => names[filing].toLowerCase() === name.toLowerCase());
}

export function stackForName(names: Names, name: string): Stack | undefined {
  return STACKS.find((stack) => names[stack].toLowerCase() === name.toLowerCase());
}

/** The error both providers give for a place or untrash that asks for the inbox together with a label or folder. */
export const IN_INBOX_ONLY_UNFILED =
  "A message can be in the inbox only without a category's label or folder and without Screening.";
