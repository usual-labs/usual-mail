// The server's rules on an event's status and `about` beyond a safe line (docs/contract-ai.md, "Notification events";
// the audit of 2026-11-19): a status names what happens at the date it goes with and holds no relative word, and
// `about` loses the sender's name only when more than a word or a place is left. Pure.

import { partyName } from "./payment-party.ts";

const WEEKDAY_NAMES = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
/**
 * A relative word in an English status, with "on", "at", "for", "from" or "in" before it: "today", "tonight",
 * "tomorrow", "yesterday", "this morning" (afternoon, evening, week), "next week", "in 1 hour", "within 3 days", a
 * weekday. "by" and "until" stay: "Pick up by" names a deadline the date gives.
 */
const RELATIVE_IN_STATUS = new RegExp(String.raw`(?:(?<![\p{L}])(?:on|at|for|from|in)\s+)?(?<![\p{L}])(?:today|tonight|tomorrow|yesterday|(?:the\s+)?day\s+after\s+tomorrow|this\s+(?:morning|afternoon|evening|week)|next\s+week|(?:in|within)\s+(?:\d+|an?|one)\s+(?:minutes?|mins?|hours?|hrs?|days?|weeks?)|${WEEKDAY_NAMES})(?![\p{L}])`, "giu");
/** Words that alone are no phrase. */
const CONNECTORS = new Set(["on", "at", "for", "from", "in", "to", "and", "or", "the", "a", "an", "of"]);

/** A status without its relative words, when a phrase is left ("Arriving tomorrow" is "Arriving"); else why not. */
export function withoutRelativeWords(status: string): { line: string; changed: boolean } | { dropped: string } {
  const cut = status.replace(RELATIVE_IN_STATUS, " ");
  if (cut === status) return { line: status, changed: false };
  const left = cut.replace(/\s+/g, " ").replace(/^[\s,;:·|\-–—(]+|[\s,;:·|\-–—(]+$/gu, "").replace(/\(\s*\)/g, "").trim();
  const words = left.split(" ").filter((word) => /\p{L}{2,}/u.test(word) && !CONNECTORS.has(word.toLowerCase()));
  if (words.length === 0) return { dropped: "relative_only" };
  return { line: left.charAt(0).toUpperCase() + left.slice(1), changed: true };
}

/** A status that only says a parcel left: with a later date, the date is when it arrives. */
const DISPATCH = /^(?:(?:order|parcel|package|shipment)\s+)?(?:dispatched|shipped|on\s+(?:its|the)\s+way|in\s+transit)\.?$/iu;

/** "Arriving" for a dispatch whose date is after the day its message was sent (`sentDay`, YYYY-MM-DD); else as it is. */
export function arrivingWhenLater(status: string, date: string | null, sentDay: string): string {
  return date !== null && date > sentDay && DISPATCH.test(status.trim()) ? "Arriving" : status;
}

/** Short words a place's name holds between its capitalised ones ("Frankfurt am Main", "Saint-Martin de Ré"). */
const PLACE_JOINERS = new Set(["am", "an", "im", "in", "de", "du", "des", "la", "le", "les", "del", "der", "sur", "upon", "on", "op", "aan"]);

/** One word, or up to three capitalised words with a place's joiners between ("Berlin", "Frankfurt am Main"). */
function wordOrPlace(text: string): boolean {
  const words = text.split(/\s+/);
  if (words.length === 1) return true;
  const named = words.filter((word) => !PLACE_JOINERS.has(word));
  return named.length <= 3 && /^\p{Lu}/u.test(words[0]!) && /^\p{Lu}/u.test(words.at(-1)!) && named.every((word) => /^\p{Lu}/u.test(word));
}

/**
 * What a line says once the sender's name is taken from its start ("Parcelway: parcel…"), or why it says nothing more.
 * When only a word or a place would be left ("Parcelway: Berlin"), the line stays whole.
 */
export function withoutSender(line: string, sender: string | null): { line: string } | { dropped: string } {
  if (!sender) return { line };
  const named = (text: string) => [text, partyName(text) ?? text].map((name) => name.toLowerCase());
  if (named(line).includes(sender.toLowerCase())) return { dropped: "only_sender" };
  if (!line.toLowerCase().startsWith(sender.toLowerCase())) return { line };
  const rest = /^\s*[:\-–—|·,]\s*(.+)$/u.exec(line.slice(sender.length))?.[1];
  if (!rest || wordOrPlace(rest)) return { line };
  return { line: rest.charAt(0).toUpperCase() + rest.slice(1) };
}
