// A notification's event (docs/contract-ai.md, "Notification events"): the summarize job asks for the summary and the
// event in one request, whoever filed the thread, with exactly what a summary request carries; the server keeps only
// what it can check, combines field by field when mail joins, removes it when the thread leaves `notification`, and
// asks for every notification without one at the first start. Fake models only: these pin the plumbing and the checks,
// never how well a model reads a notification.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Inbox, MailEvent, NotificationEvent } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { eventInstructions } from "../src/ai/prompt.ts";
import { threads } from "../src/db/index.ts";
import { dataItems, MailServer, type FakeRequest } from "../src/index.ts";
import { historyFromKnown, listen, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

const PARCELS = { name: "Parcelway", email: "updates@parcelway.example" };
const subjectOf = (sent: FakeRequest) => String(dataItems(sent.request.data)[0]?.subject);
/** An event's facts, without the group the server gives an upcoming moment (ai-event-groups-pipeline tests groups). */
const facts = (event: NotificationEvent | null | undefined) => event && { status: event.status, about: event.about, when: event.when };
const row = async (subject: string) => (await t.host.db.select().from(threads).where(eq(threads.subject, subject)).get())!;

async function connected(): Promise<Inbox> {
  const { inbox } = await t.connect({ address: "me@notices.example", history: [historyFromKnown, { ...historyFromKnown, from: PARCELS, subject: "Earlier parcel" }] });
  await t.aiOn();
  return inbox;
}

/** The fake files everything as a notification and reads events as told by subject, else nothing. */
function fake(events: Record<string, Record<string, unknown> | null>): void {
  t.models.choose = () => "notification";
  t.models.extract = (request) => {
    const answer = events[String(dataItems(request.data)[0]?.subject)];
    return answer === undefined || answer === null ? null : { summary: null, status: null, about: null, date: null, time: null, endTime: null, ...answer };
  };
}

describe("a notification", () => {
  test("is asked for its summary and its event in one request, with exactly what a summary request carries", async () => {
    const inbox = await connected();
    fake({ "Out for delivery": { summary: "Your parcel arrives this afternoon", status: "Out for delivery", about: "Parcel from Fernhill Books", date: "2026-11-16", time: "15:15", endTime: "18:15" } });
    const heard = listen(t);
    const thread = await t.receive(inbox, { from: PARCELS, subject: "Out for delivery", text: "Your parcel from Fernhill Books is out for delivery today, 3:15–6:15 pm. Track it at updates@parcelway.example.", date: "2026-11-16T07:05:00Z" });
    heard.stop();
    assert.deepEqual(t.models.requests.map((r) => r.kind), ["choose", "extract"], "no separate summary request");
    const sent = t.models.sent("extract")[0]!;
    const items = dataItems(sent.request.data);
    assert.deepEqual([items[0], Object.keys(items[1]!), items[1]!.from, items[1]!.sent], [{ subject: "Out for delivery" }, ["from", "sent", "text"], "Parcelway", "Monday 2026-11-16"],
      "each message with the day it was sent, in UTC on a host that gives no time zone");
    assert.ok(!sent.request.data.includes("updates@parcelway"), "no address, as for a summary");
    assert.equal(sent.request.instructions, eventInstructions(/id="([0-9a-f]{18})"/.exec(sent.request.data)![1]!));
    assert.equal(sent.request.model, "fake/summarize");
    const after = await t.threadBySubject("Out for delivery");
    assert.deepEqual(facts(after.event), { status: "Out for delivery", about: "Parcel from Fernhill Books", when: { date: "2026-11-16", time: "15:15", endTime: "18:15" } });
    assert.match(after.event?.group ?? "", /^m[0-9a-f]{24}$/, "an upcoming moment: its own group until the sender's next mail about it");
    assert.equal(after.summary, "Your parcel arrives this afternoon");
    const changed = heard.events.filter((event): event is Extract<MailEvent, { type: "thread.changed" }> => event.type === "thread.changed" && event.thread.id === thread.id);
    assert.deepEqual(changed.at(-1)!.thread.event, after.event);
  });

  test("keeps only what it can check, logging each drop by its reason alone", async () => {
    const inbox = await connected();
    fake({ "Moved": { summary: "Your appointment moved", status: "Appointment moved", about: "Parcelway", date: "2026-12-02", time: "09:40" } });
    const thread = await t.receive(inbox, { from: PARCELS, subject: "Moved", text: "Your appointment was moved to 9:40 am next week.", date: "2026-11-16T07:05:00Z" });
    assert.deepEqual((await t.threadBySubject("Moved")).event, { status: "Appointment moved", about: null, when: null });
    assert.deepEqual(t.infos.filter((line) => line.startsWith("AI event for")), [
      `AI event for ${thread.id} dropped about: only_sender`,
      `AI event for ${thread.id} dropped date: not_in_text`,
      `AI event for ${thread.id} dropped time: no_date`,
    ]);
  });

  test("a notice with no event gets an empty one, and an unusable answer too: neither is asked again until mail joins", async () => {
    const inbox = await connected();
    fake({ "Digest": { summary: "What your friends shared" }, "Odd": null });
    await t.receive(inbox, { from: PARCELS, subject: "Digest", text: "See what people shared this week." });
    await t.receive(inbox, { from: PARCELS, subject: "Odd", text: "Hello." });
    assert.deepEqual((await t.threadBySubject("Digest")).event, { status: null, about: null, when: null });
    assert.deepEqual((await t.threadBySubject("Odd")).event, { status: null, about: null, when: null });
    t.models.requests.length = 0;
    await t.tick(60_000);
    assert.equal(t.models.requests.length, 0);
    assert.equal((await t.server.aiStatus(t.person)).pending, 0);
  });

  test("mail joining: a status comes with its moment, so a later Delivered with no date has none; about is kept", async () => {
    const inbox = await connected();
    fake({ "Parcel 7": { summary: "Dispatched", status: "Dispatched", about: "Parcel 7", date: "2026-11-18" } });
    const parcel = await t.receive(inbox, { from: PARCELS, subject: "Parcel 7", text: "Dispatched, arriving on 18 November.", messageId: "p7@parcelway.example", date: "2026-11-16T07:05:00Z" });
    const byId = async () => (await t.host.db.select().from(threads).where(eq(threads.id, parcel.id)).get())!;
    const mailbox = t.mailboxes.get(inbox.address)!;
    t.models.extract = () => ({ summary: "Arrives today", status: "Out for delivery", about: null, date: "2026-11-18", time: "15:15", endTime: "18:15" });
    mailbox.deliver({ from: PARCELS, subject: "Re: Parcel 7", text: "Out for delivery today, 3:15–6:15 pm.", inReplyTo: "p7@parcelway.example", messageId: "p7b@parcelway.example", date: "2026-11-18T07:00:00Z" });
    await t.sync(inbox);
    assert.deepEqual(facts((await byId()).event), { status: "Out for delivery", about: "Parcel 7", when: { date: "2026-11-18", time: "15:15", endTime: "18:15" } });
    t.models.extract = () => ({ summary: "Delivered", status: "Delivered", about: null, date: null, time: null, endTime: null });
    mailbox.deliver({ from: PARCELS, subject: "Re: Parcel 7", text: "Delivered.", inReplyTo: "p7b@parcelway.example", date: "2026-11-18T16:00:00Z" });
    await t.sync(inbox);
    assert.deepEqual((await byId()).event, { status: "Delivered", about: "Parcel 7", when: null }, "the window went with its status (the decision of 2026-11-19)");
    assert.equal((await byId()).summary, "Delivered");
  });

  test("a time with no date takes the day its message was sent in the server's time zone, when that message says \"today\"", async () => {
    const inbox = await connected();
    t.host.timeZone = "Europe/Berlin";
    fake({ "Out tonight": { summary: "Your parcel arrives today", status: "Out for delivery", time: "15:15", endTime: "18:15" }, "No day": { status: "Out for delivery", time: "15:15" } });
    // Sent at 23:30 UTC on Sunday: Monday already where the server runs.
    const thread = await t.receive(inbox, { from: PARCELS, subject: "Out tonight", text: "Your parcel is out for delivery today, 3:15–6:15 pm.", date: "2026-11-15T23:30:00Z" });
    assert.equal(dataItems(t.models.sent("extract")[0]!.request.data)[1]!.sent, "Monday 2026-11-16");
    assert.deepEqual(facts((await t.threadBySubject("Out tonight")).event), { status: "Out for delivery", about: null, when: { date: "2026-11-16", time: "15:15", endTime: "18:15" } });
    assert.ok(t.infos.includes(`AI event for ${thread.id} took its date from the day its message was sent`));
    const plain = await t.receive(inbox, { from: PARCELS, subject: "No day", text: "Your parcel arrives 3:15–6:15 pm.", date: "2026-11-15T23:30:00Z" });
    assert.deepEqual((await t.threadBySubject("No day")).event, { status: "Out for delivery", about: null, when: null });
    assert.ok(t.infos.includes(`AI event for ${plain.id} dropped time: no_date`), "no relative word: still dropped");
  });

  test("leaving notification removes the event and asks for a summary; coming back asks for the event again", async () => {
    const inbox = await connected();
    fake({ "Notice 4": { summary: "A notice", status: "Password changed" } });
    const thread = await t.receive(inbox, { from: PARCELS, subject: "Notice 4", text: "Your password was changed." });
    t.models.requests.length = 0;
    t.models.write = () => "Now a newsletter";
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } });
    await t.server.whenIdle();
    assert.deepEqual([(await t.threadBySubject("Notice 4")).event, (await t.threadBySubject("Notice 4")).summary], [undefined, "Now a newsletter"]);
    assert.deepEqual(t.models.requests.map((r) => r.kind), ["write"]);
    t.models.requests.length = 0;
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "notification" } });
    await t.server.whenIdle();
    assert.deepEqual(t.models.requests.map((r) => r.kind), ["extract"], "whoever files it");
    assert.equal((await t.threadBySubject("Notice 4")).event?.status, "Password changed");
  });

  test("at the first start of a build with events, every notification without one is asked, once; a summary is replaced only by one", async () => {
    const inbox = await connected();
    fake({});
    for (const subject of ["Notice A", "Notice B", "Notice done"]) await t.receive(inbox, { from: PARCELS, subject, text: "Your password was changed." });
    await t.server.act(t.person, { threadIds: [(await t.threadBySubject("Notice done")).id], action: { kind: "done" } });
    await t.server.stop();
    // As a store from before events: none on any thread, the old summaries kept, nothing due.
    await t.host.db.update(threads).set({ event: null, summary: "Old summary", summaryDue: false });
    t.models.requests.length = 0;
    fake({ "Notice A": { summary: "New summary", status: "Password changed" }, "Notice B": { status: "Password changed" } });
    const again = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await again.start();
    await again.whenIdle();
    assert.deepEqual(t.models.sent("extract").map(subjectOf).sort(), ["Notice A", "Notice B"], "not a done one");
    assert.deepEqual([(await row("Notice A")).summary, (await row("Notice B")).summary], ["New summary", "Old summary"]);
    assert.equal((await row("Notice B")).event?.status, "Password changed");
    assert.equal((await again.aiStatus(t.person)).pending, 0);
    await again.stop();
  });
});
