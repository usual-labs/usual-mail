// The server's own check before a model's `otp` lifts the screening gate (docs/contract.md, "Rules and learning"):
// mail can talk a model into calling it a one-time code, so for a sender who isn't let in the answer counts only when
// the mail also looks machine-sent and holds a code. Conservative on purpose: a code it misses stays in Screening,
// where the person sees it; a stranger it wrongly let through would skip the gate.

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

/**
 * Whether a model's `otp` may lift the gate for this message: it looks machine-sent by the existing test (bulk,
 * auto-submitted, a list header or no-reply) and its subject or text holds a code.
 */
export function looksLikeCode(message: { subject: string; text: string | null; html: string | null; automated: boolean }): boolean {
  return message.automated && holdsCode(`${message.subject}\n${plainText(message.text, message.html)}`);
}
