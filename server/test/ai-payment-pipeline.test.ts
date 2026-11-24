// A receipt's or an invoice's details (docs/contract-ai.md, "Payment details"): the summarize job asks for them in
// place of a summary, whoever filed the thread, with exactly what a summary request carries; the server keeps only
// what it can check, removes them when the thread leaves those categories, and asks again when mail joins. Fake
// models only: these pin the plumbing and the checks, never how well a model reads a receipt.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Inbox, MailEvent } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { EVENT_AGAIN } from "../src/ai/ask-again.ts";
import { detailsInstructions } from "../src/ai/prompt.ts";
import { serverState, threads } from "../src/db/index.ts";
import { dataItems, MailServer, type FakeRequest } from "../src/index.ts";
import { historyFromKnown, KNOWN, listen, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

const SHOP = { name: "Lumen Outdoor", email: "orders@lumenoutdoor.example" };
const STRANGER = { name: "Sam Stranger", email: "sam@unknown.example" };
const subjectOf = (sent: FakeRequest) => String(dataItems(sent.request.data)[0]?.subject);

async function connected(): Promise<Inbox> {
  const { inbox } = await t.connect({ address: "me@pay.example", history: [historyFromKnown, { ...historyFromKnown, from: SHOP, subject: "Earlier order" }] });
  await t.aiOn();
  return inbox;
}

/** The fake files by subject (a receipt unless told) and reads details as told, else nothing. */
function fake(categories: Record<string, string>, details: Record<string, Record<string, unknown> | null>): void {
  t.models.choose = (request) => categories[String(dataItems(request.data)[0]?.subject)] ?? "receipt";
  t.models.extract = (request) => {
    const answer = details[String(dataItems(request.data)[0]?.subject)];
    return answer === undefined ? null : answer === null ? null : { party: null, amount: null, currency: null, refund: false, state: null, dueDate: null, what: null, ...answer };
  };
}

describe("the details request's words", () => {
  test("say which kind the thread is filed as, and what each field is and isn't", () => {
    const id = "0123456789abcdef01";
    assert.equal(detailsInstructions(id, "invoice").split(" The mail is inside")[0], [
      "This email thread is filed as an invoice: a bill the reader owes. Read it for the person who received it and fill",
      "in each field, or null when the mail doesn't say it. party: the shop or service the person bought from or owes, as",
      "it calls itself, without a legal suffix such as GmbH, Inc. or Ltd.; never the payment service, reseller or wallet",
      "that only handled the payment (such as PayPal, Stripe, Klarna, Adyen, Paddle, FastSpring, Apple Pay or Google Pay).",
      "state: \"paid\" when the mail says the money was paid, charged or received, or shows a payment confirmation;",
      "\"scheduled\" only when it says the amount will be collected, debited or charged automatically or on a date (a direct",
      "debit, a card on file, an instalment or a renewal); \"due\" when it asks the reader to pay or gives payment",
      "instructions; null when it says none of these. amount: the amount this message says was paid, will be charged or",
      "is owed now, from the newest message that states one, exactly as the mail writes it, digits and separators only;",
      "not an order's or a plan's total or a remaining balance when a smaller amount is the one paid or due; for an order",
      "bought on invoice, the amount owed. currency: its ISO 4217 code (EUR, USD, GBP). refund: true only when money comes",
      "back to the reader. dueDate: as YYYY-MM-DD, the date it will be charged when the state is \"scheduled\", or the date",
      "payment is due when it is \"due\", only when the mail states it; null when the state is \"paid\". what: one plain",
      "line under about 60 characters saying what it was for (a product's or plan's name alone is enough), without the",
      "party's name, the amount or a date; null when all it would say is that a payment was made. Its messages are newest",
      "first, each with the day it was sent, and \"you\" is that person. Plain text only: no markup.",
    ].join(" "));
    assert.ok(detailsInstructions(id, "receipt").startsWith("This email thread is filed as a receipt: proof the reader paid or bought something. "));
    assert.ok(detailsInstructions(id, "receipt").includes(`<usual-mail-data id="${id}">`), "the data block's notice, as for every request");
  });
});

describe("a receipt or an invoice", () => {
  test("is asked for its details in place of a summary, with exactly what a summary request carries", async () => {
    const inbox = await connected();
    fake({}, { "Your order 5512": { party: "Lumen Outdoor", amount: "49.00", currency: "EUR", what: "A rain jacket" } });
    const before = (await t.server.aiUsage(t.person, {})).periods.today.find((row) => row.job === "summarize")?.requests ?? 0;
    const heard = listen(t);
    const thread = await t.receive(inbox, { from: SHOP, subject: "Your order 5512", text: "Thanks for your order. Total: 49.00 EUR, paid by card. Write to help@lumenoutdoor.example." });
    heard.stop();
    assert.deepEqual(t.models.requests.map((r) => r.kind), ["choose", "extract"], "no summary request");
    const sent = t.models.sent("extract")[0]!;
    const items = dataItems(sent.request.data);
    assert.deepEqual(items[0], { subject: "Your order 5512" });
    assert.deepEqual(Object.keys(items[1]!), ["from", "sent", "text"], "each message with the day it was sent");
    assert.equal(items[1]!.from, "Lumen Outdoor");
    assert.ok(String(items[1]!.text).includes("[address]") && !sent.request.data.includes("help@"), "no address, as for a summary");
    const id = /id="([0-9a-f]{18})"/.exec(sent.request.data)![1]!;
    assert.equal(sent.request.instructions, detailsInstructions(id, "receipt"));
    assert.equal(sent.request.model, "fake/summarize", "the summarize job's model");

    const after = await t.threadBySubject("Your order 5512");
    assert.deepEqual(after.payment, { party: "Lumen Outdoor", amount: { minor: 4900, currency: "EUR" }, refund: false, state: null, dueDate: null, what: "A rain jacket" });
    assert.equal(after.summary, "A rain jacket", "its what is the summary");
    const changed = heard.events.filter((event): event is Extract<MailEvent, { type: "thread.changed" }> => event.type === "thread.changed" && event.thread.id === thread.id);
    assert.deepEqual(changed.at(-1)!.thread.payment, after.payment, "a thread.changed carries them");
    const summarized = (await t.server.aiUsage(t.person, {})).periods.today.find((row) => row.job === "summarize")!;
    assert.deepEqual([summarized.model, summarized.requests - before], ["fake/summarize", 1], "counted as the summarize job");
  });

  test("keeps only what it can check, falls back to the sender's name, and logs each drop by its reason alone", async () => {
    const inbox = await connected();
    fake({ "Invoice 77": "invoice" }, { "Invoice 77": { party: "<b>Lumen</b>", amount: "59.00", currency: "EUR", dueDate: "2026-12-24", what: "Winter boots" } });
    await t.receive(inbox, { from: SHOP, subject: "Invoice 77", text: "Please pay 49.00 EUR by 30 November 2026 for the winter boots." });
    const thread = await t.threadBySubject("Invoice 77");
    assert.deepEqual(thread.payment, { party: "Lumen Outdoor", amount: null, refund: false, state: null, dueDate: null, what: "Winter boots" });
    const drops = t.infos.filter((line) => line.startsWith("AI details for"));
    assert.deepEqual(drops, [
      `AI details for ${thread.id} dropped party: markup`,
      `AI details for ${thread.id} dropped amount: not_in_text`,
      `AI details for ${thread.id} dropped dueDate: not_in_text`,
    ]);
    assert.ok(!t.infos.join("\n").includes("Lumen") && !t.infos.join("\n").includes("59"), "nothing of the mail or the answer in the log");
  });

  test("an unusable answer leaves the sender's name only, and it isn't asked again until mail joins", async () => {
    const inbox = await connected();
    fake({}, { "Receipt 9": null });
    const thread = await t.receive(inbox, { from: SHOP, subject: "Receipt 9", text: "Thanks." });
    const after = await t.threadBySubject("Receipt 9");
    assert.deepEqual(after.payment, { party: "Lumen Outdoor", amount: null, refund: false, state: null, dueDate: null, what: null });
    assert.equal(after.summary, undefined, "no summary: clients show the snippet");
    assert.deepEqual(t.infos.filter((line) => line.startsWith("AI details")), [`AI details for ${thread.id} dropped answer: no_answer`]);
    t.models.requests.length = 0;
    await t.tick(60_000);
    assert.equal(t.models.sent("extract").length, 0);
    assert.equal((await t.server.aiStatus(t.person)).pending, 0);
  });

  test("an order, then its shipping notice, then its invoice: the newest amount stated wins, a notice without one keeps it", async () => {
    const inbox = await connected();
    fake({}, {
      "Order 5512": { party: "Lumen Outdoor", amount: "49.00", currency: "EUR", what: "A rain jacket" },
    });
    await t.receive(inbox, { from: SHOP, subject: "Order 5512", text: "Order total 49.00 EUR.", messageId: "order@lumenoutdoor.example" });
    const mailbox = t.mailboxes.get(inbox.address)!;
    t.models.extract = () => ({ party: null, amount: null, currency: null, refund: false, state: null, dueDate: null, what: null });
    mailbox.deliver({ from: SHOP, subject: "Re: Order 5512", text: "Your parcel is on its way.", inReplyTo: "order@lumenoutdoor.example", messageId: "shipped@lumenoutdoor.example" });
    await t.sync(inbox);
    let thread = (await t.server.search(t.person, { q: "Order 5512" })).items[0]!;
    assert.deepEqual(thread.payment, { party: "Lumen Outdoor", amount: { minor: 4900, currency: "EUR" }, refund: false, state: null, dueDate: null, what: "A rain jacket" });
    t.models.extract = () => ({ party: "Lumen Outdoor GmbH", amount: "52,00", currency: "EUR", refund: false, state: null, dueDate: null, what: null });
    mailbox.deliver({ from: SHOP, subject: "Re: Order 5512", text: "Rechnung: 52,00 EUR inkl. Versand.", inReplyTo: "shipped@lumenoutdoor.example" });
    await t.sync(inbox);
    thread = (await t.server.search(t.person, { q: "Order 5512" })).items[0]!;
    assert.deepEqual(thread.payment, { party: "Lumen Outdoor", amount: { minor: 5200, currency: "EUR" }, refund: false, state: null, dueDate: null, what: "A rain jacket" }, "its name without a legal suffix");
    assert.equal(t.models.sent("extract").length, 3, "one request for each incoming message");
  });

  test("an amount of zero is dropped, and one stored before that check isn't kept when mail joins", async () => {
    const inbox = await connected();
    fake({}, { "Order 0": { party: "Lumen Outdoor", amount: "0.00", currency: "EUR", what: "A gift card" } });
    const thread = await t.receive(inbox, { from: SHOP, subject: "Order 0", text: "Subtotal 49.00 EUR. Total 0.00 EUR.", messageId: "zero@lumenoutdoor.example" });
    assert.deepEqual((await t.threadBySubject("Order 0")).payment?.amount, null);
    assert.ok(t.infos.includes(`AI details for ${thread.id} dropped amount: zero`));
    // As a build before the check stored it.
    await t.host.db.update(threads).set({ payment: { party: "Lumen Outdoor", amount: { minor: 0, currency: "EUR" }, refund: false, state: null, dueDate: null, what: "A gift card" } }).where(eq(threads.id, thread.id));
    t.models.extract = () => ({ party: null, amount: null, currency: null, refund: false, state: null, dueDate: null, what: null });
    t.mailboxes.get(inbox.address)!.deliver({ from: SHOP, subject: "Re: Order 0", text: "Your parcel is on its way.", inReplyTo: "zero@lumenoutdoor.example" });
    await t.sync(inbox);
    const row = await t.host.db.select().from(threads).where(eq(threads.id, thread.id)).get();
    assert.deepEqual(row!.payment, { party: "Lumen Outdoor", amount: null, refund: false, state: null, dueDate: null, what: "A gift card" });
  });

  test("leaving receipts removes the details and asks for a summary; coming back asks for details again", async () => {
    const inbox = await connected();
    fake({}, { "Receipt 12": { party: "Lumen Outdoor", amount: "12.00", currency: "EUR", what: "Socks" } });
    const thread = await t.receive(inbox, { from: SHOP, subject: "Receipt 12", text: "You paid 12.00 EUR." });
    t.models.requests.length = 0;
    t.models.extract = () => ({ summary: "A note about socks", status: null, about: null, date: null, time: null, endTime: null });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "notification" } });
    await t.server.whenIdle();
    let after = await t.threadBySubject("Receipt 12");
    assert.equal(after.payment, undefined);
    assert.equal(after.summary, "A note about socks");
    assert.deepEqual(t.models.requests.map((r) => ("name" in r.request ? r.request.name : r.kind)), ["event"], "a notification now: its summary and event");
    fake({}, { "Receipt 12": { party: "Lumen Outdoor", amount: "12.00", currency: "EUR", what: "Socks" } });
    t.models.requests.length = 0;
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "invoice" } });
    await t.server.whenIdle();
    after = await t.threadBySubject("Receipt 12");
    assert.deepEqual(t.models.requests.map((r) => r.kind), ["extract"], "whoever files it");
    assert.deepEqual([after.payment?.amount, after.summary], [{ minor: 1200, currency: "EUR" }, "Socks"]);
    t.models.requests.length = 0;
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "receipt" } });
    await t.server.whenIdle();
    assert.deepEqual(t.models.requests.map((r) => r.kind), ["extract"], "from an invoice to a receipt they are asked again: a refund means something only on a receipt");
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "otp" } });
    after = await t.threadBySubject("Receipt 12");
    assert.deepEqual([after.payment, after.summary], [undefined, undefined], "a one-time code: no details, no summary");
  });

  test("a refund on a receipt says so; on an invoice it can't, and an amount read as one is dropped", async () => {
    const inbox = await connected();
    const credit = { party: "Lumen Outdoor", amount: "12.00", currency: "EUR", refund: true, what: "The returned jacket" };
    fake({ "Credit note 4": "invoice" }, { "Refund 4": credit, "Credit note 4": credit });
    await t.receive(inbox, { from: SHOP, subject: "Refund 4", text: "We refunded 12.00 EUR." });
    const invoice = await t.receive(inbox, { from: SHOP, subject: "Credit note 4", text: "Credit note: 12.00 EUR back on your account." });
    assert.deepEqual((await t.threadBySubject("Refund 4")).payment, { party: "Lumen Outdoor", amount: { minor: 1200, currency: "EUR" }, refund: true, state: "paid", dueDate: null, what: "The returned jacket" });
    assert.deepEqual((await t.threadBySubject("Credit note 4")).payment, { party: "Lumen Outdoor", amount: null, refund: false, state: null, dueDate: null, what: "The returned jacket" });
    assert.ok(t.infos.includes(`AI details for ${invoice.id} dropped amount: refund_on_invoice`));
  });

  test("a screened receipt gets its details; a blocked sender's mail is never sent", async () => {
    const inbox = await connected();
    fake({}, { "Your ticket": { party: "Sam's Shows", amount: "20.00", currency: "EUR", what: "A concert ticket" } });
    const screened = await t.receive(inbox, { from: STRANGER, subject: "Your ticket", text: "Paid 20.00 EUR." });
    assert.deepEqual([screened.category, screened.screened], ["receipt", true]);
    assert.equal((await t.threadBySubject("Your ticket")).payment?.what, "A concert ticket");
    await t.server.act(t.person, { threadIds: [screened.id], action: { kind: "block_sender" } });
    t.models.requests.length = 0;
    await t.receive(inbox, { from: STRANGER, subject: "Another ticket", text: "Paid 25.00 EUR." });
    assert.equal(t.models.requests.length, 0);
  });

  test("asked once more for the state, once: the answer's state, only missing facts filled, dates by the state; an unusable answer keeps all", async () => {
    const inbox = await connected();
    fake({ "Invoice 2": "invoice", "Alert 2": "notification" }, {
      "Order 2": { party: "Lumen Outdoor", currency: "EUR", what: "Winter boots" },
      "Invoice 2": { party: "Lumen Outdoor", amount: "59.00", currency: "EUR", dueDate: "2026-11-30", what: "Gloves" },
      "Receipt 3": { party: "Lumen Outdoor", what: "Socks" },
      "Receipt done": { party: "Lumen Outdoor", what: "Gloves" },
    });
    for (const subject of ["Order 2", "Invoice 2", "Receipt 3", "Receipt done", "Alert 2"]) {
      await t.receive(inbox, { from: SHOP, subject, text: "Pay 59.00 EUR by 30 November 2026, or it will be charged.", date: "2026-11-10T10:00:00Z" });
    }
    await t.server.act(t.person, { threadIds: [(await t.threadBySubject("Receipt done")).id], action: { kind: "done" } });
    await t.server.stop();
    // As a store that had the details before the state: the asking-again for it hasn't run yet.
    await t.host.db.update(serverState).set({ detailsAskedAgain: null });
    t.models.requests.length = 0;
    fake({}, {
      "Order 2": { party: "Lumen Outdoor Shop", amount: "59.00", currency: "EUR", state: "due", dueDate: "2026-11-30", what: "Boots" },
      "Invoice 2": { party: "Other", amount: "49.00", currency: "EUR", state: "paid", what: "Other" },
      "Receipt 3": null,
    });
    const again = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await again.start();
    await again.whenIdle();
    assert.deepEqual(t.models.sent("extract").map(subjectOf).sort(), ["Alert 2", "Invoice 2", "Order 2", "Receipt 3"],
      "every receipt and invoice not done, and the notification by the events' asking-again; nothing else");
    const payment = async (subject: string) => (await t.host.db.select().from(threads).where(eq(threads.subject, subject)).get())!;
    assert.deepEqual((await payment("Order 2")).payment, { party: "Lumen Outdoor", amount: { minor: 5900, currency: "EUR" }, refund: false, state: "due", dueDate: "2026-11-30", what: "Winter boots" },
      "an order bought on invoice: the state, and its amount owed and date filled; its party and what kept");
    assert.deepEqual((await payment("Invoice 2")).payment, { party: "Lumen Outdoor", amount: { minor: 5900, currency: "EUR" }, refund: false, state: "paid", dueDate: null, what: "Gloves" },
      "an invoice already charged: paid, so its date goes; nothing it had is overwritten");
    assert.equal((await payment("Receipt 3")).payment?.what, "Socks", "an unusable answer keeps what it had");
    assert.ok([await payment("Order 2"), await payment("Invoice 2"), await payment("Receipt 3")].every((row) => !row.paymentAgain && !row.summaryDue));
    assert.equal((await t.host.db.select().from(serverState).get())!.detailsAskedAgain, EVENT_AGAIN, "the last asking-again it had, after the payment state's");
    await again.stop();

    t.models.requests.length = 0;
    const third = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await third.start();
    await third.whenIdle();
    assert.equal(t.models.requests.length, 0, "once");
    await third.stop();
  });

  test("at the first start of a build with details, every receipt and invoice without them is asked, once", async () => {
    const inbox = await connected();
    fake({ "Invoice 1": "invoice" }, {});
    for (const subject of ["Receipt 1", "Invoice 1", "Receipt done"]) await t.receive(inbox, { from: SHOP, subject, text: "Paid 10.00 EUR." });
    await t.server.act(t.person, { threadIds: [(await t.threadBySubject("Receipt done")).id], action: { kind: "done" } });
    await t.server.stop();
    // As a store from before details: none on any thread, and no summary due.
    await t.host.db.update(threads).set({ payment: null, summaryDue: false });
    t.models.requests.length = 0;
    fake({}, { "Receipt 1": { amount: "10.00", currency: "EUR" }, "Invoice 1": { amount: "10.00", currency: "EUR" } });
    const again = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await again.start();
    await again.whenIdle();
    assert.deepEqual(t.models.sent("extract").map(subjectOf).sort(), ["Invoice 1", "Receipt 1"], "not a done one");
    const row = await t.host.db.select().from(threads).where(eq(threads.subject, "Receipt 1")).get();
    assert.deepEqual(row!.payment?.amount, { minor: 1000, currency: "EUR" });
    assert.equal((await again.aiStatus(t.person)).pending, 0);
    await again.stop();
  });
});
