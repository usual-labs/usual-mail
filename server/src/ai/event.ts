// The server's checks on what a model says a notification tells of (docs/contract-ai.md, "Notification events"; the
// owner's request of 2026-11-19, and its audit). Nothing it says is kept unless the server can check it against the
// text the model was given: a status and what it is about as safe plain lines (a status without relative words, a
// dispatch with a later date read as arriving: event-lines.ts), a date only when the mail supports it (event-dates.ts),
// and times only when written, a time marked UTC converted to the server's time zone (event-times.ts). A time with no
// date takes the day its message was sent, moved by a relative word the same message has ("today"); else it is
// dropped. The reference the mail prints is kept only when written and shaped like one (event-reference.ts), to join
// notifications about the same thing. A fact that fails is dropped with a reason code, never anything of the mail. Pure.

import { EVENT_ABOUT_LIMIT, EVENT_STATUS_LIMIT, type NotificationEvent } from "@usualmail/core";
import { checkDate, dateOfTime } from "./event-dates.ts";
import { arrivingWhenLater, withoutRelativeWords, withoutSender } from "./event-lines.ts";
import { checkReference } from "./event-reference.ts";
import { fromUtc, markOf, readTimes, resetTimes } from "./event-times.ts";
import { zonedDate, type DatedText } from "./payment-dates.ts";
import { plainLine } from "./payment.ts";
import { acceptSummary } from "./prompt.ts";

export { dateOfTime, EVENT_RANGE_DAYS, relativeDates, YEARLESS_PAST_DAYS } from "./event-dates.ts";
export { timesIn } from "./event-times.ts";

/** A fact the server dropped, and why: a reason code only. */
export interface EventDrop {
  field: "answer" | "summary" | "status" | "about" | "date" | "time" | "endTime" | "reference";
  reason: string;
}

/**
 * What the server changed in an answer, logged by code: it gave a time its date (`dated`), took a relative word out of
 * the status (`relative_word`), named a dispatch with a later date "Arriving" (`arriving`), or converted a time marked
 * UTC to its time zone (`from_utc`).
 */
export type EventChange = "dated" | "relative_word" | "arriving" | "from_utc";

/** What `checkEvent` keeps, drops and changes; `reference` as the server keeps it (event-reference.ts), never served. */
export interface CheckedEvent {
  summary: string | null;
  event: NotificationEvent;
  reference: string | null;
  drops: EventDrop[];
  swapped: boolean;
  changes: EventChange[];
}

const NONE: NotificationEvent = { status: null, about: null, when: null };
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

interface RawEvent {
  summary: string | null;
  status: string | null;
  about: string | null;
  date: string | null;
  time: string | null;
  endTime: string | null;
  reference: string | null;
}

const FIELDS = ["summary", "status", "about", "date", "time", "endTime", "reference"] as const;

/** The model's object, if it has the shape asked for (a missing field reads as nothing), else null. */
function readRaw(value: unknown): RawEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const raw: Partial<RawEvent> = {};
  for (const field of FIELDS) {
    const given = record[field];
    if (given === undefined || given === null) raw[field] = null;
    else if (typeof given === "string") raw[field] = given.trim() || null;
    else return null;
  }
  return raw as RawEvent;
}

/**
 * The facts of one answer that check out against `text`, the text the model was given, with `sources` (each part with
 * its message's date) for its dates, and those dropped. `sender` is the sender's name as a party ("Parcelway"): `about`
 * is never that alone. The summary is checked as any summary. Dates and times are read in the server's `timeZone`.
 */
export function checkEvent(value: unknown, text: string, sources: readonly DatedText[], sender: string | null, timeZone = "UTC"): CheckedEvent {
  if (value === null || value === undefined) return { summary: null, event: NONE, reference: null, drops: [{ field: "answer", reason: "no_answer" }], swapped: false, changes: [] };
  const raw = readRaw(value);
  if (!raw) return { summary: null, event: NONE, reference: null, drops: [{ field: "answer", reason: "shape" }], swapped: false, changes: [] };
  const drops: EventDrop[] = [];
  const changes: EventChange[] = [];
  let summary: string | null = null;
  if (raw.summary !== null) {
    const verdict = acceptSummary(raw.summary);
    if ("summary" in verdict) summary = verdict.summary;
    else drops.push({ field: "summary", reason: verdict.dropped });
  }
  const event: NotificationEvent = { ...NONE };
  const status = plainLine(raw.status, EVENT_STATUS_LIMIT);
  if (status && "line" in status) {
    const kept = withoutRelativeWords(status.line);
    if ("line" in kept) {
      event.status = kept.line;
      if (kept.changed) changes.push("relative_word");
    } else drops.push({ field: "status", reason: kept.dropped });
  } else if (status) drops.push({ field: "status", reason: status.dropped });
  const about = plainLine(raw.about, EVENT_ABOUT_LIMIT);
  if (about && "line" in about) {
    const kept = withoutSender(about.line, sender);
    if ("line" in kept) event.about = kept.line;
    else drops.push({ field: "about", reason: kept.dropped });
  } else if (about) drops.push({ field: "about", reason: about.dropped });
  let reference: string | null = null;
  if (raw.reference !== null) {
    const verdict = checkReference(raw.reference, text);
    if ("reference" in verdict) reference = verdict.reference;
    else drops.push({ field: "reference", reason: verdict.dropped });
  }
  let swapped = false;
  let date: string | null = null;
  if (raw.date !== null) {
    const verdict = checkDate(raw.date, text, sources);
    if ("dropped" in verdict) drops.push({ field: "date", reason: verdict.dropped });
    else ({ date, swapped } = verdict);
  }
  const when = checkMoment(raw, event.status, date, text, sources, timeZone, drops, changes);
  if (when) event.when = when;
  // The day the newest message was sent, where the server runs: a dispatch with a later date is when it arrives.
  const newest = Math.max(...sources.map((source) => source.at));
  if (event.status && when && sources.length > 0) {
    const named = arrivingWhenLater(event.status, when.date, zonedDate(newest, timeZone));
    if (named !== event.status) {
      event.status = named;
      changes.push("arriving");
    }
  }
  return { summary, event, reference, drops, swapped, changes };
}

/**
 * The moment an answer gives, from its checked `date`: its times when written; with no date, a time takes
 * `dateOfTime`'s or goes; a time marked UTC is converted to `timeZone` on that date, which may move the date (an end
 * that lands on another day goes); one marked with another offset goes and the date stays. Drops and changes are
 * added to the lists given.
 */
function checkMoment(raw: RawEvent, status: string | null, checkedDate: string | null, text: string, sources: readonly DatedText[], timeZone: string, drops: EventDrop[], changes: EventChange[]): NotificationEvent["when"] {
  const written = readTimes(text);
  const clock = (field: "time" | "endTime"): string | null => {
    const given = raw[field];
    if (given === null) return null;
    const reason = !CLOCK.test(given) ? "invalid_time" : !written.has(given) ? "not_in_text" : null;
    if (reason) drops.push({ field, reason });
    return reason ? null : given;
  };
  let time = clock("time");
  let endTime = clock("endTime");
  let date = checkedDate;
  if (date === null && time !== null) {
    date = dateOfTime(time, sources, timeZone);
    if (date !== null) changes.push("dated");
  }
  if (date === null) {
    if (time !== null) drops.push({ field: "time", reason: "no_date" });
    if (endTime !== null) drops.push({ field: "endTime", reason: "no_date" });
    return null;
  }
  // A limit's reset is not when anything happens: its time goes, and its date unless it is the mail's own day.
  if (time !== null && limitLike(status) && resetTimes(text).has(time)) {
    drops.push({ field: "time", reason: "reset_time" });
    if (endTime !== null) drops.push({ field: "endTime", reason: "reset_time" });
    time = endTime = null;
    if (date !== zonedDate(Math.max(...sources.map((source) => source.at)), timeZone)) {
      drops.push({ field: "date", reason: "reset_time" });
      return null;
    }
  }
  const marks = { time: time && markOf(time, written), endTime: endTime && markOf(endTime, written) };
  for (const field of ["time", "endTime"] as const) {
    if (marks[field] !== "offset") continue;
    drops.push({ field, reason: "utc_offset" });
    if (field === "time") time = null;
    else endTime = null;
  }
  const day = date;
  if (time !== null && marks.time === "utc") {
    ({ date, time } = fromUtc(day, time, timeZone));
    changes.push("from_utc");
  }
  if (endTime !== null && marks.endTime === "utc") {
    const end = fromUtc(day, endTime, timeZone);
    if (!changes.includes("from_utc")) changes.push("from_utc");
    if (end.date === date) endTime = end.time;
    else {
      drops.push({ field: "endTime", reason: "two_days" });
      endTime = null;
    }
  }
  if (endTime !== null && (time === null || endTime <= time)) {
    drops.push({ field: "endTime", reason: "time_order" });
    endTime = null;
  }
  return { date, time, endTime };
}

/** A status about a limit or a quota ("75% of limit used", "Limit reached", "Usage alert"). */
export function limitLike(status: string | null): boolean {
  return status !== null && /(?<![\p{L}])(?:limits?|quotas?|usage|credits?|allowance)(?![\p{L}])/iu.test(status);
}

/**
 * A thread's event after an answer (mail joining it, or its first): when the answer gives a status, its status and
 * moment together, since they must agree (a "Delivered" with no date leaves no moment; clients show the mail's own
 * day); else the status and moment it had. `about` when the answer gives one, else the one it had. Never a group: the
 * server works that out (event-group.ts).
 */
export function combineEvent(before: NotificationEvent | null, checked: NotificationEvent): NotificationEvent {
  const kept = before ?? NONE;
  const pair = checked.status !== null ? { status: checked.status, when: checked.when } : { status: kept.status, when: kept.when };
  return { status: pair.status, about: checked.about ?? kept.about, when: pair.when };
}
