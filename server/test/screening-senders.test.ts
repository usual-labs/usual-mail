// Senders let in for good without the AI (docs/contract.md, "Letting a sender in"; the owner's decision of
// 2026-11-25): another inbox connected on this server, and a colleague at the inbox's own domain when that domain isn't
// a public mail domain. Both only when the mailbox provider's checker proved the From domain; a spoofed From, the
// inbox's own address, a public domain and a subdomain stay screened. With the AI on, off or failing alike.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { failure } from "../src/index.ts";
import type { DeliverInput } from "../src/testing/index.ts";
import { makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

const proved = (domain: string) => ({ result: "verified", domain }) as const;

/** A colleague's note at the work inbox's own domain, proved. */
const COLLEAGUE = { from: { name: "Ann Lee", email: "ann@work.example" }, subject: "Lunch on Friday?", text: "Shall we?", fromCheck: proved("work.example") } satisfies DeliverInput;

async function twoInboxes() {
  const work = await t.connect({ address: "me@work.example" });
  const home = await t.connect({ address: "me@home.example" });
  return { work, home };
}

describe("another inbox on this server", () => {
  test("its proved mail lets it in for good, and lifts its earlier screened thread", async () => {
    const { work } = await twoInboxes();
    const unproved = await t.receive(work.inbox, { from: { email: "me@home.example" }, subject: "Before the proof", text: "Hi." });
    assert.equal(unproved.screened, true, "no proof yet: screened");
    const note = await t.receive(work.inbox, { from: { name: "Me", email: "me@home.example" }, subject: "Note to self", text: "Hi.", fromCheck: proved("home.example") });
    assert.deepEqual([note.screened, note.skippedScreening], [false, undefined]);
    assert.equal((await t.server.thread(t.person, unproved.id)).thread.screened, false, "every way in lifts their other threads");
    const later = await t.receive(work.inbox, { from: { email: "me@home.example" }, subject: "Later, unproved", text: "Hi." });
    assert.equal(later.screened, false, "let in for good");
    assert.ok(!work.mailbox.applied.some((op) => op.op === "place" && op.screened && op.ref === work.mailbox.messages().find((m) => m.subject === "Note to self")!.ref));
  });

  test("a spoofed From stays screened: not proved, proved for another domain, or no checker's word", async () => {
    const { work } = await twoInboxes();
    for (const [subject, fromCheck] of [
      ["Unverified", { result: "unverified" }],
      ["Another domain", proved("relay.example")],
      ["No word", undefined],
    ] as const) {
      const thread = await t.receive(work.inbox, { from: { email: "me@home.example" }, subject, text: "Hi.", ...(fromCheck && { fromCheck }) });
      assert.equal(thread.screened, true, subject);
    }
  });

  test("the inbox's own address is never let in by its own mail, proved or not", async () => {
    const { work } = await twoInboxes();
    const own = await t.receive(work.inbox, { from: { email: "me@work.example" }, subject: "From myself?", text: "Hi.", fromCheck: proved("work.example") });
    assert.equal(own.screened, true);
  });
});

describe("a colleague at the inbox's own domain", () => {
  test("proved: let in, so their next mail isn't screened either", async () => {
    const { work } = await twoInboxes();
    const first = await t.receive(work.inbox, COLLEAGUE);
    assert.equal(first.screened, false);
    const next = await t.receive(work.inbox, { from: COLLEAGUE.from, subject: "Notes", text: "Attached." });
    assert.equal(next.screened, false);
  });

  test("not proved, at a subdomain, or at another inbox's domain: screened", async () => {
    const { work } = await twoInboxes();
    const spoofed = await t.receive(work.inbox, { ...COLLEAGUE, subject: "Spoofed", fromCheck: { result: "unverified" } });
    assert.equal(spoofed.screened, true);
    const sub = await t.receive(work.inbox, { from: { email: "bo@eu.work.example" }, subject: "Subdomain", text: "Hi.", fromCheck: proved("eu.work.example") });
    assert.equal(sub.screened, true, "only the inbox's own domain itself");
    const elsewhere = await t.receive(work.inbox, { from: { email: "kim@home.example" }, subject: "Another inbox's domain", text: "Hi.", fromCheck: proved("home.example") });
    assert.equal(elsewhere.screened, true, "only this inbox's domain, and only another inbox's exact address");
  });

  test("never at a public mail domain", async () => {
    const { inbox } = await t.connect({ address: "me@yahoo.example" });
    const thread = await t.receive(inbox, { from: { email: "pat@yahoo.example" }, subject: "Hello from a webmail", text: "Hi.", fromCheck: proved("yahoo.example") });
    assert.equal(thread.screened, true);
  });

  test("a blocked colleague stays blocked", async () => {
    const { work } = await twoInboxes();
    const first = await t.receive(work.inbox, { ...COLLEAGUE, subject: "Before the block", fromCheck: undefined });
    await t.server.act(t.person, { threadIds: [first.id], action: { kind: "block_sender" } });
    const after = await t.receive(work.inbox, { ...COLLEAGUE, subject: "After the block" });
    assert.deepEqual([after.done, after.screened], [true, true]);
  });

  test("filed under Screening by the person's own filter: the filing stands", async () => {
    const { work } = await twoInboxes();
    const thread = await t.receive(work.inbox, { ...COLLEAGUE, placement: { inInbox: false, screened: true } });
    assert.equal(thread.screened, true);
  });
});

describe("with the AI on or failing", () => {
  test("on: a colleague's thread is categorized as any let-in sender's, never screened, never asked the gate's question", async () => {
    const { work } = await twoInboxes();
    await t.aiOn();
    t.models.choose = () => "conversation";
    const thread = await t.receive(work.inbox, COLLEAGUE);
    assert.deepEqual([thread.category, thread.screened], ["conversation", false]);
    assert.ok(!work.mailbox.applied.some((op) => op.op === "place" && op.screened), "never under Screening");
    assert.equal(t.models.sent("choose").length, 1, "only categorized");
  });

  test("failing: the colleague is let in all the same", async () => {
    const { work } = await twoInboxes();
    await t.aiOn();
    t.models.failAll = failure("unavailable");
    const thread = await t.receive(work.inbox, COLLEAGUE);
    assert.deepEqual([thread.category, thread.screened], ["unknown", false]);
  });
});
