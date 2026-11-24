// The dates a notification supports, for the server's checks on an event (docs/contract-ai.md, "Notification
// events"): a date written within a year of its message (a day and month with no year included, read by a rule), or
// said relative to the day its message was sent ("today", a weekday, "within 14 days"); and the date the server gives
// a time said "today" when the answer gives none. Pure.

import { addDays, calendarDate, dateWrittenIn, localDates, readingThatFits, swappedDate, zonedDate, type DatedText } from "./payment-dates.ts";
import { timesIn } from "./event-times.ts";

/** How far from its message a written date may lie, either way: a notification may tell of the past ("delivered on 2 November") or plan ahead, but not by years. */
export const EVENT_RANGE_DAYS = 365;

/**
 * A day and month written without a year ("05.12.", "05/12") is in its message's year, unless that day lies more than
 * this many days before the message: then it is in the next year. A notification tells of the recent past (delivered,
 * changed, paid: days or weeks back) far more than of anything months ago, and a deadline or an appointment rarely lies
 * more than nine months ahead; so a year-less date is read within the 365 days from about three months before its
 * message: "15.01." in November is next January, "20.09." in November is this September.
 */
export const YEARLESS_PAST_DAYS = 92;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Words that move the message's own date, in the languages the date matcher reads. "morgen" (German, Dutch) counts only
 * in lower case ("Morgen" is the morning); "mañana" not after "la", "esta" or "pasado" (the morning, or the day after).
 * French "hier" is left out: it is "here" in German and Dutch.
 */
const RELATIVE: Array<{ words: RegExp; days: number }> = [
  { words: /(?<![\p{L}])(?:today|tonight|this evening|heute|aujourd'hui|aujourd’hui|ce soir|hoy|oggi|stasera|vandaag|vanavond|hoje)(?![\p{L}])/iu, days: 0 },
  { words: /(?<![\p{L}])(?:tomorrow|demain|domani|amanhã)(?![\p{L}])/iu, days: 1 },
  { words: /(?<![\p{L}])morgen(?![\p{L}])/u, days: 1 },
  { words: /(?<![\p{L}])(?<!(?:la|esta|pasado) )mañana(?![\p{L}])/iu, days: 1 },
  { words: /(?<![\p{L}])(?:yesterday|gestern|ayer|ieri|gisteren|ontem)(?![\p{L}])/iu, days: -1 },
  { words: /(?<![\p{L}])(?:übermorgen|après-demain|pasado mañana|dopodomani|overmorgen|depois de amanhã|day after tomorrow)(?![\p{L}])/iu, days: 2 },
  { words: /(?<![\p{L}])(?:vorgestern|avant-hier|anteayer|l'altro ieri|eergisteren|anteontem|day before yesterday)(?![\p{L}])/iu, days: -2 },
];

/**
 * "In" or "within" a number of days, in digits, each language with its own words only (a deadline: "within 14 days",
 * "innerhalb von 14 Tagen", "sous 10 jours", "entro 5 giorni", "binnen 7 dagen", "en 4 días", "em 2 dias").
 */
const IN_DAYS: RegExp[] = [
  /(?<![\p{L}])(?:in|within)\s+(\d{1,3})\s+days?(?![\p{L}])/giu,
  /(?<![\p{L}])(?:in|innerhalb von|innerhalb|binnen)\s+(\d{1,3})\s+tag(?:en)?(?![\p{L}])/giu,
  /(?<![\p{L}])(?:dans|sous)\s+(\d{1,3})\s+jours?(?![\p{L}])/giu,
  /(?<![\p{L}])(?:en|dentro de)\s+(\d{1,3})\s+días?(?![\p{L}])/giu,
  /(?<![\p{L}])(?:tra|fra|entro)\s+(\d{1,3})\s+giorn[oi](?![\p{L}])/giu,
  /(?<![\p{L}])(?:in|binnen|over)\s+(\d{1,3})\s+dag(?:en)?(?![\p{L}])/giu,
  /(?<![\p{L}])(?:em|dentro de)\s+(\d{1,3})\s+dias?(?![\p{L}])/giu,
];

const LOCALES = ["en", "de", "fr", "es", "it", "nl", "pt"];
/** Each weekday's long names (Sunday is index 0, as `getUTCDay`), lower case. Long names only: short ones are words too ("do", "so"). */
const WEEKDAYS: RegExp[] = Array.from({ length: 7 }, (_, weekday) => {
  const date = new Date(Date.UTC(2026, 10, 15 + weekday)); // 15 November 2026 is a Sunday
  const names = [...new Set(LOCALES.map((locale) => new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(date).toLowerCase()))];
  return new RegExp(`(?<![\\p{L}])(?:${names.join("|")})(?![\\p{L}])`, "iu");
});

/**
 * The dates the mail says relative to its own date, in any of its parts: for each word, each local date its message
 * may have (`localDates`: two days, since the server keeps the time in UTC and not the sender's offset) moved by the
 * word; for "in N days", moved by N; for a weekday's name, the days with that name from that date to a week after it,
 * that date included.
 */
export function relativeDates(sources: readonly DatedText[]): Set<string> {
  const dates = new Set<string>();
  for (const source of sources) {
    const local = localDates(source.at);
    for (const { words, days } of RELATIVE) {
      if (words.test(source.text)) for (const date of local) dates.add(addDays(date, days));
    }
    for (const pattern of IN_DAYS) {
      for (const match of source.text.matchAll(pattern)) for (const date of local) dates.add(addDays(date, Number(match[1])));
    }
    WEEKDAYS.forEach((pattern, weekday) => {
      if (!pattern.test(source.text)) return;
      for (const date of local) {
        for (let ahead = 0; ahead <= 7; ahead++) {
          const day = addDays(date, ahead);
          if (new Date(`${day}T00:00:00Z`).getUTCDay() === weekday) dates.add(day);
        }
      }
    });
  }
  return dates;
}

/**
 * The date a time is on when the answer gives none: the day the message that writes the time was sent, in the
 * server's `timeZone`, moved by a relative word that message has ("today", "morgen"); null when none has one, or the
 * words disagree. A weekday's name doesn't count here: "on Monday" may lie before its message or after it.
 */
export function dateOfTime(time: string, sources: readonly DatedText[], timeZone: string): string | null {
  const dates = new Set<string>();
  for (const source of sources) {
    if (!timesIn(source.text).has(time)) continue;
    const sent = zonedDate(source.at, timeZone);
    for (const { words, days } of RELATIVE) if (words.test(source.text)) dates.add(addDays(sent, days));
  }
  return dates.size === 1 ? [...dates][0]! : null;
}

/** Within a year of a message that writes it. */
function nearItsMessage(iso: string, sources: readonly DatedText[]): boolean {
  const date = calendarDate(iso)!;
  const day = Date.UTC(date.year, date.month - 1, date.day) / DAY_MS;
  return sources.some((source) => dateWrittenIn(iso, source.text) && Math.abs(day - Math.floor(source.at / DAY_MS)) <= EVENT_RANGE_DAYS);
}

/** The year a day and month written without one are in, for a message sent on `sent` (YYYY-MM-DD): `YEARLESS_PAST_DAYS`. */
function yearlessYear(month: number, day: number, sent: string): number {
  const message = calendarDate(sent)!;
  const before = (Date.UTC(message.year, message.month - 1, message.day) - Date.UTC(message.year, month - 1, day)) / DAY_MS;
  return before > YEARLESS_PAST_DAYS ? message.year + 1 : message.year;
}

/**
 * Written as a day and month without a year in a message, day first: "05.12." (the dot after the month needed, and
 * no digit after it) or "05/12" (no third part), in the year `yearlessYear` gives for one of the message's local days.
 */
function writtenWithoutYear(iso: string, sources: readonly DatedText[]): boolean {
  const date = calendarDate(iso)!;
  const pad = (n: number) => String(n).padStart(2, "0");
  const [days, months] = [`(?:${date.day}|${pad(date.day)})`, `(?:${date.month}|${pad(date.month)})`];
  const written = new RegExp(String.raw`(?<![\d./])${days}(?:\.${months}\.(?!\d)|/${months}(?![\d/]))`);
  return sources.some((source) => written.test(source.text) && localDates(source.at).some((sent) => yearlessYear(date.month, date.day, sent) === date.year));
}

/**
 * A date the model gave, as the server keeps it: written in the text within a year of its message (read day or month
 * first as `readingThatFits` decides), or written without a year in the year the rule gives, or said relative to a
 * message's own date and agreeing with it; else why not.
 */
export function checkDate(iso: string, text: string, sources: readonly DatedText[]): { date: string; swapped: boolean } | { dropped: string } {
  if (!calendarDate(iso)) return { dropped: "invalid_date" };
  const other = swappedDate(iso);
  if (dateWrittenIn(iso, text) || (other !== null && dateWrittenIn(other, text))) {
    const reading = readingThatFits(iso, text, (candidate) => dateWrittenIn(candidate, text) && nearItsMessage(candidate, sources));
    if (reading) return reading;
    if (!relativeDates(sources).has(iso) && !writtenWithoutYear(iso, sources)) return { dropped: "out_of_range" };
  }
  return writtenWithoutYear(iso, sources) || relativeDates(sources).has(iso) ? { date: iso, swapped: false } : { dropped: "not_in_text" };
}
