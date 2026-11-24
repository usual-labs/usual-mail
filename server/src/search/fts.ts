// The FTS5 query a search becomes (docs/contract-search.md, "How text matches"). Every term is quoted, so nothing a
// person types is read as FTS5 syntax; a word is cut into the tokens the index's tokenizer (unicode61) makes, and a
// word that cuts into several (an address, "e-mail") is matched as a phrase.

import type { Parsed } from "./terms.ts";

/** The index's columns, in its order; the weights `bm25` gives each, the same order. */
export const COLUMNS = ["subject", "sender", "people", "summary", "facts", "attachments", "body"] as const;
export type Column = (typeof COLUMNS)[number];
/**
 * How much a match in each column counts inside bm25: the subject and who wrote ten times a body's, the summary and the
 * AI's facts four times, attachment names and the others in the thread three times. FTS5 weighs a column's term
 * frequency before bm25 saturates it, so a weight lifts a match by at most about twice; the tier
 * (`strongExpression`) is what puts the subject and the sender first.
 */
export const WEIGHTS: Record<Column, number> = { subject: 10, sender: 10, people: 3, summary: 4, facts: 4, attachments: 3, body: 1 };

/** The tokens unicode61 makes of a word: runs of letters, digits and private-use characters. */
export function tokensOf(word: string): string[] {
  return word.match(/[\p{L}\p{N}\p{Co}]+/gu) ?? [];
}

/** The way a person may write a token's ß: both ß and ss, since unicode61 doesn't fold them into each other. */
function spellings(token: string): string[] {
  const out = new Set([token]);
  if (/ß/i.test(token)) out.add(token.replace(/ß/g, "ss").replace(/ẞ/g, "SS"));
  if (/ss/i.test(token)) out.add(token.replace(/ss/g, "ß").replace(/SS/g, "ẞ"));
  return [...out];
}

/**
 * One word or phrase as FTS5 text: its tokens quoted as one phrase, with `*` for a word start when `prefix` is true and
 * the last token is at least two characters, and each spelling of ß ORed.
 */
function term(tokens: string[], prefix: boolean): string {
  const star = prefix && tokens.at(-1)!.length >= 2 ? "*" : "";
  const variants = new Set<string>([tokens.join(" ")]);
  for (const [i, token] of tokens.entries()) {
    for (const other of spellings(token)) variants.add([...tokens.slice(0, i), other, ...tokens.slice(i + 1)].join(" "));
  }
  const quoted = [...variants].map((v) => `"${v.replace(/"/g, '""')}"${star}`);
  return quoted.length === 1 ? quoted[0]! : `(${quoted.join(" OR ")})`;
}

/**
 * What the index must match: every word as a word start, every phrase word for word, and the subject's words in the
 * subject column. Null when nothing is left to match (filters only).
 */
export function matchExpression(parsed: Pick<Parsed, "words" | "phrases" | "subjectWords">): string | null {
  const parts: string[] = [];
  for (const word of parsed.words) {
    const tokens = tokensOf(word);
    if (tokens.length) parts.push(term(tokens, true));
  }
  for (const phrase of parsed.phrases) {
    const tokens = tokensOf(phrase);
    if (tokens.length) parts.push(term(tokens, false));
  }
  const subject = parsed.subjectWords.map(tokensOf).filter((tokens) => tokens.length).map((tokens) => term(tokens, true));
  if (subject.length) parts.push(`{subject} : (${subject.join(" AND ")})`);
  return parts.length ? parts.join(" AND ") : null;
}

/**
 * The same match within the subject and who wrote alone: a thread it holds for ranks above every thread it doesn't
 * (docs/contract-search.md, "How results rank").
 */
export function strongExpression(expr: string): string {
  return `{subject sender} : (${expr})`;
}

/** What a thread must not hold: any of these words, whole. Null when there are none. */
export function excludeExpression(words: string[]): string | null {
  const parts = words.map(tokensOf).filter((tokens) => tokens.length).map((tokens) => term(tokens, false));
  return parts.length ? parts.join(" OR ") : null;
}
