// Notification groups end to end (docs/contract-ai.md, "Notification groups"; the owner's "Yes, build it" of
// 2026-11-19): the server says which notification threads of an inbox tell of the same thing, by a reference the mail
// prints (one sender's), or for an appointment by what it is about and its day; a reference on too many threads, or
// on threads too far apart, joins nothing; and once, at a first start, every notification is asked for its reference
// alone. Fake models only.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Inbox, MailEvent, Thread } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { EVENT_AGAIN } from "../src/ai/ask-again.ts";
import { MOMENT_PASS } from "../src/ai/passes.ts";
import { GROUP_MAX_THREADS, GROUP_SPAN_DAYS } from "../src/ai/event-group.ts";
import { serverState, threads } from "../src/db/index.ts";
import { dataItems, MailServer, type FakeRequest } from "../src/index.ts";
import { DAY, historyFromKnown, makeServer, START, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

const PARCELS = { name: "Parcelway", email: "updates@parcelway.example" };
const SHOP = { name: "Fernhill Books", email: "orders@fernhill.example" };
const DENTIST = { name: "Moor Dental", email: "appointments@moordental.example" };
const subjectOf = (sent: FakeRequest) => String(dataItems(sent.request.data)[0]?.subject);
const row = async (subject: string) => (await t.host.db.select().from(threads).where(eq(threads.subject, subject)).get())!;
const group = async (subject: string) => (await t.threadBySubject(subject)).event?.group ?? null;

async function connected(): Promise<Inbox> {
  const { inbox } = await t.connect({ address: "me@notices.example", history: [historyFromKnown] });
  await t.aiOn();
  return inbox;
}

/** The fake files everything as a notification and reads events as told by subject, else nothing. */
function fake(events: Record<string, Record<string, unknown> | null>): void {
  t.models.choose = () => "notification";
  t.models.extract = (request) => {
    const answer = events[String(dataItems(request.data)[0]?.subject)];
    return answer === undefined || answer === null ? null : { summary: null, status: null, about: null, date: null, time: null, endTime: null, reference: null, ...answer };
  };
}

describe("a reference the mail prints", () => {
  test("joins one sender's notifications about the same thing; another number or another sender is another thing", async () => {
    const inbox = await connected();
    fake({
      "Arriving": { status: "Arriving", reference: "PW 4471 2093" },
      "Out for delivery": { status: "Out for delivery", reference: "PW44712093" },
      "Delivered": { status: "Delivered", reference: "pw-4471-2093" },
      "Other parcel": { status: "Arriving", reference: "PW 9999 1234" },
      "Shop shipped": { status: "Dispatched", reference: "PW 4471 2093" },
      "Too short": { status: "Arriving", reference: "4711" },
    });
    await t.receive(inbox, { from: PARCELS, subject: "Arriving", text: "Your parcel PW-4471-2093 arrives soon." });
    await t.receive(inbox, { from: PARCELS, subject: "Out for delivery", text: "Parcel pw 4471 2093 is out for delivery." });
    await t.receive(inbox, { from: PARCELS, subject: "Delivered", text: "Parcel PW4471 2093 was delivered." });
    await t.receive(inbox, { from: PARCELS, subject: "Other parcel", text: "Your parcel PW-9999-1234 arrives soon." });
    await t.receive(inbox, { from: SHOP, subject: "Shop shipped", text: "Your order is on its way with Parcelway, tracking PW-4471-2093." });
    const short = await t.receive(inbox, { from: PARCELS, subject: "Too short", text: "Parcel 4711 arrives soon." });
    const parcel = await group("Arriving");
    assert.match(parcel ?? "", /^r[0-9a-f]{24}$/);
    assert.deepEqual([await group("Out for delivery"), await group("Delivered")], [parcel, parcel]);
    assert.ok(![parcel, null].includes(await group("Other parcel")), "another number");
    assert.ok(![parcel, null].includes(await group("Shop shipped")), "another sender's domain: a shop's and a carrier's mails stay apart");
    assert.equal(await group("Too short"), null);
    assert.ok(t.infos.includes(`AI event for ${short.id} dropped reference: length`));
    const served: Thread = await t.threadBySubject("Delivered");
    assert.deepEqual(Object.keys(served.event!).sort(), ["about", "group", "status", "when"], "the reference itself is never served");
    assert.ok(!JSON.stringify(await t.host.db.select().from(threads)).includes("PW44712093"), "nor stored");
  });

  test("mail joining keeps the thread's group when its answer gives no reference, and takes the status with its moment", async () => {
    const inbox = await connected();
    fake({ "Parcel 7": { status: "Out for delivery", about: "Parcel 7", date: "2026-11-16", time: "15:15", endTime: "18:15", reference: "PW 4471 2093" } });
    const parcel = await t.receive(inbox, { from: PARCELS, subject: "Parcel 7", text: "Parcel PW-4471-2093 is out for delivery today, 3:15–6:15 pm.", messageId: "p7@parcelway.example" });
    const before = await group("Parcel 7");
    t.models.extract = () => ({ summary: "Delivered", status: "Delivered", about: null, date: null, time: null, endTime: null, reference: null });
    t.mailboxes.get(inbox.address)!.deliver({ from: PARCELS, subject: "Re: Parcel 7", text: "Delivered.", inReplyTo: "p7@parcelway.example" });
    await t.sync(inbox);
    const after = (await t.host.db.select().from(threads).where(eq(threads.id, parcel.id)).get())!;
    assert.deepEqual(after.event, { status: "Delivered", about: "Parcel 7", when: null, group: before });
  });
});

describe("an appointment", () => {
  test("joins its confirmation and its move on the same day by what it is about; another day or another kind of event doesn't", async () => {
    const inbox = await connected();
    fake({
      "Confirmed": { status: "Appointment confirmed", about: "Check-up with Dr. Moor", date: "2026-11-23", time: "12:00" },
      "Moved": { status: "Appointment moved", about: "check-up with Dr Moor", date: "2026-11-23", time: "09:40" },
      "Moved again": { status: "Appointment moved", about: "Check-up with Dr. Moor", date: "2026-11-30", time: "09:40" },
      "Payment": { status: "Payment failed", about: "Check-up with Dr. Moor", date: "2026-11-23" },
    });
    await t.receive(inbox, { from: DENTIST, subject: "Confirmed", text: "Your check-up with Dr. Moor is confirmed for 23 November 2026 at 12:00." });
    await t.receive(inbox, { from: DENTIST, subject: "Moved", text: "Your check-up with Dr. Moor on 23 November 2026 moved from 12:00 to 9:40." });
    await t.receive(inbox, { from: DENTIST, subject: "Moved again", text: "Your check-up with Dr. Moor moved to 30 November 2026 at 9:40." });
    await t.receive(inbox, { from: DENTIST, subject: "Payment", text: "Payment for your check-up with Dr. Moor on 23 November 2026 failed." });
    const appointment = await group("Confirmed");
    assert.match(appointment ?? "", /^[am][0-9a-f]{24}$/);
    assert.equal(await group("Moved"), appointment);
    assert.ok(![appointment, null].includes(await group("Moved again")), "moved to another day: not joined to its old mail");
    assert.notEqual(await group("Payment"), appointment, "a payment with no time doesn't join an appointment with one");
  });
});

describe("one sender's notifications about the same moment", () => {
  test("join whatever their status or about say: a reminder, a confirmation and its move that day; a meetup's three mails", async () => {
    const inbox = await connected();
    const MEETUP = { name: "Meetups", email: "events@meetups.example" };
    const day = { date: "2026-11-23" };
    fake({
      "Reminder": { status: "Reminder", about: "Your health professional", ...day, time: "12:00" },
      "Confirmed": { status: "Appointment confirmed", about: "Check-up with Dr. Moor", ...day, time: "12:00" },
      "Moved": { status: "Appointment moved", about: "Check-up with Dr Moor", ...day, time: "09:40" },
      "Reminder again": { status: "Reminder", about: "Your appointment", ...day, time: "09:40" },
      "Pending": { status: "Approval pending", about: "Board games night", ...day, time: "19:00" },
      "Reserved": { status: "Reservation confirmed", about: "Games night", ...day, time: "19:00" },
      "Meetup reminder": { status: "Reminder", about: "Tonight", ...day, time: "19:00" },
    });
    const on = "on 23 November 2026";
    await t.receive(inbox, { from: DENTIST, subject: "Reminder", text: `Reminder: your appointment with your health professional ${on} at 12:00.` });
    await t.receive(inbox, { from: DENTIST, subject: "Confirmed", text: `Your check-up with Dr. Moor is confirmed ${on} at 12:00.` });
    await t.receive(inbox, { from: DENTIST, subject: "Moved", text: `Your check-up with Dr. Moor ${on} moved from 12:00 to 9:40.` });
    await t.receive(inbox, { from: DENTIST, subject: "Reminder again", text: `Reminder: your appointment ${on} at 9:40.` });
    for (const subject of ["Pending", "Reserved", "Meetup reminder"]) await t.receive(inbox, { from: MEETUP, subject, text: `Board games night ${on} at 19:00.` });
    const dentist = await group("Reminder");
    assert.ok(dentist !== null);
    assert.deepEqual([await group("Confirmed"), await group("Moved"), await group("Reminder again")], [dentist, dentist, dentist]);
    const meetup = await group("Pending");
    assert.ok(meetup !== null && meetup !== dentist);
    assert.deepEqual([await group("Reserved"), await group("Meetup reminder")], [meetup, meetup]);
  });

  test("with no time on either, one sender's events on one date about the same thing join; another about doesn't (2026-11-20)", async () => {
    const inbox = await connected();
    const MEETUP = { name: "Meetups", email: "events@meetups.example" };
    const on = { date: "2026-11-23" };
    fake({
      "Approval": { status: "Approval pending", about: "Board games night", ...on },
      "Reminder": { status: "Reminder", about: "Board Games Night", ...on },
      "Quiz": { status: "Reminder", about: "Quiz night", ...on },
    });
    for (const subject of ["Approval", "Reminder", "Quiz"]) await t.receive(inbox, { from: MEETUP, subject, text: "Board games night and quiz night on 23 November 2026." });
    const night = await group("Approval");
    assert.match(night ?? "", /^a[0-9a-f]{24}$/, "the subject and day's key");
    assert.equal(await group("Reminder"), night);
    assert.ok(![night, null].includes(await group("Quiz")), "another about that day: its own");
  });

  test("two builds that finished at one minute are two things: a time already past when the mail came joins nothing", async () => {
    const inbox = await connected();
    const TOOL = { name: "Builds", email: "builds@ci.example" };
    fake({ "Build 1 failed": { status: "Build failed", date: "2026-11-16", time: "14:30" }, "Build 2 failed": { status: "Build failed", date: "2026-11-16", time: "14:30" } });
    for (const subject of ["Build 1 failed", "Build 2 failed"]) {
      await t.receive(inbox, { from: TOOL, subject, text: "The build failed on 16 November 2026 at 14:30.", date: "2026-11-16T14:31:00Z" });
    }
    assert.deepEqual([await group("Build 1 failed"), await group("Build 2 failed")], [null, null]);
  });
});

describe("over-grouping", () => {
  test(`a reference on more than ${GROUP_MAX_THREADS} of a sender's notifications is no one thing's: all of them lose the group`, async () => {
    const inbox = await connected();
    const events: Record<string, Record<string, unknown>> = {};
    for (let n = 1; n <= GROUP_MAX_THREADS + 1; n++) events[`Notice ${n}`] = { status: "Password changed", reference: "KD-482913" };
    fake(events);
    for (let n = 1; n <= GROUP_MAX_THREADS; n++) await t.receive(inbox, { from: SHOP, subject: `Notice ${n}`, text: `Customer number KD-482913. Notice ${n}.` });
    const shared = await group("Notice 1");
    assert.ok(shared !== null && (await group(`Notice ${GROUP_MAX_THREADS}`)) === shared, `${GROUP_MAX_THREADS} threads: still one thing`);
    await t.receive(inbox, { from: SHOP, subject: `Notice ${GROUP_MAX_THREADS + 1}`, text: `Customer number KD-482913. Notice ${GROUP_MAX_THREADS + 1}.` });
    for (let n = 1; n <= GROUP_MAX_THREADS + 1; n++) assert.equal(await group(`Notice ${n}`), null, `Notice ${n}`);
    assert.ok(t.infos.includes(`AI event groups: a reference on ${GROUP_MAX_THREADS + 1} threads isn't one thing's; they are shown apart`));
  });

  test(`a reference on threads more than ${GROUP_SPAN_DAYS} days apart joins nothing; an appointment's day may be booked long before`, async () => {
    const inbox = await connected();
    fake({
      "Old order": { status: "Order confirmed", reference: "55-12345" },
      "New order": { status: "Dispatched", reference: "55-12345" },
      "Booked early": { status: "Appointment confirmed", about: "Check-up with Dr. Moor", date: "2026-11-23", time: "12:00" },
      "Moved late": { status: "Appointment moved", about: "Check-up with Dr. Moor", date: "2026-11-23", time: "09:40" },
    });
    await t.receive(inbox, { from: SHOP, subject: "Old order", text: "Order 55-12345 confirmed." });
    await t.receive(inbox, { from: DENTIST, subject: "Booked early", text: "Your check-up with Dr. Moor is confirmed for 23 November 2026 at 12:00." });
    const longAgo = Date.parse(START) - (GROUP_SPAN_DAYS + 10) * DAY;
    for (const subject of ["Old order", "Booked early"]) await t.host.db.update(threads).set({ lastMessageAt: longAgo }).where(eq(threads.subject, subject));
    await t.receive(inbox, { from: SHOP, subject: "New order", text: "Order 55-12345 is on its way." });
    await t.receive(inbox, { from: DENTIST, subject: "Moved late", text: "Your check-up with Dr. Moor on 23 November 2026 moved from 12:00 to 9:40." });
    assert.deepEqual([await group("Old order"), await group("New order")], [null, null]);
    const appointment = await group("Booked early");
    assert.ok(appointment !== null && (await group("Moved late")) === appointment);
  });
});

describe("at the first start of a build with moment groups", () => {
  test("what is stored is grouped again by rule, once, and a limit's stored reset time goes; changed threads are announced", async () => {
    const inbox = await connected();
    fake({});
    const on = "on 23 November 2026";
    await t.receive(inbox, { from: DENTIST, subject: "Reminder", text: `Reminder: your appointment ${on} at 12:00.` });
    await t.receive(inbox, { from: DENTIST, subject: "Confirmed", text: `Your check-up with Dr. Moor is confirmed ${on} at 12:00.` });
    await t.receive(inbox, { from: SHOP, subject: "Usage", text: "You have used 75% of your monthly limit. It resets on 1 December 2026 at 00:00 UTC." });
    await t.receive(inbox, { from: PARCELS, subject: "Parcel", text: "Parcel PW-4471-2093 arrives soon." });
    await t.server.stop();
    // As the owner's store: events and groups from before moments, the snippets' pass had.
    const set = (subject: string, values: Record<string, unknown>) => t.host.db.update(threads).set(values).where(eq(threads.subject, subject));
    const when = { date: "2026-11-23", time: "12:00", endTime: null };
    await set("Reminder", { event: { status: "Reminder", about: "Your health professional", when }, eventKey: null });
    await set("Confirmed", { event: { status: "Appointment confirmed", about: "Check-up with Dr. Moor", when, group: "aold" }, eventKey: "aold" });
    await set("Usage", { event: { status: "75% of limit used", about: null, when: { date: "2026-12-01", time: "00:00", endTime: null } }, eventKey: null });
    await set("Parcel", { event: { status: "Arriving", about: null, when: null, group: "rkept" }, eventKey: "rkept" });
    await t.host.db.update(serverState).set({ paymentRulesApplied: "2026-11-19 plain snippets" });
    const versions = new Map((await t.host.db.select().from(threads)).map((each) => [each.subject, each.version]));
    t.models.requests.length = 0;
    const events: MailEvent[] = [];
    const stop = t.host.events.subscribe((event) => events.push(event));
    const again = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await again.start();
    await again.whenIdle();
    stop();
    const reminder = await row("Reminder");
    assert.match(reminder.event?.group ?? "", /^m[0-9a-f]{24}$/);
    assert.equal((await row("Confirmed")).event?.group, reminder.event?.group, "a reminder and its confirmation, by their moment");
    assert.deepEqual((await row("Usage")).event, { status: "75% of limit used", about: null, when: null }, "a reset time is no moment");
    assert.deepEqual([(await row("Parcel")).eventKey, (await row("Parcel")).event?.group], ["rkept", "rkept"], "a reference's group stays");
    assert.equal((await row("Parcel")).version, versions.get("Parcel"), "unchanged: no new version");
    const announced = events.filter((event): event is Extract<MailEvent, { type: "thread.changed" }> => event.type === "thread.changed").map((event) => event.thread.subject).sort();
    assert.deepEqual(announced, ["Confirmed", "Reminder", "Usage"]);
    assert.deepEqual(t.models.requests, [], "by rule: no AI request");
    assert.ok(t.infos.includes("Notification groups by rule: 3 threads changed, 1 reset time dropped"));
    assert.equal((await t.host.db.select().from(serverState).get())!.paymentRulesApplied, MOMENT_PASS);
    await again.stop();

    // The next build's pass (2026-11-20): two untimed events of one sender about the same thing that day join.
    await t.host.db.update(threads).set({ event: { status: "Approval pending", about: "Games night", when: { date: "2026-11-23", time: null, endTime: null } }, eventKey: null }).where(eq(threads.subject, "Reminder"));
    await t.host.db.update(threads).set({ event: { status: "Reminder", about: "Games Night", when: { date: "2026-11-23", time: null, endTime: null } }, eventKey: null }).where(eq(threads.subject, "Confirmed"));
    await t.host.db.update(serverState).set({ paymentRulesApplied: "2026-11-19 moment groups" });
    t.infos.length = 0;
    const next = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await next.start();
    await next.whenIdle();
    assert.match((await row("Reminder")).event?.group ?? "", /^a[0-9a-f]{24}$/);
    assert.equal((await row("Confirmed")).event?.group, (await row("Reminder")).event?.group);
    assert.ok(t.infos.includes("Notification groups by rule: 2 threads changed, 0 reset times dropped"));
    await next.stop();

    t.infos.length = 0;
    const third = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await third.start();
    await third.whenIdle();
    assert.ok(!t.infos.some((line) => line.startsWith("Notification groups by rule")), "once");
    await third.stop();
  });
});

describe("at the first start of a build with groups", () => {
  test("every notification not done is asked once for its reference alone: what it has stays; an unusable answer still groups an appointment", async () => {
    const inbox = await connected();
    fake({});
    const text = "Your parcel PW-4471-2093 is on its way.";
    for (const subject of ["Parcel A", "Parcel B", "Done one"]) await t.receive(inbox, { from: PARCELS, subject, text });
    for (const subject of ["Dentist confirmed", "Dentist moved"]) await t.receive(inbox, { from: DENTIST, subject, text: "Your check-up with Dr. Moor on 23 November 2026." });
    await t.receive(inbox, { from: PARCELS, subject: "No event yet", text });
    await t.server.act(t.person, { threadIds: [(await t.threadBySubject("Done one")).id], action: { kind: "done" } });
    await t.server.stop();
    // As the owner's store: events from before groups, the audit's asking-again had.
    const set = async (subject: string, event: unknown) => t.host.db.update(threads).set({ event: event as never, summary: "Old summary" }).where(eq(threads.subject, subject));
    const parcelA = { status: "Out for delivery", about: "Parcel A", when: null };
    await set("Parcel A", parcelA);
    await set("Parcel B", { status: "Arriving", about: null, when: null });
    await set("Done one", parcelA);
    const dentist = (status: string, time: string) => ({ status, about: "Check-up with Dr. Moor", when: { date: "2026-11-23", time, endTime: null } });
    await set("Dentist confirmed", dentist("Appointment confirmed", "12:00"));
    await set("Dentist moved", dentist("Appointment moved", "09:40"));
    await set("No event yet", null);
    await t.host.db.update(serverState).set({ detailsAskedAgain: "2026-11-19 event audit" });
    t.models.requests.length = 0;
    fake({
      "Parcel A": { summary: "New summary", status: "Delivered", about: "Something else", date: "2026-11-16", reference: "PW 4471 2093" },
      "Parcel B": { status: "Dispatched", reference: "PW-4471-2093" },
      "Dentist confirmed": null,
      "Dentist moved": {},
      "No event yet": { status: "Dispatched", reference: "PW 4471 2093" },
    });
    const again = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await again.start();
    await again.whenIdle();
    assert.deepEqual(t.models.sent("extract").map(subjectOf).sort(), ["Dentist confirmed", "Dentist moved", "No event yet", "Parcel A", "Parcel B"], "every notification not done");
    const a = await row("Parcel A");
    assert.deepEqual([a.event?.status, a.event?.about, a.event?.when, a.summary], ["Out for delivery", "Parcel A", null, "Old summary"], "only the reference is taken");
    assert.match(a.event?.group ?? "", /^r[0-9a-f]{24}$/);
    assert.deepEqual([(await row("Parcel B")).event, (await row("Parcel B")).summary], [{ status: "Arriving", about: null, when: null, group: a.event!.group }, "Old summary"]);
    assert.equal((await row("No event yet")).event?.status, "Dispatched", "a thread with no event yet takes its answer as any");
    assert.equal((await row("No event yet")).event?.group, a.event!.group);
    const confirmed = (await row("Dentist confirmed")).event;
    assert.deepEqual(confirmed, { ...dentist("Appointment confirmed", "12:00"), group: confirmed?.group });
    assert.match(confirmed?.group ?? "", /^[am][0-9a-f]{24}$/);
    assert.equal((await row("Dentist moved")).event?.group, confirmed?.group, "from what is stored");
    assert.equal((await row("Done one")).event?.group, undefined, "a done one isn't asked");
    assert.ok((await t.host.db.select().from(threads)).every((each) => !each.paymentAgain));
    assert.equal((await t.host.db.select().from(serverState).get())!.detailsAskedAgain, EVENT_AGAIN);
    assert.ok(t.infos.includes("The AI is asked again about the events of 5 notifications"));
    await again.stop();

    t.models.requests.length = 0;
    const third = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await third.start();
    await third.whenIdle();
    assert.equal(t.models.requests.length, 0, "once");
    await third.stop();
  });
});
