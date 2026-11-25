// The server's own check at the screening gate (docs/contract.md, "Rules and learning"; docs/contract-ai.md, "Mail is
// untrusted input to a model"). Mail can talk a model into calling it anything, and phishing imitates exactly the mail
// that may skip Screening, so for a sender who isn't let in a kind the AI named counts only when the server's own check
// also holds for the message the model read:
//
// - the mailbox provider's checker proved its From domain, which is the address's own, not a public mail domain or a
//   platform whose customers share its domain (the rule sender pictures use: `avatarDomain`);
// - it looks machine-sent (`ProviderMessage.automated`);
// - it shows that kind's evidence (gate-evidence.ts; a one-time code's is a code near a word for one).
//
// Conservative on purpose: what it misses waits in Screening, where the person sees it; a stranger it wrongly let
// through would skip the gate. Pure: the caller gives the suffix list, or null when the server carries none (then
// nothing is proved, and nothing passes).

import { SCREENING_PASS_CATEGORIES, SCREENING_PASSES, type DecidedCategory, type ScreeningPass } from "@usualmail/core";
import { avatarDomain } from "../avatars/rules.ts";
import type { SuffixList } from "../avatars/suffixes.ts";
import { EVIDENCE, holdsLink } from "./gate-evidence.ts";
import { plainText } from "./text.ts";

/** The words that name a code, as whole words in any case. */
const CODE_WORD = /(?<![\p{L}\p{N}])(?:code|codes|passcode|one-time|otp|verification|verify)(?![\p{L}\p{N}])/giu;

/**
 * A code: six to eight digits, or two groups of three or four digits joined by one space or hyphen ("482 913",
 * "4829-1375"), standing alone: no letter, digit or one of `#+$€£.,/:_-` right before it, and no letter or digit, nor
 * one of `.,/:-` followed by a digit, right after it (so not part of an amount, a date, a phone number or a word).
 */
const CODE = /(?<![\p{L}\p{N}#+$€£.,/:_-])(?:\p{Nd}{6,8}|\p{Nd}{3}[ -]\p{Nd}{3}|\p{Nd}{4}[ -]\p{Nd}{4})(?![\p{L}\p{N}_]|[.,/:-]\p{Nd})/gu;

/** How near a code must be to a word that names one, in characters. */
const NEAR = 80;

/**
 * Whether the text holds a code within 80 characters of a word that names one. One pass over both, in order (0.1.3:
 * each code against every word took minutes on a crafted 1 MB message, under the server's lock): words and codes each
 * come in order and never overlap, so the first word that doesn't end too early for a code is the only one to look at.
 */
export function holdsCode(text: string): boolean {
  const words = [...text.matchAll(CODE_WORD)].map((match) => [match.index, match.index + match[0].length] as const);
  if (words.length === 0) return false;
  let next = 0;
  for (const match of text.matchAll(CODE)) {
    const start = match.index;
    const end = start + match[0].length;
    while (next < words.length && words[next]![1] < start - NEAR) next++;
    if (next === words.length) return false;
    if (words[next]![0] - end <= NEAR) return true;
  }
  return false;
}

/** The message the check reads: the newest incoming one, the one the model read. */
export interface GateMessage {
  subject: string;
  text: string | null;
  html: string | null;
  automated: boolean;
  from: { email: string };
  /** The From domain the provider's checker proved, in ASCII, or null (`messages.fromVerified`). */
  fromVerified: string | null;
}

/**
 * Whether the mail is an organisation's proved by the mailbox provider: the checker proved the From address's own
 * domain, which isn't a public mail domain or a shared platform's, and it looks machine-sent. Every kind needs it.
 */
export function provedMachineMail(message: GateMessage, suffixes: SuffixList | null): boolean {
  return suffixes !== null && message.automated && avatarDomain(message.fromVerified, message.from.email, suffixes) !== null;
}

/** Whether the mail shows a kind's own evidence (not the proof every kind needs). */
export function showsEvidence(kind: ScreeningPass, message: GateMessage): boolean {
  const words = `${message.subject}\n${plainText(message.text, message.html)}`;
  if (kind === "code") return holdsCode(words);
  return EVIDENCE[kind]({ words, link: holdsLink(message.text, message.html) });
}

/** Whether the server's own check lets mail of this kind skip Screening: the proof, machine-sent, and its evidence. */
export function mayPass(kind: ScreeningPass, message: GateMessage, suffixes: SuffixList | null): boolean {
  return provedMachineMail(message, suffixes) && showsEvidence(kind, message);
}

/** The kinds a model may be asked about for mail in this category: a one-time code is the server's own check alone. */
export function askableKinds(category: DecidedCategory): ScreeningPass[] {
  return SCREENING_PASSES.filter((kind) => kind !== "code" && SCREENING_PASS_CATEGORIES[kind].includes(category));
}

/**
 * Whether a one-time code passes without asking: the AI said `otp` and the server's own check holds, as it always
 * did, now with the proof too.
 */
export function codePasses(category: DecidedCategory, message: GateMessage, suffixes: SuffixList | null): boolean {
  return category === "otp" && mayPass("code", message, suffixes);
}

/**
 * Whether asking which kind it is could let the mail through: it isn't a code that passes already, and one of the
 * kinds its category may be passes the server's own check. Otherwise nothing is asked, and it stays screened.
 */
export function worthAsking(category: DecidedCategory, message: GateMessage, suffixes: SuffixList | null): boolean {
  if (codePasses(category, message, suffixes) || !provedMachineMail(message, suffixes)) return false;
  return askableKinds(category).some((kind) => showsEvidence(kind, message));
}

/**
 * The kind that lets the mail skip Screening, or null: a code the server's check accepts, or the kind the model chose
 * when it may be in this category and the server's check holds for it.
 */
export function screeningPass(category: DecidedCategory, chosen: ScreeningPass | null, message: GateMessage, suffixes: SuffixList | null): ScreeningPass | null {
  if (codePasses(category, message, suffixes)) return "code";
  if (!chosen || chosen === "code" || !SCREENING_PASS_CATEGORIES[chosen].includes(category)) return null;
  return mayPass(chosen, message, suffixes) ? chosen : null;
}
