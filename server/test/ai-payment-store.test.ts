// The payment details' rules that read other rows (src/ai/payment-store.ts) and the due date checked against its
// message, through the pipeline: one name per sender, and the once-only pass over stored details at a start. Fake
// models only; the once-only pass asks no model at all.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Inbox, PaymentDetails } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { PAYMENT_RULES } from "../src/ai/payment-store.ts";
import { MOMENT_PASS } from "../src/ai/passes.ts";
import { serverState, threads } from "../src/db/index.ts";
import { dataItems, MailServer } from "../src/index.ts";
import { SuffixList } from "../src/avatars/suffixes.ts";
import { historyFromKnown, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

const SHOP = { name: "Fernsafe", email: "billing@fernsafe.example" };
const OTHER = { name: "Fernsafe Partner", email: "partner@other.example" };
const PAYPAL = { name: "PayPal", email: "service@paypal.example" };

async function connected(): Promise<Inbox> {
  const { inbox } = await t.connect({ address: "me@store.example", history: [historyFromKnown, ...[SHOP, OTHER, PAYPAL].map((from) => ({ ...historyFromKnown, from, subject: `Earlier from ${from.name}` }))] });
  await t.aiOn();
  return inbox;
}

/** The fake files by subject and reads details as told. */
function fake(categories: Record<string, string>, details: Record<string, Partial<Record<string, unknown>>>): void {
  t.models.choose = (request) => categories[String(dataItems(request.data)[0]?.subject)] ?? "receipt";
  t.models.extract = (request) => ({ party: null, amount: null, currency: null, refund: false, dueDate: null, what: null, ...details[String(dataItems(request.data)[0]?.subject)] });
}

const row = async (subject: string) => (await t.host.db.select().from(threads).where(eq(threads.subject, subject)).get())!;

describe("a due date read the wrong way round", () => {
  test("is read the other way when the model's reading lies before its message, and the log says so without content", async () => {
    const inbox = await connected();
    fake({ "Rechnung 7": "invoice" }, { "Rechnung 7": { party: "Fernsafe", dueDate: "2026-07-11" } });
    const thread = await t.receive(inbox, { from: SHOP, subject: "Rechnung 7", text: "Bitte zahlen Sie bis 07/11/2026.", date: "2026-11-05T10:00:00Z" });
    assert.equal((await row("Rechnung 7")).payment?.dueDate, "2026-11-07");
    assert.ok(t.infos.includes(`AI details for ${thread.id} read the due date's day and month the other way round`));
  });
});

describe("one name per sender", () => {
  test("a sender's receipts share one form of its name; another sender's and a payment service's don't", async () => {
    const inbox = await connected();
    fake({}, {
      "Receipt 1": { party: "Fernsafe Digital" },
      "Receipt 2": { party: "Fernsafe" },
      "Receipt 3": { party: "Fernsafe Digital" },
      "Via PayPal 1": { party: "Lumen Outdoor Digital" },
      "Via PayPal 2": { party: "Lumen Outdoor" },
    });
    await t.receive(inbox, { from: SHOP, subject: "Receipt 1", text: "Paid." });
    const before = (await row("Receipt 1")).version;
    await t.receive(inbox, { from: SHOP, subject: "Receipt 2", text: "Paid." });
    assert.deepEqual([(await row("Receipt 1")).payment?.party, (await row("Receipt 2")).payment?.party], ["Fernsafe", "Fernsafe"], "the shorter form, on both");
    assert.ok((await row("Receipt 1")).version > before, "the earlier thread changed, with a new version");
    await t.receive(inbox, { from: OTHER, subject: "Receipt 3", text: "Paid." });
    assert.equal((await row("Receipt 3")).payment?.party, "Fernsafe Digital", "never across senders");
    await t.receive(inbox, { from: PAYPAL, subject: "Via PayPal 1", text: "Paid." });
    await t.receive(inbox, { from: PAYPAL, subject: "Via PayPal 2", text: "Paid." });
    assert.deepEqual([(await row("Via PayPal 1")).payment?.party, (await row("Via PayPal 2")).payment?.party], ["Lumen Outdoor Digital", "Lumen Outdoor"], "a payment service's shops differ per mail");
  });
});

describe("the once-only pass over stored details", () => {
  test("re-reads due dates against their messages, cleans parties and unifies them, by rule only, once", async () => {
    const inbox = await connected();
    fake({ "Rechnung 8": "invoice", "Rechnung 9": "invoice" }, {});
    for (const [subject, from, text, date] of [
      ["Rechnung 8", SHOP, "Bitte zahlen Sie bis 07/11/2026.", "2026-11-05T10:00:00Z"],
      ["Rechnung 9", SHOP, "Fällig war der 15/10/2026.", "2026-11-05T10:00:00Z"],
      ["Receipt A", SHOP, "Paid.", "2026-11-01T10:00:00Z"],
      ["Receipt B", OTHER, "Paid.", "2026-11-02T10:00:00Z"],
      ["Receipt C", OTHER, "Paid.", "2026-11-03T10:00:00Z"],
    ] as const) await t.receive(inbox, { from, subject, text, date });
    await t.server.stop();
    // As a store of the build before: details the rules of this round would not have kept.
    const stored = (party: string, dueDate: string | null = null): PaymentDetails => ({ party, amount: null, refund: false, state: null, dueDate, what: null });
    const store = async (subject: string, payment: PaymentDetails) => t.host.db.update(threads).set({ payment }).where(eq(threads.subject, subject));
    await store("Rechnung 8", stored("Fernsafe Digital", "2026-07-11"));
    await store("Rechnung 9", stored("Fernsafe", "2026-10-15"));
    await store("Receipt A", stored("Fernsafe | Ihre Zahlung"));
    await store("Receipt B", stored("X | Invoice"));
    await store("Receipt C", stored("Fernsafe Partner GmbH"));
    await t.host.db.update(serverState).set({ paymentRulesApplied: null });
    const versions = new Map((await t.host.db.select().from(threads)).map((thread) => [thread.subject, thread.version]));
    t.models.requests.length = 0;
    t.infos.length = 0;

    const again = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await again.start();
    await again.whenIdle();
    assert.equal(t.models.requests.length, 0, "no model is asked");
    assert.deepEqual((await row("Rechnung 8")).payment, stored("Fernsafe", "2026-11-07"), "read the other way round, and one name with the sender's others");
    assert.deepEqual((await row("Rechnung 9")).payment, stored("Fernsafe"), "15 October lies before its message whichever way: dropped");
    assert.deepEqual((await row("Receipt A")).payment, stored("Fernsafe"), "display text cut");
    assert.deepEqual((await row("Receipt B")).payment, stored("Fernsafe Partner"), "nothing left of it: the sender's name");
    assert.deepEqual((await row("Receipt C")).payment, stored("Fernsafe Partner"), "its legal suffix is a party's cleaning too");
    for (const subject of ["Rechnung 8", "Rechnung 9", "Receipt A", "Receipt B", "Receipt C"]) {
      assert.ok((await row(subject)).version > versions.get(subject)!, `${subject} has a new version`);
    }
    assert.deepEqual(t.infos.filter((line) => line.startsWith("Payment details by rule")),
      ["Payment details by rule: 1 due dates read the other way round, 1 dropped, 3 parties cleaned, 0 one-word parties named, 1 unified"], "counts only");
    assert.equal((await t.host.db.select().from(serverState).get())!.paymentRulesApplied, MOMENT_PASS, "the last pass by rule, after the payment rules' own");
    await again.stop();

    await t.host.db.update(threads).set({ payment: stored("Fernsafe | again") }).where(eq(threads.subject, "Receipt A"));
    const third = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await third.start();
    await third.whenIdle();
    assert.equal((await row("Receipt A")).payment?.party, "Fernsafe | again", "once: a later start changes nothing");
    await third.stop();
  });
});

describe("this build's one-off pass: a one-word lowercase party (2026-11-19)", () => {
  test("takes the sender's display name once, by rule only, and stays when the sender has none or is the same word", async () => {
    const MARKT = { name: "Frischmarkt Nordend GmbH", email: "kasse@frischmarkt.example" };
    const PLAIN = { email: "noreply@plain.example" };
    const LOWER = { name: "zalando", email: "service@zalando.example" };
    const { inbox } = await t.connect({ address: "me@word.example", history: [historyFromKnown, ...[MARKT, PLAIN, LOWER].map((from) => ({ ...historyFromKnown, from, subject: `Earlier from ${from.email}` }))] });
    await t.aiOn();
    fake({}, {});
    for (const [subject, from] of [["Markt 1", MARKT], ["Plain 1", PLAIN], ["Lower 1", LOWER]] as const) await t.receive(inbox, { from, subject, text: "Paid." });
    await t.server.stop();
    const stored = (party: string): PaymentDetails => ({ party, amount: null, refund: false, state: null, dueDate: null, what: null });
    await t.host.db.update(threads).set({ payment: stored("nordend") }).where(eq(threads.subject, "Markt 1"));
    await t.host.db.update(threads).set({ payment: stored("altstadt") }).where(eq(threads.subject, "Plain 1"));
    await t.host.db.update(threads).set({ payment: stored("zalando") }).where(eq(threads.subject, "Lower 1"));
    await t.host.db.update(serverState).set({ paymentRulesApplied: "2026-11-19 payment rules, by domain" });
    t.models.requests.length = 0;
    t.infos.length = 0;
    const again = await MailServer.create(t.host, { providers: t.providers, models: t.models, avatars: { backfill: false } });
    assert.equal(t.models.requests.length, 0, "no model is asked");
    assert.equal((await row("Markt 1")).payment?.party, "Frischmarkt Nordend", "the sender's name, cleaned");
    assert.equal((await row("Plain 1")).payment?.party, "altstadt", "no usable name: left as it is");
    assert.equal((await row("Lower 1")).payment?.party, "zalando", "the same word: no change");
    assert.deepEqual(t.infos.filter((line) => line.startsWith("Payment details by rule")),
      ["Payment details by rule: 0 due dates read the other way round, 0 dropped, 0 parties cleaned, 1 one-word parties named, 0 unified"]);
    assert.equal((await t.host.db.select().from(serverState).get())!.paymentRulesApplied, MOMENT_PASS, "the last pass by rule, after the payment rules' own");
    assert.equal(PAYMENT_RULES, "2026-11-19 payment rules, one-word parties");
    await again.stop();
  });
});

describe("one name per sender, a sender being a domain", () => {
  const ORDERS = { name: "Nordmarkt", email: "orders@nordmarkt.example" };
  const BILLING = { name: "Nordmarkt Billing", email: "billing@nordmarkt.example" };
  const SUB = { name: "Nordmarkt", email: "mail@news.nordmarkt.example" };
  const FREE = [{ name: "Anna", email: "anna@gmail.com" }, { name: "Anna Studio", email: "studio.anna@gmail.com" }];

  test("a marketplace's addresses at one domain share one name; a free mailbox's senders don't", async () => {
    // Without the Public Suffix List: the server now ships one, so this case is made without it on purpose.
    await t.close();
    t = await makeServer({ avatars: { suffixes: null } });
    const { inbox } = await t.connect({ address: "me@domain.example", history: [historyFromKnown, ...[ORDERS, BILLING, SUB, ...FREE].map((from) => ({ ...historyFromKnown, from, subject: `Earlier from ${from.email}` }))] });
    await t.aiOn();
    fake({}, {
      "Order 1": { party: "Nordmarkt.de" },
      "Bill 1": { party: "Nordmarkt" },
      "Sub 1": { party: "Nordmarkt Digital" },
      "Anna 1": { party: "Anna" },
      "Anna 2": { party: "Anna Studio" },
    });
    for (const [subject, from] of [["Order 1", ORDERS], ["Bill 1", BILLING], ["Sub 1", SUB], ["Anna 1", FREE[0]!], ["Anna 2", FREE[1]!]] as const) {
      await t.receive(inbox, { from, subject, text: "Paid." });
    }
    assert.deepEqual([(await row("Order 1")).payment?.party, (await row("Bill 1")).payment?.party], ["Nordmarkt", "Nordmarkt"], "one domain, one name, without the domain ending");
    assert.equal((await row("Sub 1")).payment?.party, "Nordmarkt Digital", "without the Public Suffix List, another domain");
    assert.deepEqual([(await row("Anna 1")).payment?.party, (await row("Anna 2")).payment?.party], ["Anna", "Anna Studio"], "two people at a free mailbox");
  });

  test("with the shipped Public Suffix List, a subdomain is the same sender; a free mailbox's senders still aren't", async () => {
    const { inbox } = await t.connect({ address: "me@domain.example", history: [historyFromKnown, ...[ORDERS, SUB, ...FREE].map((from) => ({ ...historyFromKnown, from, subject: `Earlier from ${from.email}` }))] });
    await t.aiOn();
    fake({}, { "Order 2": { party: "Nordmarkt" }, "Sub 2": { party: "Nordmarkt Digital" }, "Anna 3": { party: "Anna" }, "Anna 4": { party: "Anna Studio" } });
    for (const [subject, from] of [["Order 2", ORDERS], ["Sub 2", SUB], ["Anna 3", FREE[0]!], ["Anna 4", FREE[1]!]] as const) {
      await t.receive(inbox, { from, subject, text: "Paid." });
    }
    assert.deepEqual([(await row("Order 2")).payment?.party, (await row("Sub 2")).payment?.party], ["Nordmarkt", "Nordmarkt"], "news.nordmarkt.example is nordmarkt.example");
    assert.deepEqual([(await row("Anna 3")).payment?.party, (await row("Anna 4")).payment?.party], ["Anna", "Anna Studio"]);
  });

  test("this build's pass: a district cut back to the sender's name, and one name per registrable domain with the list", async () => {
    const { inbox } = await t.connect({ address: "me@pass.example", history: [historyFromKnown, ...[ORDERS, SUB].map((from) => ({ ...historyFromKnown, from, subject: `Earlier from ${from.email}` }))] });
    await t.aiOn();
    fake({}, {});
    for (const [subject, from] of [["Order 9", ORDERS], ["Sub 9", SUB], ["Shop 9", SHOP]] as const) await t.receive(inbox, { from, subject, text: "Paid." });
    await t.server.stop();
    const stored = (party: string): PaymentDetails => ({ party, amount: null, refund: false, state: null, dueDate: null, what: null });
    await t.host.db.update(threads).set({ payment: stored("Nordmarkt") }).where(eq(threads.subject, "Order 9"));
    await t.host.db.update(threads).set({ payment: stored("Nordmarkt Digital") }).where(eq(threads.subject, "Sub 9"));
    await t.host.db.update(threads).set({ payment: stored("altstadt – Fernsafe Laden") }).where(eq(threads.subject, "Shop 9"));
    await t.host.db.update(serverState).set({ paymentRulesApplied: "2026-11-19 payment rules" });
    t.models.requests.length = 0;
    t.infos.length = 0;
    const list = new SuffixList({ icann: ["example"], private: [] });
    const again = await MailServer.create(t.host, { providers: t.providers, models: t.models, avatars: { suffixes: list, backfill: false } });
    assert.equal(t.models.requests.length, 0, "no model is asked");
    assert.deepEqual([(await row("Order 9")).payment?.party, (await row("Sub 9")).payment?.party], ["Nordmarkt", "Nordmarkt"], "news.nordmarkt.example is nordmarkt.example");
    assert.equal((await row("Shop 9")).payment?.party, "Fernsafe", "a district isn't a name: the sender's");
    assert.deepEqual(t.infos.filter((line) => line.startsWith("Payment details by rule")),
      ["Payment details by rule: 0 due dates read the other way round, 0 dropped, 1 parties cleaned, 0 one-word parties named, 1 unified"]);
    assert.equal((await t.host.db.select().from(serverState).get())!.paymentRulesApplied, MOMENT_PASS, "the last pass by rule, after the payment rules' own");
    await again.stop();
  });
});
