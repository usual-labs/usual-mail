// The times a notification writes, for the server's checks on an event (docs/contract-ai.md, "Notification events"):
// every time the text writes, each with how it is marked: plain (local, kept as written), UTC or GMT (converted to the
// server's time zone on the event's date), or with another UTC offset (dropped, since the date is kept); and which
// times follow a word for resetting (a limit's reset is not its event's moment). Pure.

import { calendarDate } from "./payment-dates.ts";

const MERIDIEM = String.raw`(a\.?\s?m\.?|p\.?\s?m\.?)`;
/**
 * A time token: hours, then minutes after `:` or `.`, or `h` and minutes, or `Uhr`, `h`, am or pm; not part of an
 * offset ("+00:00") or a date ("07.11.2026", "2026-11-19"); a plain hyphen between two times is a window ("14:00-15:00").
 */
const TOKEN = new RegExp(String.raw`(?<![\d.:/+−])(?<!(?<![:.]\d{2})-)(\d{1,2})(?:[:.](\d{2})(?![\d])(?![./]\d)(?!-\d(?!\d?[:.]\d{2}))|h(\d{2})(?![\d]))?\s*(?:${MERIDIEM}(?![\p{L}])|(uhr|h)(?![\p{L}\d]))?`, "giu");
/** What may join a window's two times. */
const JOIN = /^\s*(?:–|—|-|to|and|until|till|bis|à|a|al|tot|e|t\/m)\s*$/iu;
/** Seconds, and a fraction of one, after a time ("14:30:00", "00:00:00.000"). */
const SECONDS = String.raw`(?::\d{2}(?:[.,]\d{1,9})?)?`;
/** Right after a time: UTC or GMT with no offset, or one of zero ("14:30 UTC", "(GMT)", "UTC+00:00"). */
const UTC_MARK = new RegExp(String.raw`^\s*${SECONDS}\s*\(?(?:utc|gmt)(?:\s*[+±]\s*0{1,2}(?::?00)?)?(?![\p{L}\d+\-−±:])`, "iu");
/** ... or a "Z" against it, or a numeric offset of zero after its seconds, as ISO 8601 writes them ("T14:30:00.000Z", "T00:00:00+00:00"). */
const ZULU_MARK = new RegExp(String.raw`^${SECONDS}Z(?![\p{L}\d])|^:\d{2}(?:[.,]\d{1,9})?[+\-−]00:?00(?!\d)`, "u");
/** ... or UTC or GMT with another offset ("UTC+1", "GMT-05:00"): its sign is written both ways, so it isn't read; or another numeric ISO offset after seconds ("T09:30:00+01:00"). */
const OFFSET_MARK = new RegExp(String.raw`^\s*${SECONDS}\s*\(?(?:utc|gmt)\s*[+\-−±]\s*\d|^:\d{2}(?:[.,]\d{1,9})?[+\-−]\d{2}:?\d{2}(?!\d)`, "iu");
/** Right before a time: "UTC" or "GMT" ("resets daily at UTC 00:00"). */
const UTC_BEFORE = /(?<![\p{L}])(?:utc|gmt)\s*$/iu;
/**
 * A word for resetting shortly before a time, in the same sentence ("resets on 1 December at 00:00", "renews today
 * at 18:00"), in English, German and French: when a limit starts again, not when anything happens.
 */
const RESET_BEFORE = /(?<![\p{L}])(?:resets?|resetting|renews?|renewal|refresh(?:es)?|zurückgesetzt|erneuert|réinitialis\p{L}*|renouvel\p{L}*)(?![\p{L}])[^.\n]{0,30}$/iu;

/** How a written time is marked. */
export type TimeMark = "local" | "utc" | "offset";

interface Token {
  time: string;
  zone: TimeMark;
  start: number;
}

/**
 * Every time the text writes, in order, as HH:MM in 24 hours, with its mark: "15:15", "14.30 Uhr", "15 Uhr", "9h30",
 * "18h", "9:40 am", "12 pm", "14:30 UTC", "UTC 00:00", "T00:00:00.000Z". A bare number with no minutes and no mark
 * isn't a time; of a window's two times ("3:15–6:15 pm", "14:00–16:00 UTC", "GMT 14:00–16:00"), one without am or
 * pm, or without a zone, takes the other's.
 */
function tokensOf(text: string): Token[] {
  const tokens: Array<{ hour: number; minute: number; meridiem: "am" | "pm" | null; marked: boolean; zone: TimeMark; start: number; end: number }> = [];
  for (const match of text.matchAll(TOKEN)) {
    const [, hours, minutes, frenchMinutes, meridiem, mark] = match;
    const hasMinutes = minutes !== undefined || frenchMinutes !== undefined;
    if (!hasMinutes && !meridiem && !mark) continue;
    const end = match.index + match[0].length;
    const after = text.slice(end);
    tokens.push({
      hour: Number(hours),
      minute: Number(minutes ?? frenchMinutes ?? 0),
      meridiem: meridiem ? (meridiem.toLowerCase().startsWith("a") ? "am" : "pm") : null,
      marked: Boolean(meridiem || mark || hasMinutes),
      zone: UTC_MARK.test(after) || ZULU_MARK.test(after) || UTC_BEFORE.test(text.slice(Math.max(0, match.index - 8), match.index)) ? "utc"
        : OFFSET_MARK.test(after) ? "offset" : "local",
      start: match.index,
      end,
    });
  }
  for (let i = 0; i + 1 < tokens.length; i++) {
    const [first, second] = [tokens[i]!, tokens[i + 1]!];
    if (!JOIN.test(text.slice(first.end, second.start))) continue;
    if (!first.meridiem && second.meridiem && first.hour <= 12) first.meridiem = second.meridiem;
    if (first.zone === "local" && second.zone !== "local") first.zone = second.zone;
    else if (second.zone === "local" && first.zone !== "local") second.zone = first.zone;
  }
  const times: Token[] = [];
  for (const token of tokens) {
    let hour = token.hour;
    if (token.meridiem) {
      if (hour < 1 || hour > 12) continue;
      hour = token.meridiem === "pm" ? (hour % 12) + 12 : hour % 12;
    }
    if (!token.marked || hour > 23 || token.minute > 59) continue;
    times.push({ time: `${String(hour).padStart(2, "0")}:${String(token.minute).padStart(2, "0")}`, zone: token.zone, start: token.start });
  }
  return times;
}

/** Every time the text writes, with its marks. */
export function readTimes(text: string): Map<string, Set<TimeMark>> {
  const times = new Map<string, Set<TimeMark>>();
  for (const token of tokensOf(text)) times.set(token.time, (times.get(token.time) ?? new Set()).add(token.zone));
  return times;
}

/** The times the text writes shortly after a word for resetting (`RESET_BEFORE`). */
export function resetTimes(text: string): Set<string> {
  return new Set(tokensOf(text).filter((token) => RESET_BEFORE.test(text.slice(Math.max(0, token.start - 60), token.start))).map((token) => token.time));
}

/** Every time the text writes, however marked. */
export function timesIn(text: string): Set<string> {
  return new Set(readTimes(text).keys());
}

/** How a time the text writes reads: UTC when any writing of it is so marked, else as written, else another offset. */
export function markOf(time: string, times: Map<string, Set<TimeMark>>): TimeMark {
  const marks = times.get(time);
  return marks?.has("utc") ? "utc" : marks?.has("local") || !marks ? "local" : "offset";
}

/** A time in UTC on a date, as the date and time it is in `timeZone`. */
export function fromUtc(date: string, time: string, timeZone: string): { date: string; time: string } {
  const day = calendarDate(date)!;
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(Date.UTC(day.year, day.month - 1, day.day, hour, minute)));
  const part = (type: string) => parts.find((each) => each.type === type)!.value;
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}
