// Search over what the server holds (docs/contract-search.md): what is searched, how it ranks, the filters and the
// operators typed, and what a result carries. Made-up mail only.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sql } from "drizzle-orm";
import type { Inbox, SearchHit } from "@usualmail/core";
import { threads } from "../src/db/index.ts";
import { DAY, HOUR, makeServer, START, type TestServer } from "./helpers.ts";

const ANNA = { name: "Anna Schmidt", email: "anna@studio.example" };
const JORG = { name: "Jörg Müller", email: "joerg@mail.fernhill.example" };
const SHOP = { name: "Paperloop Billing", email: "billing@paperloop.example" };
const ago = (ms: number) => new Date(Date.parse(START) - ms).toISOString();
const subjects = (items: SearchHit[]) => items.map((item) => item.subject);

describe("search over what the server holds", () => {
  let t: TestServer;
  let inbox: Inbox;
  before(async () => {
    t = await makeServer();
    // The first sync's history: every sender let in, nothing screened.
    ({ inbox } = await t.connect({
      address: "me@acme.example",
      history: [
        { from: ANNA, subject: "Plans for the studio", text: "Shall we meet on Thursday about the Straße project?", date: ago(2 * HOUR) },
        { from: JORG, subject: "Lunch", text: "The Rechnung for the café is attached.", date: ago(3 * HOUR),
          attachments: [{ id: "a1", filename: "Rechnung-November.pdf", mimeType: "application/pdf", size: 10, inline: false }] },
        { from: SHOP, subject: "Your receipt", html: "<p>Thank you for your order.</p><p>Total paid: <b>49,99 €</b></p>", date: ago(4 * DAY) },
        { from: ANNA, subject: "Old notes", text: "Notes about the invoice from last spring.", date: ago(20 * DAY), placement: { inInbox: false } },
        { from: { email: "news@weekly.example" }, subject: "Weekly digest", text: "Invoice tips, invoice tricks, more invoice news.", date: ago(1 * HOUR) },
        { from: JORG, subject: "Invoice 2026-114", text: "Please find it attached.", date: ago(25 * DAY), seen: true },
      ],
    }));
    // The AI's facts, as they would land: a receipt's details and a notification's event, with a new version.
    const receipt = await t.threadBySubject("Your receipt");
    await t.host.db.update(threads).set({
      category: "receipt",
      summary: "Desk lamp",
      payment: { party: "Paperloop", amount: { minor: 4999, currency: "EUR" }, refund: false, state: "paid", dueDate: null, what: "Desk lamp" },
      version: sql`${threads.version} + 1`,
    }).where(sql`${threads.id} = ${receipt.id}`);
  });
  after(() => t.close());

  test("finds the body (text and HTML), the subject, the people, attachment names and the AI's facts", async () => {
    assert.deepEqual(subjects((await t.server.search(t.person, { q: "thursday" })).items), ["Plans for the studio"]);
    assert.deepEqual(subjects((await t.server.search(t.person, { q: "thank you for your order" })).items), ["Your receipt"], "HTML read as text");
    assert.deepEqual(subjects((await t.server.search(t.person, { q: "lunch" })).items), ["Lunch"]);
    assert.ok(subjects((await t.server.search(t.person, { q: "schmidt" })).items).includes("Plans for the studio"), "a sender's name");
    assert.ok(subjects((await t.server.search(t.person, { q: "fernhill" })).items).includes("Lunch"), "a sender's address");
    assert.deepEqual(subjects((await t.server.search(t.person, { q: "november.pdf" })).items), ["Lunch"], "an attachment's name");
    assert.deepEqual(subjects((await t.server.search(t.person, { q: "desk lamp" })).items), ["Your receipt"], "the payment's what");
    assert.deepEqual(subjects((await t.server.search(t.person, { q: "49,99" })).items), ["Your receipt"], "the amount as written");
    assert.deepEqual(subjects((await t.server.search(t.person, { q: "49.99" })).items), ["Your receipt"], "or with a point");
  });

  test("folds case and accents, reads ß as ss either way, and matches word starts as a person types", async () => {
    assert.ok(subjects((await t.server.search(t.person, { q: "muller" })).items).includes("Lunch"), "Müller");
    assert.deepEqual(subjects((await t.server.search(t.person, { q: "CAFE" })).items), ["Lunch"], "café");
    assert.deepEqual(subjects((await t.server.search(t.person, { q: "strasse" })).items), ["Plans for the studio"], "Straße");
    assert.deepEqual(subjects((await t.server.search(t.person, { q: "straße" })).items), ["Plans for the studio"]);
    for (const typed of ["re", "rec", "rech", "rechn"]) {
      assert.ok(subjects((await t.server.search(t.person, { q: typed })).items).includes("Lunch"), typed);
    }
    assert.deepEqual((await t.server.search(t.person, { q: "email" })).items, [], "the participants' JSON keys aren't text a person wrote");
  });

  test("ranks a match in the subject or the sender above one in a body, and newer above older among like matches", async () => {
    // "invoice": the subject of a 25-day-old thread, three times in a digest's body an hour old, once in a body 20 days old.
    const found = subjects((await t.server.search(t.person, { q: "invoice" })).items);
    assert.deepEqual(found, ["Invoice 2026-114", "Weekly digest", "Old notes"]);
    // "anna": the sender of a thread 2 hours old and one 20 days old, and nowhere else: the newer first.
    assert.deepEqual(subjects((await t.server.search(t.person, { q: "anna" })).items), ["Plans for the studio", "Old notes"]);
  });

  test("a result carries the thread as lists give it, where it matched, the subject marked and a short excerpt", async () => {
    const [hit] = (await t.server.search(t.person, { q: "rechnung" })).items;
    assert.equal(hit!.subject, "Lunch");
    assert.equal(hit!.done, false);
    assert.equal(typeof hit!.version, "number");
    assert.deepEqual(hit!.match!.fields, ["attachments", "body"]);
    assert.equal(hit!.match!.subject, undefined, "the subject didn't match");
    assert.equal(hit!.match!.excerpt!.field, "body");
    assert.deepEqual(hit!.match!.excerpt!.runs, [
      { text: "The ", match: false },
      { text: "Rechnung", match: true },
      { text: " for the café is attached.", match: false },
    ]);
    const [subject] = (await t.server.search(t.person, { q: "plans studio" })).items;
    assert.deepEqual(subject!.match!.subject, [
      { text: "Plans", match: true }, { text: " for the ", match: false }, { text: "studio", match: true },
    ]);
    const archived = (await t.server.search(t.person, { q: "old notes" })).items[0]!;
    assert.equal(archived.done, true, "archived history is done, and found");
  });

  test("an excerpt is plain text: no markup, no control characters, about a snippet long", async () => {
    const long = `${"Lorem ipsum dolor sit amet. ".repeat(40)}The needle <b>here</b> &amp; ${"More words follow. ".repeat(40)}`;
    await t.receive(inbox, { from: ANNA, subject: "Long one", text: long });
    const hit = (await t.server.search(t.person, { q: "needle" })).items[0]!;
    const text = hit.match!.excerpt!.runs.map((run) => run.text).join("");
    assert.ok(text.length <= 201, `${text.length} characters`);
    assert.ok(!/[<>\u0000-\u001f]/.test(text), text);
    assert.ok(hit.match!.excerpt!.runs.some((run) => run.match && run.text === "needle"));
  });

  test("typed operators become filters, echoed with the free text left; unknown ones stay text", async () => {
    const result = await t.server.search(t.person, { q: 'from:anna@studio.example "the studio" -lunch has:attachment is:unread before:2026/11/20 after:2026-01-01 label:x' });
    assert.deepEqual(result.understood, {
      from: "anna@studio.example", hasAttachment: true, unread: true,
      before: "2026-11-20T00:00:00Z", after: "2026-01-01T00:00:00Z",
      text: '"the studio" label:x', exclude: ["lunch"],
    });
    const plain = await t.server.search(t.person, { q: "subject:lunch" });
    assert.deepEqual(plain.understood, { subject: "lunch", text: "" });
    assert.deepEqual(subjects(plain.items), ["Lunch"]);
    // A typed operator wins over the same filter given; the dates are days in the time zone asked for.
    const both = await t.server.search(t.person, { q: "from:joerg@mail.fernhill.example after:2026/11/01", from: "anna@studio.example", tz: "Europe/Berlin" });
    assert.equal(both.understood.from, "joerg@mail.fernhill.example");
    assert.equal(both.understood.after, "2026-10-31T23:00:00Z");
    assert.deepEqual(subjects(both.items), ["Lunch"]);
  });

  test("a quoted phrase is word for word, a leading minus leaves a word out", async () => {
    assert.deepEqual(subjects((await t.server.search(t.person, { q: '"the café is attached"' })).items), ["Lunch"]);
    assert.deepEqual((await t.server.search(t.person, { q: '"attached is café"' })).items, []);
    assert.deepEqual(subjects((await t.server.search(t.person, { q: "invoice -digest -spring" })).items), ["Invoice 2026-114"]);
  });

  test("filters alone list newest first; from takes an address, a domain with its subdomains, or a name's word", async () => {
    assert.deepEqual(subjects((await t.server.search(t.person, { from: "anna@studio.example" })).items), ["Long one", "Plans for the studio", "Old notes"]);
    assert.deepEqual(subjects((await t.server.search(t.person, { from: "fernhill.example" })).items), ["Lunch", "Invoice 2026-114"], "a subdomain's sender");
    assert.deepEqual(subjects((await t.server.search(t.person, { from: "müller" })).items), ["Lunch", "Invoice 2026-114"]);
    assert.deepEqual(subjects((await t.server.search(t.person, { from: "mull" })).items), ["Lunch", "Invoice 2026-114"], "a word's start, folded");
    assert.deepEqual(subjects((await t.server.search(t.person, { to: "me@acme.example", kinds: ["receipt"] })).items), ["Your receipt"]);
    assert.deepEqual(subjects((await t.server.search(t.person, { kinds: ["done"] })).items), ["Old notes"]);
    assert.deepEqual(subjects((await t.server.search(t.person, { kinds: ["receipt", "invoice"] })).items), ["Your receipt"]);
    assert.deepEqual((await t.server.search(t.person, { kinds: ["receipt", "done"] })).items, [], "done narrows the categories");
    assert.deepEqual(subjects((await t.server.search(t.person, { hasAttachment: true })).items), ["Lunch"]);
    assert.deepEqual(subjects((await t.server.search(t.person, { unread: false, q: "invoice" })).items), ["Invoice 2026-114"]);
    assert.deepEqual(subjects((await t.server.search(t.person, { after: ago(5 * DAY), before: ago(3 * DAY) })).items), ["Your receipt"]);
    assert.deepEqual(subjects((await t.server.search(t.person, { inboxIds: [inbox.id], q: "lunch" })).items), ["Lunch"]);
  });

  test("a search with neither text nor a filter, or a filter it can't read, is invalid", async () => {
    await assert.rejects(t.server.search(t.person, {}), { code: "invalid" });
    await assert.rejects(t.server.search(t.person, { q: "   " }), { code: "invalid" });
    await assert.rejects(t.server.search(t.person, { q: "x", kinds: ["piles" as never] }), { code: "invalid" });
    await assert.rejects(t.server.search(t.person, { q: "x", tz: "Mars/Olympus" }), { code: "invalid" });
    await assert.rejects(t.server.search(t.person, { q: "x", cursor: "made-up" }), { code: "invalid" });
    await assert.rejects(t.server.search(t.person, { q: "x", inboxIds: ["inb_nowhere"] }), { code: "not_found" });
  });

  test("the people a search finds: senders whose name or address matches, with their threads and newest mail", async () => {
    const result = await t.server.search(t.person, { q: "anna" });
    assert.deepEqual(result.people, [{ email: "anna@studio.example", name: "Anna Schmidt", threads: 3, lastMessageAt: (await t.threadBySubject("Long one")).lastMessageAt }]);
    assert.deepEqual((await t.server.search(t.person, { q: "jor mul" })).people?.map((p) => p.email), ["joerg@mail.fernhill.example"]);
    assert.equal((await t.server.search(t.person, { q: "me" })).people, undefined, "the inbox's own address is nobody to find");
    assert.equal((await t.server.search(t.person, { from: "anna@studio.example" })).people, undefined, "only with text");
  });

  test("pages of one, ranked or listed, skip and repeat nothing", async () => {
    for (const query of [{ q: "invoice" }, { kinds: ["unknown" as const] }]) {
      const all = (await t.server.search(t.person, query)).items.map((item) => item.id);
      const paged: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await t.server.search(t.person, { ...query, limit: 1, ...(cursor && { cursor }) });
        paged.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(paged, all, JSON.stringify(query));
    }
  });
});
