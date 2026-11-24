// What leaves the server, held to the words a person is shown (docs/contract-ai.md, "What leaves the server", and
// core's `AI_SENT_FIELD_WORDS`): a summary request never carries an address, a blocked sender's mail is never sent in
// either job, and no request carries a field the words don't name.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { AI_SENT_FIELD_WORDS, NAMELESS_SENDER, OWN_SENDER, type Inbox } from "@usualmail/core";
import { dataItems, type FakeRequest } from "../src/index.ts";
import { HOUR, KNOWN, historyFromKnown, makeServer, START, TEST_KEY, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

const ago = (ms: number) => new Date(Date.parse(START) - ms).toISOString();
const ADDRESS = /[^\s"'<>@]+@[^\s"'<>@]+\.[a-z]{2,}/i;
const ALICE = { name: "Alice Archer", email: "alice@people.example" };
const MALLORY = { name: "Mallory", email: "mallory@blocked.example" };

/**
 * Every field of a request is one the words name, and carries what they say: a categorize item has the subject, the
 * sender (name and address only), the List-Id, machine-sent and the text; a summarize request has the subject, then
 * each message's text and its sender's name, never an address anywhere.
 */
function assertOnlyNamedFields(sent: FakeRequest): void {
  const items = dataItems(sent.request.data);
  if (sent.kind === "choose") {
    assert.equal(items.length, 1, "one item to categorize");
    const named = Object.keys(AI_SENT_FIELD_WORDS.categorize);
    for (const key of Object.keys(items[0]!)) assert.ok(named.includes(key), `categorize carries "${key}", which the words don't name`);
    const from = items[0]!.from as Record<string, unknown>;
    for (const key of Object.keys(from)) assert.ok(["name", "email"].includes(key), `the sender carries "${key}"`);
    return;
  }
  const named = Object.keys(AI_SENT_FIELD_WORDS.summarize);
  assert.deepEqual(Object.keys(items[0]!), ["subject"], "the subject comes first, alone");
  for (const item of items.slice(1)) {
    for (const key of Object.keys(item)) assert.ok(named.includes(key), `summarize carries "${key}", which the words don't name`);
    assert.equal(typeof item.from, "string", "a sender's name, as text");
  }
  assert.doesNotMatch(sent.request.data, ADDRESS, "a summary request never carries an address");
}

/** Sets a key while paused (its own test isn't mail), then lets the AI process every inbox's waiting mail. */
async function credentialsThenOn(_inbox: Inbox): Promise<void> {
  await t.server.updateAiSettings(t.person, { credentials: { kind: "gateway", gateway: "vercel", apiKey: TEST_KEY }, paused: true });
  await t.server.whenIdle();
  t.models.requests.length = 0;
  await t.server.updateAiSettings(t.person, { paused: false });
  await t.server.whenIdle();
}

describe("a summary request never carries an address", () => {
  test("a sender without a name is 'someone', a name that is an address too, and addresses in the mail are replaced", async () => {
    const { inbox } = await t.connect({ address: "me@sent.example", history: [historyFromKnown] });
    await t.aiOn();
    const mailbox = t.mailboxes.get(inbox.address)!;
    mailbox.deliver({ from: { email: KNOWN.email }, subject: "Write to ops@lumen.example", text: "Reach me at dana@lumen.example.", messageId: "nameless@lumen.example", date: ago(2 * HOUR) });
    mailbox.deliver({ from: { email: inbox.address }, to: [KNOWN], subject: "Re: Write to ops@lumen.example", text: "Will do.", inReplyTo: "nameless@lumen.example", outgoing: true, date: ago(HOUR), messageId: "nameless-2@sent.example" });
    mailbox.deliver({ from: { name: "dana@lumen.example", email: KNOWN.email }, subject: "Re: Write to ops@lumen.example", text: "Thanks.", inReplyTo: "nameless-2@sent.example", date: ago(0) });
    await t.sync(inbox);
    const write = t.models.sent("write").at(-1)!;
    const items = dataItems(write.request.data);
    assert.deepEqual(items.slice(1).map((item) => item.from), [NAMELESS_SENDER, OWN_SENDER, NAMELESS_SENDER], "newest first");
    assert.match(String(items[0]!.subject), /\[address\]/);
    assert.match(String(items[3]!.text), /Reach me at \[address\]\./);
    for (const sent of t.models.requests) assertOnlyNamedFields(sent);
    // Categorizing still sends the newest incoming message's sender name and address, as the words say.
    const choose = t.models.sent("choose").at(-1)!;
    assert.deepEqual(dataItems(choose.request.data)[0]!.from, { name: "dana@lumen.example", email: KNOWN.email });
  });
});

describe("a blocked sender's mail is never sent to a model", () => {
  test("in either job, also inside another sender's thread and when it is the newest incoming message", async () => {
    const { inbox } = await t.connect({
      address: "me@blocks.example",
      history: [
        historyFromKnown,
        { from: MALLORY, subject: "Mallory's own", text: "MALLORY-OWN", date: ago(3 * HOUR), placement: { inInbox: true } },
        { from: ALICE, subject: "Plans", text: "ALICE-TEXT", messageId: "plans@people.example", date: ago(2 * HOUR), placement: { inInbox: true } },
        { from: MALLORY, subject: "Re: Plans", text: "MALLORY-REPLY", inReplyTo: "plans@people.example", messageId: "plans-2@blocked.example", date: ago(HOUR), placement: { inInbox: true } },
      ],
    });
    const own = await t.threadBySubject("Mallory's own");
    await t.server.act(t.person, { threadIds: [own.id], action: { kind: "block_sender" } });
    await credentialsThenOn(inbox);
    const everything = JSON.stringify(t.models.requests.map((sent) => sent.request));
    assert.ok(everything.includes("ALICE-TEXT"), "the thread was processed");
    assert.doesNotMatch(everything, /mallory/i, "nothing of the blocked sender's: not her reply, not her name or address, not her own thread");
    const choose = t.models.sent("choose").find((sent) => String(dataItems(sent.request.data)[0]!.subject) === "Plans")!;
    assert.deepEqual(dataItems(choose.request.data)[0]!.from, ALICE, "categorized from the newest message that isn't hers");
    for (const sent of t.models.requests) assertOnlyNamedFields(sent);

    // Her next reply into the same thread sends nothing either, and the thread isn't due again for it.
    t.models.requests.length = 0;
    t.mailboxes.get(inbox.address)!.deliver({ from: MALLORY, subject: "Re: Plans", text: "MALLORY-AGAIN", inReplyTo: "plans-2@blocked.example" });
    await t.sync(inbox);
    assert.equal(t.models.requests.length, 0);
    assert.equal((await t.server.aiStatus(t.person)).pending, 0, "nothing waits for her mail");
  });

  test("a thread a blocked sender started is summarized without her messages when someone else brings it back", async () => {
    const { inbox } = await t.connect({ address: "me@blocks2.example", history: [historyFromKnown, { from: ALICE, subject: "Hello", date: ago(4 * HOUR) }] });
    await t.aiOn();
    const mailbox = t.mailboxes.get(inbox.address)!;
    mailbox.deliver({ from: MALLORY, subject: "MALLORY-SUBJECT", text: "MALLORY-FIRST", messageId: "m1@blocked.example", date: ago(3 * HOUR) });
    await t.sync(inbox);
    const hers = await t.threadBySubject("MALLORY-SUBJECT");
    await t.server.act(t.person, { threadIds: [hers.id], action: { kind: "block_sender" } });
    t.models.requests.length = 0;
    mailbox.deliver({ from: ALICE, cc: [MALLORY], subject: "An answer from Alice", text: "ALICE-ANSWER", inReplyTo: "m1@blocked.example", date: ago(HOUR) });
    await t.sync(inbox);
    const everything = JSON.stringify(t.models.requests.map((sent) => sent.request));
    assert.ok(everything.includes("ALICE-ANSWER"));
    assert.doesNotMatch(everything, /mallory/i, "neither her text, the subject she wrote, nor her address in the copy line");
    for (const sent of t.models.requests) assertOnlyNamedFields(sent);
  });
});

describe("a receipt's or an invoice's details", () => {
  test("are asked with exactly the fields a summary request carries, and no address", async () => {
    const { inbox } = await t.connect({ address: "me@details.example", history: [historyFromKnown] });
    await t.aiOn();
    t.models.choose = () => "invoice";
    const mailbox = t.mailboxes.get(inbox.address)!;
    mailbox.deliver({ from: { email: "billing@shop.example" }, subject: "Invoice for billing@shop.example", text: "Pay 10.00 EUR to accounts@shop.example.", messageId: "inv@shop.example", date: ago(HOUR) });
    await t.sync(inbox);
    const details = t.models.sent("extract");
    assert.equal(details.length, 1);
    assertOnlyNamedFields(details[0]!);
    assert.equal(dataItems(details[0]!.request.data)[1]!.from, NAMELESS_SENDER);
  });
});

describe("a notification's summary and event", () => {
  test("are asked with exactly the fields a summary request carries, and no address", async () => {
    const { inbox } = await t.connect({ address: "me@event.example", history: [historyFromKnown] });
    await t.aiOn();
    t.models.choose = () => "notification";
    const mailbox = t.mailboxes.get(inbox.address)!;
    mailbox.deliver({ from: { email: "updates@parcels.example" }, subject: "Out for delivery to updates@parcels.example", text: "Ask updates@parcels.example.", date: ago(HOUR) });
    await t.sync(inbox);
    const sent = t.models.sent("extract");
    assert.equal(sent.length, 1);
    assertOnlyNamedFields(sent[0]!);
  });
});

