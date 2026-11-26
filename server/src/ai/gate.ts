// The server's own check at the screening gate (docs/contract.md, "Rules and learning"; docs/contract-ai.md, "A model's
// answer at the screening gate"). Mail can talk a model into calling it anything, and phishing imitates exactly the mail
// that may skip Screening, so for a sender who isn't let in a kind the AI named counts only when the server's own check
// also holds for the message the model read:
//
// - the mailbox provider's checker proved its From domain, which is the address's own, not a public mail domain or a
//   platform whose customers share its domain (the rule sender pictures use: `avatarDomain`), and the provider is one
//   whose checker the server trusts (Gmail);
// - it looks machine-sent (`ProviderMessage.automated`);
// - it has the shape of mail sent to this person by that organisation alone, not a notifier carrying its users' words
//   (gate-shape.ts);
// - it shows that kind's evidence (gate-evidence.ts).
//
// A one-time code needs only machine-sent mail addressed to the inbox, a code near a word for one, and the proof, which
// an inbox whose provider has no checker at all (IMAP) can't give and so doesn't need: there a code passes as it did
// before 2026-11-25. A Gmail inbox's missing or failed proof never falls back.
//
// The check reads each message once (`gateCheck`), and only as far as the model read it: the subject (at most 1,000
// characters) and the model's text (`modelText`, at most 4,000), plus whether the text or the HTML holds a link. Every
// pattern is linear, since the check runs under the server's lock. Conservative on purpose: what it misses waits in
// Screening, where the person sees it. Pure: the caller gives the suffix list and the inbox.

import { CATEGORIZE_TEXT_LIMIT, SCREENING_PASS_CATEGORIES, SCREENING_PASSES, type Address, type DecidedCategory, type ProviderKind, type ScreeningPass } from "@usualmail/core";
import { avatarDomain } from "../avatars/rules.ts";
import type { SuffixList } from "../avatars/suffixes.ts";
import { EVIDENCE, holdsLink, type Reading } from "./gate-evidence.ts";
import { addressedTo, soleSender } from "./gate-shape.ts";
import { modelText } from "./text.ts";

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

/** The most of a subject the check reads. */
const SUBJECT_READ = 1_000;

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

/** The message the check reads: the newest incoming one, the one the model read (a `messages` row fits). */
export interface GateMessage {
  subject: string;
  text: string | null;
  html: string | null;
  automated: boolean;
  from: { email: string };
  /** The From domain the provider's checker proved, in ASCII, or null (`messages.fromVerified`). */
  fromVerified: string | null;
  to: readonly Address[];
  cc: readonly Address[];
  replyTo: readonly Address[] | null;
  listId: string | null;
  /** The recipient fields the sender's own signature vouches for (`messages.signedRecipients`); null: not read. */
  signedRecipients: ReadonlyArray<"to" | "cc"> | null;
}

/** What the check needs besides the message: the suffix list (null: nothing is proved) and the inbox it came to. */
export interface GateContext {
  suffixes: SuffixList | null;
  inbox: { address: string; provider: ProviderKind };
}

/** Whether the server trusts this provider's own checker to prove a From domain: Gmail's (`mx.google.com`). */
export function trustsChecker(provider: ProviderKind): boolean {
  return provider === "gmail";
}

/** The kinds a model may be asked about for mail in this category: a one-time code is the server's own check alone. */
export function askableKinds(category: DecidedCategory): Array<Exclude<ScreeningPass, "code">> {
  return SCREENING_PASSES.filter((kind): kind is Exclude<ScreeningPass, "code"> => kind !== "code" && SCREENING_PASS_CATEGORIES[kind].includes(category));
}

/** The check for one message, which reads it at most once. */
export interface GateCheck {
  /** Whether the server's own check lets mail of this kind skip Screening. */
  mayPass(kind: ScreeningPass): boolean;
  /**
   * Whether asking which kind it is could let the mail through: it isn't a code that passes already, and one of the
   * kinds its category may be passes the check. Otherwise nothing is asked, and it stays screened.
   */
  worthAsking(category: DecidedCategory): boolean;
  /**
   * The kind that lets it skip Screening, or null: a code the check accepts, or the kind the model chose when it may
   * be in this category and the check holds for it.
   */
  pass(category: DecidedCategory, chosen: ScreeningPass | null): ScreeningPass | null;
}

export function gateCheck(message: GateMessage, context: GateContext): GateCheck {
  let reading: Reading | null = null;
  const read = (): Reading => (reading ??= {
    words: `${message.subject.slice(0, SUBJECT_READ)}\n${modelText(message.text, message.html).slice(0, CATEGORIZE_TEXT_LIMIT)}`,
    subject: message.subject.slice(0, SUBJECT_READ),
    link: holdsLink(message.text, message.html),
  });
  const checked = trustsChecker(context.inbox.provider);
  const suffixes = context.suffixes;
  // The proved registrable domain, when the checker proved the From address's own domain and it is no public one.
  const home = checked && suffixes ? avatarDomain(message.fromVerified, message.from.email, suffixes) : null;
  // Addressed to the inbox: on Gmail only by a field the sender's own signature vouches for (gate-shape.ts, (c)).
  const signed = message.signedRecipients ?? [];
  const addressed = addressedTo(checked
    ? { to: signed.includes("to") ? message.to : [], cc: signed.includes("cc") ? message.cc : [] }
    : message, context.inbox.address);
  const organisation = home !== null && message.automated && soleSender(message, message.fromVerified!, home, addressed, suffixes!);
  const codeProof = home !== null || !checked;
  const mayPass = (kind: ScreeningPass): boolean => (kind === "code"
    ? codeProof && message.automated && addressed && holdsCode(read().words)
    : organisation && EVIDENCE[kind](read()));
  const codePasses = (category: DecidedCategory) => category === "otp" && mayPass("code");
  return {
    mayPass,
    worthAsking: (category) => !codePasses(category) && organisation && askableKinds(category).some((kind) => EVIDENCE[kind](read())),
    pass: (category, chosen) => {
      if (codePasses(category)) return "code";
      if (!chosen || chosen === "code" || !SCREENING_PASS_CATEGORIES[chosen].includes(category)) return null;
      return mayPass(chosen) ? chosen : null;
    },
  };
}
