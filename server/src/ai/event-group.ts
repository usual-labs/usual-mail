// Which notifications of an inbox tell of the same thing (docs/contract-ai.md, "Notification groups"; the owner's
// "Yes, build it" of 2026-11-19, and the audit of its groups). A thread's key (`threads.event_key`, never served) is a
// hash of the inbox, its sender's domain and the reference its mail prints (event-reference.ts); without one, the key
// of the sender's notification about the same moment (an upcoming date and time, or an appointment's day and subject),
// or one made from its own moment; else none. Its served `event.group` is that key, unless more threads share it than
// one thing has, or (for a reference) they lie too far apart: then none of them has a group. Callers hold the lock.

import type { NotificationEvent } from "@usualmail/core";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { threads, type ThreadRow } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { emitThread, getThread } from "../service/store.ts";
import { serverTimeZone, zonedMinute } from "./payment-dates.ts";
import { senderKey } from "./payment-store.ts";

/**
 * More threads than this sharing a key are no one thing's: a sender that prints a customer number in all its mail
 * would otherwise make one row of everything it sends. A parcel's story (dispatched, arriving, out for delivery, a
 * missed delivery, delivered, picked up) or a booking's (confirmed, moved, reminded) stays well within it.
 */
export const GROUP_MAX_THREADS = 8;
/**
 * Threads sharing a reference whose newest mails lie further apart than this are no one thing's: a parcel's or an
 * order's mails, returns included, come within weeks, and a number seen again months later is a customer's or
 * account's. An appointment's key holds its day, so its mails may lie further apart (booked months ahead).
 */
export const GROUP_SPAN_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** An appointment or a booking, by its status's words ("Appointment moved", "Reservation confirmed", "Booking cancelled"). */
export function appointmentLike(status: string | null): boolean {
  return status !== null && /(?<![\p{L}])(?:appointments?|reservations?|bookings?)(?![\p{L}])/iu.test(status);
}

/** What an appointment is about, compared without case, punctuation or spacing ("Check-up with Dr. Moor"). */
function sameAbout(about: string): string {
  return about.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * An opaque key: "r" (a reference), "m" (a moment's date and time) or "a" (an appointment's subject and day) and 24
 * hex digits of a SHA-256 of the inbox, the sender and the parts. The same for the same inputs, and nothing can be read
 * back from it.
 */
export async function groupKey(kind: "r" | "a" | "m", inboxId: string, sender: string, parts: readonly string[]): Promise<string> {
  const input = new TextEncoder().encode(["usual-mail event group", kind, inboxId, sender, ...parts].join("\n"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return kind + [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A thread's sender as groups count it: as the payment details do (`senderKey`), else the domain after the @. */
function groupSender(address: string, ctx: Ctx): string {
  return senderKey(address, ctx.avatars?.suffixes ?? null) ?? address.toLowerCase().split("@").at(-1)!;
}

/**
 * What of an event can join it to the same sender's other notifications without a reference: its date, with its time
 * when that is still ahead of the mail (`sentAt`, both read in the server's time zone): an upcoming moment, not a
 * report of something that already happened at that minute (two builds that finished at one minute are two things);
 * for an appointment, what it is about; and, when it has no time at all, what it is about whatever its status
 * (2026-11-20: a "Reminder" and an "Approval pending" for one meetup, both dated with no time). Null when it has
 * none of these.
 */
export interface Moment {
  date: string;
  time: string | null;
  appointment: string | null;
  untimed: string | null;
}

export function momentOf(event: NotificationEvent, sentAt: number, timeZone: string): Moment | null {
  if (!event.when) return null;
  const { date, time } = event.when;
  const upcoming = time !== null && `${date} ${time}` > zonedMinute(sentAt, timeZone);
  const about = event.about ? sameAbout(event.about) || null : null;
  const appointment = appointmentLike(event.status) ? about : null;
  const untimed = time === null ? about : null;
  if (!upcoming && !appointment && !untimed) return null;
  return { date, time: upcoming ? time : null, appointment, untimed };
}

/**
 * The same moment: on one date, at the same upcoming time whatever the status or `about` say (a reminder and its
 * confirmation); or two appointments about the same thing (a confirmation and its move to another time that day); or
 * two events with no time on either about the same thing, whatever their statuses. Never a timed event with an
 * untimed one unless both are appointments, never two different things the sender names for one day.
 */
export function sameMoment(a: Moment, b: Moment): boolean {
  return a.date === b.date && ((a.time !== null && a.time === b.time) || (a.appointment !== null && a.appointment === b.appointment)
    || (a.untimed !== null && a.untimed === b.untimed));
}

/** A moment's own key: "m" from its date and time, or "a" from its subject and day (an appointment's, or an untimed event's). */
function momentKey(moment: Moment, inboxId: string, sender: string): Promise<string> {
  return moment.time !== null ? groupKey("m", inboxId, sender, [moment.date, moment.time]) : groupKey("a", inboxId, sender, [(moment.appointment ?? moment.untimed)!, moment.date]);
}

/** A thread with what its key is worked out from. */
export type Keyed = Pick<ThreadRow, "id" | "inboxId" | "sender" | "event" | "eventKey" | "lastMessageAt">;

/**
 * The key a moment takes among `others` (the same inbox's notifications, already keyed): the key most of those from
 * the same sender at the same moment share (the earliest one's on a tie), else its own. Reference keys aren't taken.
 */
export async function momentKeyAmong(ctx: Ctx, thread: Keyed, moment: Moment, sender: string, others: readonly Keyed[]): Promise<string> {
  const zone = serverTimeZone(ctx.host.timeZone);
  const counts = new Map<string, { count: number; first: number }>();
  for (const other of others) {
    if (other.id === thread.id || other.inboxId !== thread.inboxId || !other.eventKey || other.eventKey.startsWith("r") || !other.sender || !other.event) continue;
    if (groupSender(other.sender, ctx) !== sender) continue;
    const theirs = momentOf(other.event, other.lastMessageAt, zone);
    if (!theirs || !sameMoment(moment, theirs)) continue;
    const seen = counts.get(other.eventKey);
    counts.set(other.eventKey, { count: (seen?.count ?? 0) + 1, first: Math.min(seen?.first ?? Infinity, other.lastMessageAt) });
  }
  const best = [...counts].sort(([, a], [, b]) => b.count - a.count || a.first - b.first)[0];
  return best?.[0] ?? momentKey(moment, thread.inboxId, sender);
}

/**
 * A thread's key after an answer: from the answer's `reference`; else the key it had from a reference ("the reference
 * is kept when the answer has none"); else from its moment (`momentOf`, `momentKeyAmong` over the inbox's
 * notifications); else none.
 */
export async function eventKey(ctx: Ctx, thread: Keyed, event: NotificationEvent | null, reference: string | null): Promise<string | null> {
  if (!thread.sender) return null;
  const sender = groupSender(thread.sender, ctx);
  if (reference) return groupKey("r", thread.inboxId, sender, [reference]);
  if (thread.eventKey?.startsWith("r")) return thread.eventKey;
  const moment = event && momentOf(event, thread.lastMessageAt, serverTimeZone(ctx.host.timeZone));
  if (!moment) return null;
  const others = await ctx.db.select({ id: threads.id, inboxId: threads.inboxId, sender: threads.sender, event: threads.event, eventKey: threads.eventKey, lastMessageAt: threads.lastMessageAt })
    .from(threads).where(and(eq(threads.inboxId, thread.inboxId), eq(threads.category, "notification"), eq(threads.removed, false), isNotNull(threads.eventKey)));
  return momentKeyAmong(ctx, thread, moment, sender, others);
}

/**
 * The group a key gives threads whose newest mails came at `dates`: the key, or null when more than
 * `GROUP_MAX_THREADS` share it or, for a reference, they lie more than `GROUP_SPAN_DAYS` apart.
 */
export function groupFor(key: string, dates: readonly number[]): string | null {
  const spread = dates.length > 0 ? Math.max(...dates) - Math.min(...dates) : 0;
  return dates.length > GROUP_MAX_THREADS || (key.startsWith("r") && spread > GROUP_SPAN_DAYS * DAY_MS) ? null : key;
}

/** An event with its group, or without one. */
export function withGroup(event: NotificationEvent, group: string | null): NotificationEvent {
  const { status, about, when } = event;
  return group ? { status, about, when, group } : { status, about, when };
}

/**
 * The group the threads with `key` have now, counted with `joining` (a thread about to take the key): the key, or
 * null when more than `GROUP_MAX_THREADS` share it or, for a reference, their newest mails lie more than
 * `GROUP_SPAN_DAYS` apart. Every other thread with the key is given it, with a new version and a `thread.changed`
 * when it changes; the caller writes `joining`'s own. Logs a count only.
 */
export async function settleGroup(ctx: Ctx, inboxId: string, key: string, joining?: Pick<ThreadRow, "id" | "lastMessageAt">): Promise<string | null> {
  const rows = await ctx.db.select({ id: threads.id, event: threads.event, lastMessageAt: threads.lastMessageAt }).from(threads)
    .where(and(eq(threads.inboxId, inboxId), eq(threads.eventKey, key), eq(threads.category, "notification"), eq(threads.removed, false)));
  const others = rows.filter((row) => row.id !== joining?.id);
  const dates = [...others.map((row) => row.lastMessageAt), ...(joining ? [joining.lastMessageAt] : [])];
  const reference = key.startsWith("r");
  const group = groupFor(key, dates);
  let changed = 0;
  for (const row of others) {
    if (!row.event || (row.event.group ?? null) === group) continue;
    await ctx.db.update(threads).set({ event: withGroup(row.event, group), version: sql`${threads.version} + 1` }).where(eq(threads.id, row.id));
    emitThread(ctx, (await getThread(ctx, row.id))!);
    changed++;
  }
  if (group === null && changed > 0) {
    const what = reference ? "a reference" : "a moment";
    ctx.host.log.info(`AI event groups: ${what} on ${dates.length} threads isn't one thing's; they are shown apart`);
  }
  return group;
}

/**
 * Saves a notification's event and summary after an answer, with the key `reference` and the event give it and the
 * group that key has now: one new version and a `thread.changed` when what is served changed. The group it left, if
 * any, is settled again. Under the lock.
 */
export async function saveEvent(ctx: Ctx, thread: ThreadRow, event: NotificationEvent, summary: string | null, reference: string | null): Promise<void> {
  const key = await eventKey(ctx, thread, event, reference);
  const group = key ? await settleGroup(ctx, thread.inboxId, key, thread) : null;
  const next = withGroup(event, group);
  if (JSON.stringify(next) !== JSON.stringify(thread.event) || summary !== thread.summary) {
    await ctx.db.update(threads).set({ event: next, eventKey: key, summary, version: sql`${threads.version} + 1` }).where(eq(threads.id, thread.id));
    emitThread(ctx, (await getThread(ctx, thread.id))!);
  } else if (key !== thread.eventKey) {
    await ctx.db.update(threads).set({ eventKey: key }).where(eq(threads.id, thread.id));
  }
  if (thread.eventKey && thread.eventKey !== key) await settleGroup(ctx, thread.inboxId, thread.eventKey);
}
