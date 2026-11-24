// Which stored message new mail is (the security review's third round, 2026-11-18). A Message-ID is written by the
// sender, and everyone the person writes to learns it, so it alone never lets new mail change a stored message: its
// content, sender, `outgoing` or placement. The same message at the provider is its ref; on IMAP, where a move by
// another app or a UIDVALIDITY reset gives it a new ref, also the same Message-ID with the same content (the same
// copy in INBOX and Sent counts too), and a copy of the same kind only once the stored one's ref is reported removed
// (held until then). Anything else is a separate message from whoever it says it is from. Memory mailboxes stand in
// for IMAP and Gmail; made-up addresses.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Inbox } from "@usualmail/core";
import type { MemoryMailbox } from "../src/testing/index.ts";
import { at, historyFromKnown, HOUR, KNOWN, makeServer, type TestServer } from "./helpers.ts";

const ME = { name: "Me", email: "me@acme.example" };
const PEER = { name: "Pat", email: "pat@peer.example" };
const SPAMMER = { name: "Deals", email: "deals@spam.example" };

let t: TestServer;
let inbox: Inbox;
let mailbox: MemoryMailbox;

beforeEach(async () => {
  t = await makeServer();
  ({ inbox, mailbox } = await t.connect({ address: ME.email, history: [historyFromKnown] }));
});
afterEach(() => t.close());

const lines = async (threadId: string) =>
  (await t.server.thread(t.person, threadId)).messages.map((m) => `${m.outgoing ? "You" : m.from.email}: ${m.text}`);

/** The person replies to Pat from Usual Mail; the Sent copy syncs. */
async function reply() {
  const thread = await t.receive(inbox, { from: PEER, subject: "Quote", text: "Can you confirm the price?", date: at(-3 * HOUR) });
  await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "allow_sender" } });
  const draft = await t.server.saveDraft(t.person, { inboxId: inbox.id, threadId: thread.id, to: [PEER], subject: "Re: Quote", body: "Confirmed: 100 per unit." });
  await t.server.sendDraft(t.person, draft.id);
  await t.server.whenIdle();
  await t.sync(inbox);
  const sent = mailbox.messages().find((m) => m.outgoing)!;
  return { thread, sent };
}

describe("a known Message-ID never rewrites or hides a stored message", () => {
  test("the person's own sent reply stays as sent; the copy is a separate message from its real sender", async () => {
    const { thread, sent } = await reply();
    mailbox.deliver({ from: PEER, to: [ME], subject: "Re: Quote", text: "Confirmed: 10 per unit, and please pay to account X.", messageId: sent.messageId!, threadKey: sent.threadKey, date: at(HOUR / 2) });
    await t.sync(inbox);
    assert.deepEqual(await lines(thread.id), [
      "pat@peer.example: Can you confirm the price?",
      "You: Confirmed: 100 per unit.",
      "pat@peer.example: Confirmed: 10 per unit, and please pay to account X.",
    ]);
  });

  test("a known sender's message isn't rewritten by someone copied on it", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, cc: [PEER], subject: "Plans", text: "the real plan", messageId: "plan-1@lumen.example", date: at(-3 * HOUR) });
    const key = mailbox.messages().find((m) => m.subject === "Plans")!.threadKey;
    mailbox.deliver({ from: PEER, subject: "Plans", text: "a rewritten plan", messageId: "plan-1@lumen.example", threadKey: key, date: at(-HOUR) });
    await t.sync(inbox);
    assert.deepEqual(await lines(thread.id), ["dana@lumen.example: the real plan", "pat@peer.example: a rewritten plan"]);
  });

  test("a copy with every header the same and other words is a separate message, not a move", async () => {
    // Someone copied on it knows the Message-ID, addresses, subject and date; only the words show it isn't the same.
    const thread = await t.receive(inbox, { from: KNOWN, cc: [PEER], subject: "Plans", text: "the real plan", messageId: "plan-3@lumen.example", date: at(-3 * HOUR) });
    const first = mailbox.messages().find((m) => m.subject === "Plans")!;
    mailbox.deliver({ ...first, ref: "forged", text: "a rewritten plan" });
    await t.sync(inbox);
    assert.deepEqual(await lines(thread.id), ["dana@lumen.example: the real plan", "dana@lumen.example: a rewritten plan"]);
  });

  test("an exact copy, as anyone who received it could send, filed as spam: nothing moves while the stored copy is there", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, cc: [PEER], subject: "Plans", text: "the real plan", messageId: "plan-4@lumen.example", date: at(-3 * HOUR) });
    const first = mailbox.messages().find((m) => m.subject === "Plans")!;
    mailbox.deliver({ ...first, ref: "replayed", placement: { inInbox: false, spam: true } });
    await t.sync(inbox);
    const detail = await t.server.thread(t.person, thread.id);
    assert.equal(detail.thread.trashed, false);
    assert.equal(detail.messages.length, 1);
    mailbox.remove("replayed"); // the provider empties its spam: the person's message stays
    await t.sync(inbox);
    assert.deepEqual(await lines(thread.id), ["dana@lumen.example: the real plan"]);
  });

  test("an exact copy delivered to the inbox doesn't bring a done thread back", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Plans", text: "the real plan", messageId: "plan-5@lumen.example", date: at(-3 * HOUR) });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } });
    await t.server.whenIdle();
    const first = mailbox.messages().find((m) => m.subject === "Plans")!;
    mailbox.deliver({ ...first, ref: "replayed", placement: { inInbox: true } });
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, thread.id)).thread.done, true);
  });

  test("a copy filed as spam moves nothing: the thread stays in Home, not trashed", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, cc: [PEER], subject: "Plans", text: "the real plan", messageId: "plan-2@lumen.example", date: at(-3 * HOUR) });
    mailbox.deliver({ from: PEER, subject: "x", text: "a rewritten plan", messageId: "plan-2@lumen.example", date: at(-HOUR), placement: { inInbox: false, spam: true } });
    await t.sync(inbox);
    const detail = await t.server.thread(t.person, thread.id);
    assert.equal(detail.thread.trashed, false);
    assert.equal(detail.thread.subject, "Plans");
    assert.deepEqual(await lines(thread.id), ["dana@lumen.example: the real plan"]);
    assert.ok((await t.server.home(t.person, {})).items.some((x) => x.id === thread.id));
  });

  test("a forged copy of the person's sent mail to someone else lets nobody in and is never \"You\"", async () => {
    const spam = await t.receive(inbox, { from: SPAMMER, subject: "Buy now", text: "x", date: at(-5 * HOUR) });
    const { thread, sent } = await reply();
    mailbox.deliver({ from: ME, to: [SPAMMER], subject: "Re: Quote", text: "forged", messageId: sent.messageId!, threadKey: sent.threadKey, date: at(-2 * HOUR) });
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, spam.id)).thread.screened, true);
    assert.ok(!(await lines(thread.id)).includes("You: forged"));
  });
});

describe("the same message, recognised", () => {
  test("moved by another app on IMAP (a new ref, the same content): its move is taken, not a second message", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Moved", text: "hello", messageId: "moved-1@lumen.example", date: at(-HOUR) });
    const first = mailbox.messages().find((m) => m.subject === "Moved")!;
    mailbox.remove(first.ref);
    mailbox.deliver({ ...first, ref: "moved-elsewhere", placement: { inInbox: false } });
    await t.sync(inbox);
    const detail = await t.server.thread(t.person, thread.id);
    assert.equal(detail.messages.length, 1);
    assert.equal(detail.thread.done, true, "archived in the other app: done here");
  });

  test("moved by another app, its removal reported at a later sync: one message, where it was moved", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Moved", text: "hello", messageId: "moved-2@lumen.example", date: at(-HOUR) });
    const first = mailbox.messages().find((m) => m.subject === "Moved")!;
    mailbox.deliver({ ...first, ref: "moved-elsewhere", placement: { inInbox: false } });
    await t.sync(inbox);
    mailbox.remove(first.ref);
    await t.sync(inbox);
    const detail = await t.server.thread(t.person, thread.id);
    assert.equal(detail.messages.length, 1);
    assert.equal(detail.thread.done, true, "archived in the other app: done here");
  });

  test("a move completes with the copy's latest state, across a restart, whether its change comes whole or as a change", async () => {
    for (const sendChanges of [false, true]) {
      const own = await t.connect({ address: `me${Number(sendChanges)}@acme.example`, mailbox: { sendChanges }, history: [historyFromKnown] });
      const thread = await t.receive(own.inbox, { from: KNOWN, subject: "Late", text: "hello", messageId: `late-${sendChanges}@lumen.example`, date: at(-HOUR) });
      const first = own.mailbox.messages().find((m) => m.subject === "Late")!;
      own.mailbox.deliver({ ...first, ref: "copy", seen: false, placement: { inInbox: true } });
      await t.sync(own.inbox);
      own.mailbox.update("copy", { placement: { inInbox: false }, seen: true });
      await t.sync(own.inbox);
      await t.server.stop();
      await t.server.start();
      own.mailbox.remove(first.ref);
      await t.sync(own.inbox);
      const detail = await t.server.thread(t.person, thread.id);
      assert.equal(detail.messages.length, 1);
      assert.equal(detail.thread.done, true, `archived in the other app (${sendChanges ? "a change" : "sent whole"})`);
    }
  });

  test("a held copy that becomes the message by a move is no longer held: its removal then removes the message", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Twice moved", text: "x", messageId: "tm@lumen.example", date: at(-HOUR) });
    const first = mailbox.messages().find((m) => m.subject === "Twice moved")!;
    mailbox.deliver({ ...first, ref: "copy" });
    await t.sync(inbox);
    mailbox.update("copy", { seen: true }); // reported whole again, in the batch that removes the first
    mailbox.remove(first.ref);
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, thread.id)).messages.length, 1);
    mailbox.remove("copy");
    await t.sync(inbox);
    assert.equal((await t.server.search(t.person, { q: "Twice moved" })).items.length, 0);
  });

  test("held copies go when their own ref goes, and with their inbox; not by age, since the mailbox holds them", async () => {
    const { heldCopies } = await import("../src/db/index.ts");
    const held = async () => (await t.host.db.select({ ref: heldCopies.ref }).from(heldCopies)).map((row) => row.ref).sort();
    await t.receive(inbox, { from: KNOWN, subject: "Kept", text: "a", messageId: "kept-1@lumen.example", date: at(-HOUR) });
    await t.receive(inbox, { from: KNOWN, subject: "Gone", text: "b", messageId: "gone-1@lumen.example", date: at(-HOUR) });
    const kept = mailbox.messages().find((m) => m.subject === "Kept")!;
    const gone = mailbox.messages().find((m) => m.subject === "Gone")!;
    mailbox.deliver({ ...kept, ref: "kept-copy" });
    mailbox.deliver({ ...gone, ref: "gone-copy" });
    await t.sync(inbox);
    assert.deepEqual(await held(), ["gone-copy", "kept-copy"]);
    mailbox.remove("gone-copy");
    await t.sync(inbox);
    assert.deepEqual(await held(), ["kept-copy"], "the held copy's own removal forgets it");
    t.clock.advance(400 * 24 * HOUR);
    await t.server.stop();
    await t.server.start();
    assert.deepEqual(await held(), ["kept-copy"]);
    await t.server.removeInbox(t.person, inbox.id);
    assert.deepEqual(await held(), []);
  });

  test("one sync bringing a note to self twice, from INBOX and from Sent: one message, the inbox's own", async () => {
    // The INBOX copy comes first in the provider's batch; the Sent copy must still be the one kept.
    mailbox.deliver({ from: ME, to: [ME], subject: "Note", text: "buy milk", messageId: "note-2@acme.example", date: at(-HOUR) });
    mailbox.deliver({ from: ME, to: [ME], subject: "Note", text: "buy milk", messageId: "note-2@acme.example", date: at(-HOUR), outgoing: true, placement: { inInbox: false } });
    await t.sync(inbox);
    const found = (await t.server.search(t.person, { q: "Note" })).items;
    assert.equal(found.length, 1);
    const detail = await t.server.thread(t.person, found[0]!.id);
    assert.deepEqual(detail.messages.map((m) => m.outgoing), [true]);
    assert.equal(detail.thread.screened, false);
  });

  test("on Gmail a message is its id: another id with the same Message-ID and content is another message", async () => {
    const gmail = (await t.connect({ address: "me@gmail.example", mailbox: { kind: "gmail" } })).mailbox;
    const own = (await t.server.listInboxes(t.person)).find((x) => x.address === "me@gmail.example")!;
    gmail.deliver({ from: KNOWN, subject: "Twice", text: "same", messageId: "twice@lumen.example", date: at(-HOUR) });
    await t.sync(own);
    gmail.deliver({ from: KNOWN, subject: "Twice", text: "same", messageId: "twice@lumen.example", date: at(-HOUR), placement: { inInbox: false, trashed: true } });
    await t.sync(own);
    const found = (await t.server.search(t.person, { q: "Twice", inboxIds: [own.id] })).items;
    assert.equal(found.length, 1);
    assert.equal(found[0]!.trashed, false, "the other copy, trashed, doesn't trash the first");
    // Gmail never moves a message to another id: the first one gone and another id with its content is a new message.
    const first = gmail.messages().find((m) => m.subject === "Twice" && !m.placement.trashed)!;
    gmail.remove(first.ref);
    gmail.deliver({ from: KNOWN, subject: "Twice", text: "same", messageId: "twice@lumen.example", date: at(-HOUR) });
    await t.sync(own);
    const again = (await t.server.search(t.person, { q: "Twice", inboxIds: [own.id] })).items;
    assert.equal(again.length, 1);
    assert.notEqual(again[0]!.id, found[0]!.id);
  });
});

describe("the person's own mail, whichever copy comes first (IMAP)", () => {
  test("a note to self: the inbox copy first lands as a stranger's; when its Sent copy joins, it becomes the inbox's own", async () => {
    mailbox.deliver({ from: ME, to: [ME], subject: "Note", text: "buy milk", messageId: "note-1@acme.example", date: at(-HOUR) });
    await t.sync(inbox);
    const thread = (await t.server.screening(t.person, {})).items.find((x) => x.subject === "Note")!;
    assert.ok(thread, "screened while nothing says it is the inbox's own");
    mailbox.deliver({ from: ME, to: [ME], subject: "Note", text: "buy milk", messageId: "note-1@acme.example", date: at(-HOUR), outgoing: true, placement: { inInbox: false } });
    await t.sync(inbox);
    const detail = await t.server.thread(t.person, thread.id);
    assert.deepEqual(detail.messages.map((m) => m.outgoing), [true]);
    assert.equal(detail.thread.screened, false);
    assert.equal(detail.thread.sender, undefined);
    assert.equal(detail.thread.done, true, "as a thread of only the inbox's own mail arrives");
  });

  test("a note to self stays while either copy is left: the inbox copy stored first and deleted, the Sent copy takes its place", async () => {
    const note = { from: ME, to: [ME], subject: "Note", text: "buy milk", messageId: "note-3@acme.example", date: at(-HOUR) };
    mailbox.deliver(note);
    await t.sync(inbox);
    const thread = (await t.server.screening(t.person, {})).items.find((x) => x.subject === "Note")!;
    mailbox.deliver({ ...note, outgoing: true, placement: { inInbox: false } });
    await t.sync(inbox);
    mailbox.remove(mailbox.messages().find((m) => m.subject === "Note" && !m.outgoing)!.ref);
    await t.sync(inbox);
    assert.deepEqual((await t.server.thread(t.person, thread.id)).messages.map((m) => m.outgoing), [true]);
  });

  test("a note to self stays while either copy is left: the Sent copy stored first and deleted, the inbox copy keeps it", async () => {
    const note = { from: ME, to: [ME], subject: "Note", text: "buy milk", messageId: "note-4@acme.example", date: at(-HOUR) };
    mailbox.deliver({ ...note, outgoing: true, placement: { inInbox: false } });
    mailbox.deliver(note);
    await t.sync(inbox);
    const thread = (await t.server.search(t.person, { q: "Note" })).items[0]!;
    mailbox.remove(mailbox.messages().find((m) => m.subject === "Note" && m.outgoing)!.ref);
    await t.sync(inbox);
    assert.deepEqual((await t.server.thread(t.person, thread.id)).messages.map((m) => m.outgoing), [true]);
  });

  test("a reply with Cc to self: its Sent copy joining makes it \"You\" and leaves the thread where it was", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Lunch", text: "Friday?", messageId: "l1@lumen.example", date: at(-3 * HOUR) });
    const key = mailbox.messages().find((m) => m.subject === "Lunch")!.threadKey;
    const copy = { from: ME, to: [KNOWN], cc: [ME], subject: "Re: Lunch", text: "Yes, Friday.", messageId: "r1@acme.example", inReplyTo: "l1@lumen.example", threadKey: key, date: at(-2 * HOUR) };
    mailbox.deliver(copy);
    await t.sync(inbox);
    mailbox.deliver({ ...copy, outgoing: true, placement: { inInbox: false } });
    await t.sync(inbox);
    const detail = await t.server.thread(t.person, thread.id);
    assert.deepEqual(await lines(thread.id), ["dana@lumen.example: Friday?", "You: Yes, Friday."]);
    assert.equal(detail.thread.done, false);
    assert.equal(detail.thread.screened, false);
  });
});

describe("the order of copies in one sync", () => {
  test("the Sent copy is taken first: a Cc-to-self copy in the same sync doesn't end a wait for someone else's reply", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Offer", text: "Deal?", messageId: "o1@lumen.example", date: at(-3 * HOUR) });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "come_back", at: at(7 * 24 * HOUR), ifNoReply: true } });
    await t.server.whenIdle();
    const key = mailbox.messages().find((m) => m.subject === "Offer")!.threadKey;
    const copy = { from: ME, to: [KNOWN], cc: [ME], subject: "Re: Offer", text: "Maybe.", messageId: "r2@acme.example", inReplyTo: "o1@lumen.example", threadKey: key, date: at(-HOUR) };
    mailbox.deliver(copy); // the inbox copy is first in the provider's batch
    mailbox.deliver({ ...copy, outgoing: true, placement: { inInbox: false } });
    await t.sync(inbox);
    const after = (await t.server.thread(t.person, thread.id)).thread;
    assert.ok(after.comeBackAt, "still waiting for Dana");
  });
});

describe("Message-IDs the server sent", () => {
  test("are forgotten after 90 days, at a start", async () => {
    const { sentMessageIds } = await import("../src/db/index.ts");
    const day = 24 * HOUR;
    await t.host.db.insert(sentMessageIds).values([
      { inboxId: inbox.id, messageId: "old\nx", sentAt: t.clock.now() - 91 * day },
      { inboxId: inbox.id, messageId: "recent\nx", sentAt: t.clock.now() - day },
    ]);
    await t.server.stop();
    await t.server.start();
    const left = await t.host.db.select({ id: sentMessageIds.messageId }).from(sentMessageIds);
    assert.deepEqual(left.map((row) => row.id), ["recent\nx"]);
  });

  test("a copy of exactly what was sent, with a Bcc added, is the inbox's own and lets nobody in", async () => {
    // The key leaves Bcc out (a Sent copy doesn't carry it), so a recipient could add one; the copy lets nobody in.
    const spam = await t.receive(inbox, { from: SPAMMER, subject: "Buy now", text: "x", date: at(-5 * HOUR) });
    const draft = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [{ email: "bo@people.example" }], subject: "Hello", body: "x" });
    await t.server.sendDraft(t.person, draft.id);
    await t.server.whenIdle();
    const sent = mailbox.messages().find((m) => m.subject === "Hello")!;
    mailbox.remove(sent.ref);
    await t.sync(inbox);
    mailbox.deliver({ from: ME, to: [{ email: "bo@people.example" }], bcc: [SPAMMER], subject: "Hello", text: "x", messageId: sent.messageId!, date: at(-HOUR) });
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, spam.id)).thread.screened, true);
    const copy = (await t.server.search(t.person, { q: "Hello" })).items[0]!;
    assert.deepEqual((await t.server.thread(t.person, copy.id)).messages.map((m) => m.outgoing), [true]);
  });

  test("a copy of exactly what was sent, too large for the host to keep whole, is still the inbox's own", async () => {
    // A host that keeps messages only up to a size (Cloudflare) makes the copy fit after it is compared with what was sent.
    const small = await makeServer({ limits: { storedMessageBytes: 4_000 } });
    try {
      const { inbox: box, mailbox: box_ } = await small.connect({ address: ME.email, history: [historyFromKnown] });
      const draft = await small.server.saveDraft(small.person, { inboxId: box.id, to: [{ email: "bo@people.example" }], subject: "Long reply", body: "A long reply, line after line. ".repeat(300) });
      await small.server.sendDraft(small.person, draft.id);
      await small.server.whenIdle();
      const sent = box_.messages().find((m) => m.subject === "Long reply")!;
      assert.ok((sent.text ?? "").length > 4_000, "what was sent is over the host's size");
      box_.remove(sent.ref);
      await small.sync(box);
      box_.deliver({ from: ME, to: sent.to, subject: sent.subject, text: sent.text, ...(sent.html !== undefined && { html: sent.html }), messageId: sent.messageId!, date: at(-HOUR) });
      await small.sync(box);
      const copy = (await small.server.search(small.person, { q: "Long reply" })).items[0]!;
      assert.deepEqual((await small.server.thread(small.person, copy.id)).messages.map((m) => m.outgoing), [true]);
    } finally {
      await small.close();
    }
  });

  test("reused with other recipients, the copy isn't the inbox's own and lets nobody in", async () => {
    const spam = await t.receive(inbox, { from: SPAMMER, subject: "Buy now", text: "x", date: at(-5 * HOUR) });
    const draft = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [{ email: "bo@people.example" }], subject: "Hello", body: "x" });
    await t.server.sendDraft(t.person, draft.id);
    await t.server.whenIdle();
    const sent = mailbox.messages().find((m) => m.subject === "Hello")!;
    mailbox.remove(sent.ref); // the Sent copy never stays (a mailbox that keeps none)
    await t.sync(inbox);
    mailbox.deliver({ from: ME, to: [SPAMMER], subject: "Hello", text: "x", messageId: sent.messageId!, date: at(-HOUR) });
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, spam.id)).thread.screened, true);
    const forged = (await t.server.search(t.person, { q: "Hello" })).items[0]!;
    assert.deepEqual((await t.server.thread(t.person, forged.id)).messages.map((m) => m.outgoing), [false]);
  });
});

describe("a copy of what the server sent, with something of someone else's (the fourth review)", () => {
  for (const kind of ["imap", "gmail"] as const) {
    test(`${kind}: the same Message-ID, addresses, subject and text, with HTML of the sender's own, isn't "You"`, async () => {
      const own = await t.connect({ address: `me-${kind}@acme.example`, mailbox: { kind }, history: [historyFromKnown] });
      const thread = await t.receive(own.inbox, { from: PEER, subject: "Quote", text: "Can you confirm the price?", date: at(-3 * HOUR) });
      await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "allow_sender" } });
      const draft = await t.server.saveDraft(t.person, { inboxId: own.inbox.id, threadId: thread.id, to: [PEER], subject: "Re: Quote", body: "Confirmed: 100 per unit." });
      await t.server.sendDraft(t.person, draft.id);
      await t.server.whenIdle();
      await t.sync(own.inbox);
      const mine = own.mailbox.messages().find((m) => m.outgoing)!;
      own.mailbox.deliver({
        from: mine.from, to: mine.to, cc: mine.cc, subject: mine.subject, text: mine.text, messageId: mine.messageId,
        html: "<p>Confirmed: 10 per unit. New bank details: account X.</p>", threadKey: mine.threadKey, date: mine.date,
      });
      await t.sync(own.inbox);
      const detail = await t.server.thread(t.person, thread.id);
      assert.deepEqual(detail.messages.map((m) => m.outgoing), [false, true, false], "only what was sent is the inbox's own");
    });
  }

  test("the same Message-ID, addresses, subject and text, with an attachment added, isn't \"You\"", async () => {
    const draft = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [PEER], subject: "Invoice", body: "Attached later." });
    await t.server.sendDraft(t.person, draft.id);
    await t.server.whenIdle();
    const sent = mailbox.messages().find((m) => m.subject === "Invoice")!;
    mailbox.remove(sent.ref); // a mailbox that keeps no Sent copy: the server's record is the only evidence
    await t.sync(inbox);
    mailbox.deliver({
      from: ME, to: [PEER], subject: "Invoice", text: "Attached later.", messageId: sent.messageId!, date: at(-HOUR),
      attachments: [{ id: "a1", filename: "invoice.pdf", mimeType: "application/pdf", size: 3, inline: false, data: new Uint8Array([1, 2, 3]) }],
    });
    await t.sync(inbox);
    const copy = (await t.server.search(t.person, { q: "Invoice" })).items[0]!;
    assert.deepEqual((await t.server.thread(t.person, copy.id)).messages.map((m) => m.outgoing), [false]);
  });

  test("the same Message-ID, addresses and subject with other words isn't \"You\" and lets nobody in", async () => {
    const spam = await t.receive(inbox, { from: SPAMMER, subject: "Buy now", text: "x", date: at(-5 * HOUR) });
    const draft = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [SPAMMER], subject: "Unsubscribe", body: "Please remove me." });
    await t.server.act(t.person, { threadIds: [spam.id], action: { kind: "block_sender" } });
    await t.server.whenIdle();
    const sentId = (await t.server.sendDraft(t.person, draft.id)).id;
    await t.server.whenIdle();
    const sent = mailbox.messages().find((m) => m.subject === "Unsubscribe")!;
    mailbox.remove(sent.ref);
    await t.sync(inbox);
    mailbox.deliver({ from: ME, to: [SPAMMER], subject: "Unsubscribe", text: "Please keep sending.", messageId: sent.messageId!, date: at(-HOUR) });
    await t.sync(inbox);
    const copy = (await t.server.search(t.person, { q: "Unsubscribe" })).items[0]!;
    assert.deepEqual((await t.server.thread(t.person, copy.id)).messages.map((m) => m.outgoing), [false], `not draft ${sentId}'s copy`);
  });
});

describe("a thread's standing worked out again when the Sent copy joins (IMAP)", () => {
  test("its first incoming message is a blocked sender's: the thread is done and screened", async () => {
    const spam = await t.receive(inbox, { from: SPAMMER, subject: "Buy now", text: "x", date: at(-6 * HOUR) });
    await t.server.act(t.person, { threadIds: [spam.id], action: { kind: "block_sender" } });
    await t.server.whenIdle();
    const note = { from: ME, to: [SPAMMER], cc: [ME], subject: "Stop", text: "Stop writing.", messageId: "stop-1@acme.example", date: at(-3 * HOUR) };
    mailbox.deliver(note); // the Cc to self, first
    await t.sync(inbox);
    mailbox.deliver({ from: SPAMMER, to: [ME], subject: "Re: Stop", text: "Never.", messageId: "never-1@spam.example", inReplyTo: "stop-1@acme.example", date: at(-2 * HOUR) });
    await t.sync(inbox);
    const thread = (await t.server.search(t.person, { q: "Stop" })).items[0]!;
    mailbox.deliver({ ...note, outgoing: true, placement: { inInbox: false } });
    await t.sync(inbox);
    const after = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([after.screened, after.done], [true, true]);
  });

  test("a note to self the mailbox filed under Screening stays screened", async () => {
    const note = { from: ME, to: [ME], subject: "Filed", text: "kept", messageId: "filed-1@acme.example", date: at(-HOUR) };
    mailbox.deliver({ ...note, placement: { inInbox: false, screened: true } });
    await t.sync(inbox);
    const thread = (await t.server.search(t.person, { q: "Filed" })).items[0]!;
    mailbox.deliver({ ...note, outgoing: true, placement: { inInbox: false } });
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, thread.id)).thread.screened, true);
  });

  test("a thread the mailbox filed under Screening keeps it when its sender turns out to be someone let in", async () => {
    const note = { from: ME, to: [KNOWN], cc: [ME], subject: "Plan B", text: "here", messageId: "planb-1@acme.example", date: at(-3 * HOUR) };
    mailbox.deliver({ ...note, placement: { inInbox: false, screened: true } });
    await t.sync(inbox);
    mailbox.deliver({ from: KNOWN, to: [ME], subject: "Re: Plan B", text: "ok", messageId: "planb-2@lumen.example", inReplyTo: "planb-1@acme.example", date: at(-2 * HOUR), placement: { inInbox: false, screened: true } });
    await t.sync(inbox);
    const thread = (await t.server.search(t.person, { q: "Plan B" })).items[0]!;
    mailbox.deliver({ ...note, outgoing: true, placement: { inInbox: false } });
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, thread.id)).thread.screened, true);
  });
});
