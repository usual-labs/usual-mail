// A due date the server can stand behind (docs/contract-ai.md, "Payment details"): a real calendar date, written in
// the mail, never before the message it was read from, and read day and month the way the mail writes dates. Pure.

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LOCALES = ["en", "de", "fr", "es", "it", "nl", "pt"];
/** Each month's names, long and short, in the locales mail is most often written in, lower case, without dots. */
const MONTHS: string[][] = Array.from({ length: 12 }, (_, index) => {
  const date = new Date(Date.UTC(2026, index, 15));
  const names = LOCALES.flatMap((locale) => (["long", "short"] as const).map((month) =>
    new Intl.DateTimeFormat(locale, { month, timeZone: "UTC" }).format(date).toLowerCase().replace(/\.$/, "")));
  if (index === 8) names.push("sept");
  return [...new Set(names)].sort((a, b) => b.length - a.length);
});

/** A calendar date as YYYY-MM-DD, or null. */
export function calendarDate(value: string): { year: number; month: number; day: number } | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return null;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? { year, month, day } : null;
}

/**
 * Whether the date is written in the text: as 2026-11-30; as day, month and year in digits joined by `.`, `/` or `-`,
 * day first or month first, with a four- or two-digit year ("30.11.2026", "11/30/26"); or as a day and a month's name
 * in English, German, French, Spanish, Italian, Dutch or Portuguese, either way round, with "st", "th", "er" or a dot
 * after the day, "of" or "de" between, and a year after it that must then be the same ("30 November", "Nov 30th,
 * 2026", "30. November 2026", "1er déc."). Digits standing next to more digits don't count.
 */
export function dateWrittenIn(iso: string, text: string): boolean {
  const date = calendarDate(iso);
  if (!date) return false;
  const lower = text.toLowerCase();
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = `(?:${date.day}|${pad(date.day)})`;
  const months = `(?:${date.month}|${pad(date.month)})`;
  const years = `(?:${date.year}|${String(date.year).slice(2)})`;
  const numeric = [
    `${date.year}-${pad(date.month)}-${pad(date.day)}`,
    `${days}([./-])${months}\\1${years}`,
    `${months}([./-])${days}\\2${years}`,
  ].map((form) => `(?<![\\d./-])${form}(?![\\d])`);
  if (new RegExp(numeric.join("|")).test(lower)) return true;
  const names = `(?:${MONTHS[date.month - 1]!.map(escape).join("|")})`;
  const year = String.raw`(?:,?\s+(\d{4}))?`;
  const dayFirst = new RegExp(String.raw`(?<![\d.])${days}(?:\.|st|nd|rd|th|er)?\s*(?:of\s+|de\s+)?${names}\.?(?![\p{L}])${year}`, "gu");
  const monthFirst = new RegExp(String.raw`(?<![\p{L}])${names}\.?\s+${days}(?:st|nd|rd|th)?(?!\d)${year}`, "gu");
  return [dayFirst, monthFirst].some((pattern) =>
    [...lower.matchAll(pattern)].some((match) => match[1] === undefined || Number(match[1]) === date.year));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many days before its message a due date may lie: two. A message's date is kept in UTC, which can be a day
 * earlier than the date its sender wrote "due today" in; and a reminder may say "due yesterday".
 */
export const DUE_TOLERANCE_DAYS = 2;

/** A part of what the model was given, with the date it carries: a message's text, or the subject (the thread's oldest). */
export interface DatedText {
  text: string;
  at: number;
}

/** The same date with day and month the other way round, when that is another real date. */
export function swappedDate(iso: string): string | null {
  const date = calendarDate(iso);
  if (!date || date.day === date.month || date.day > 12) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const swapped = `${date.year}-${pad(date.day)}-${pad(date.month)}`;
  return calendarDate(swapped) ? swapped : null;
}

/** Whether the date stands in the text in digits, day first ("07.11.2026") or month first ("11/07/2026"). */
function writtenInDigits(iso: string, text: string, order: "day" | "month"): boolean {
  const date = calendarDate(iso)!;
  const days = `(?:${date.day}|${String(date.day).padStart(2, "0")})`;
  const months = `(?:${date.month}|${String(date.month).padStart(2, "0")})`;
  const years = `(?:${date.year}|${String(date.year).slice(2)})`;
  const form = order === "day" ? `${days}([./-])${months}\\1${years}` : `${months}([./-])${days}\\1${years}`;
  return new RegExp(`(?<![\\d./-])${form}(?![\\d])`).test(text);
}

/**
 * Which way the text writes dates, from dates that can only be read one way: digits with a day over 12 ("21.11.2026"
 * is day first, "11/21/2026" month first), and a day before or after a month's name ("21 Nov", "Nov 21"). Null when it
 * shows neither, or both.
 */
export function dateOrder(text: string): "day" | "month" | null {
  const lower = text.toLowerCase();
  let day = false;
  let month = false;
  for (const match of lower.matchAll(/(?<![\d./-])(\d{1,2})[./-](\d{1,2})[./-](?:\d{4}|\d{2})(?![\d])/g)) {
    const [first, second] = [Number(match[1]), Number(match[2])];
    if (first > 12 && second >= 1 && second <= 12) day = true;
    if (second > 12 && first >= 1 && first <= 12) month = true;
  }
  const names = `(?:${MONTHS.flat().map(escape).join("|")})`;
  if (new RegExp(String.raw`(?<![\d.])\d{1,2}(?:\.|st|nd|rd|th|er)?\s*(?:of\s+|de\s+)?${names}\.?(?![\p{L}])`, "u").test(lower)) day = true;
  if (new RegExp(String.raw`(?<![\p{L}])${names}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?!\d)`, "u").test(lower)) month = true;
  return day === month ? null : day ? "day" : "month";
}

/** Not before the message it was read from (the earliest one it is written in), give or take the tolerance. */
function notBeforeItsMessage(iso: string, sources: readonly DatedText[]): boolean {
  const from = sources.filter((source) => dateWrittenIn(iso, source.text)).map((source) => source.at);
  if (from.length === 0) return true;
  const date = calendarDate(iso)!;
  const dueDay = Date.UTC(date.year, date.month - 1, date.day) / DAY_MS;
  return dueDay >= Math.floor(Math.min(...from) / DAY_MS) - DUE_TOLERANCE_DAYS;
}

/**
 * A due date the model gave, as the server keeps it, or why not: not a real date (`invalid_date`), not written in the
 * text (`not_in_text`), or before its message whichever way day and month are read (`before_message`). When the date
 * lies before its message but the other reading of day and month is written there and doesn't, that reading is kept
 * (`swapped`). When both readings fit, the one that follows the way the mail writes its other dates is kept, else the
 * model's. Without `sources` the message's date isn't checked.
 */
export function checkDueDate(iso: string, text: string, sources?: readonly DatedText[]): { dueDate: string; swapped: boolean } | { dropped: string } {
  if (!calendarDate(iso)) return { dropped: "invalid_date" };
  if (!dateWrittenIn(iso, text)) return { dropped: "not_in_text" };
  if (!sources) return { dueDate: iso, swapped: false };
  const reading = readingThatFits(iso, text, (candidate) => notBeforeItsMessage(candidate, sources));
  return reading ? { dueDate: reading.date, swapped: reading.swapped } : { dropped: "before_message" };
}

/**
 * Of a date written in the text and the same date with day and month the other way round (when that is written too),
 * the reading that `fits`: when both do, the one that follows the way the mail writes its unambiguous dates, else the
 * given one; null when neither does.
 */
export function readingThatFits(iso: string, text: string, fits: (iso: string) => boolean): { date: string; swapped: boolean } | null {
  const other = swappedDate(iso);
  const otherFits = other !== null && dateWrittenIn(other, text) && fits(other);
  const own = fits(iso);
  if (own && otherFits) {
    const order = dateOrder(text);
    const read = (candidate: string) => writtenInDigits(candidate, text, order === "day" ? "day" : "month");
    if (order && !read(iso) && read(other!)) return { date: other!, swapped: true };
    return { date: iso, swapped: false };
  }
  if (own) return { date: iso, swapped: false };
  return otherFits ? { date: other!, swapped: true } : null;
}

/** The dates a message written at `at` (stored in UTC) has where it was written: from UTC−12 to UTC+14, two days. */
export function localDates(at: number): string[] {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [...new Set([day(at - 12 * 3_600_000), day(at + 14 * 3_600_000)])];
}

/** The host's time zone when it names a real one, else UTC. */
export function serverTimeZone(given: string | undefined): string {
  if (!given) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: given });
    return given;
  } catch {
    return "UTC";
  }
}

/** The calendar date at `at` in `timeZone` (an IANA name), as YYYY-MM-DD. */
export function zonedDate(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const part = (type: string) => parts.find((each) => each.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The date and minute at `at` in `timeZone`, as "YYYY-MM-DD HH:MM" (compares as text). */
export function zonedMinute(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(at));
  const part = (type: string) => parts.find((each) => each.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

/** A calendar date moved by whole days. */
export function addDays(iso: string, days: number): string {
  const date = calendarDate(iso)!;
  return new Date(Date.UTC(date.year, date.month - 1, date.day + days)).toISOString().slice(0, 10);
}
