// A thread is in the provider's inbox exactly when it shows in Home; come-back times (also those that passed while
// the server was stopped), notes on records, and what messages carry through from the provider.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { aesGcmSecrets, FakeModels, MailServer, MemoryEventBus, ProviderRegistry, webRandom, type Host } from "../src/index.ts";
import { openDatabase } from "../src/node/db.ts";
import { ManualClock, MemoryMailbox, memoryFactory } from "../src/testing/index.ts";
import { at, DAY, HOUR, historyFromKnown, KNOWN, listen, makeServer, START, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => (t = await makeServer()));
afterEach(async () => t.close());

const placed = (mailbox: MemoryMailbox, subject: string) => {
  const found = mailbox.messages().filter((m) => m.subject === subject && !m.outgoing);
  return found.map((m) => ({ inInbox: m.placement.inInbox, category: m.placement.category ?? null, screened: m.placement.screened ?? false, stack: m.placement.stack ?? null }));
};
const inHome = { inInbox: true, category: null, screened: false, stack: null };
const archived = { inInbox: false, category: null, screened: false, stack: null };

describe("the provider's inbox follows Home", () => {
  test("a come-back time archives it there; when it passes only the version rises, an event goes out and it goes back", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const later = await t.receive(inbox, { from: KNOWN, subject: "Later", date: at(-HOUR) });
    const set = await t.server.act(t.person, { threadIds: [later.id], action: { kind: "come_back", at: at(DAY) } });
    await t.server.whenIdle();
    assert.deepEqual(placed(mailbox, "Later"), [archived]);

    const waiting = (await t.server.thread(t.person, later.id)).thread;
    const heard = listen(t);
    t.clock.advance(DAY);
    await t.server.whenIdle();
    heard.stop();
    const back = (await t.server.thread(t.person, later.id)).thread;
    assert.equal(back.version, waiting.version + 1);
    assert.deepEqual(heard.events.flatMap((e) => (e.type === "thread.changed" ? [e.thread.version] : [])), [back.version]);
    assert.deepEqual(placed(mailbox, "Later"), [inHome]);
    // It ended no undo.
    assert.equal((await t.server.undo(t.person, set.records[0]!.id)).records[0]!.state, "undone");
  });

  test("a come-back time that passed while the server was stopped is handled at the next start", async () => {
    const store = await openDatabase(":memory:");
    const clock = new ManualClock(START);
    const mailboxes = new Map<string, MemoryMailbox>();
    const mailbox = new MemoryMailbox({ address: "me@acme.example", now: () => clock.now() });
    mailboxes.set(mailbox.address, mailbox);
    mailbox.deliver(historyFromKnown);
    const providers = new ProviderRegistry();
    providers.register("imap", memoryFactory(mailboxes));
    const host = async (): Promise<Host> => ({
      db: store.db, clock, scheduler: clock, random: webRandom, events: new MemoryEventBus(),
      secrets: await aesGcmSecrets(new Uint8Array(32).fill(7), webRandom), log: { info: () => {}, error: () => {} },
    });
    const first = await MailServer.create(await host(), { providers, models: new FakeModels() });
    // Started as a process is: a server that isn't started syncs nothing.
    await first.start();
    const person = (await first.authenticate((await first.pair({ code: (await first.ownerPairingCode())!.code, name: "Mac" })).token))!;
    const inbox = await first.connectInbox(person, { name: "Acme", color: "#000000", provider: "imap", credentials: { mailbox: mailbox.address } });
    await first.syncInbox(person, inbox.id);
    await first.whenIdle();
    mailbox.deliver({ from: KNOWN, subject: "While away", date: at(-HOUR) });
    await first.syncInbox(person, inbox.id);
    await first.whenIdle();
    const thread = (await first.search(person, { q: "While away" })).items[0]!;
    await first.act(person, { threadIds: [thread.id], action: { kind: "come_back", at: at(HOUR) } });
    await first.whenIdle();
    await first.stop();
    assert.deepEqual(placed(mailbox, "While away"), [archived]);

    // Stopped while the time passes.
    clock.advance(2 * HOUR);
    const events = new MemoryEventBus();
    const second = await MailServer.create({ ...(await host()), events }, { providers, models: new FakeModels() });
    const heard: number[] = [];
    events.subscribe((event) => {
      if (event.type === "thread.changed" && event.thread.id === thread.id) heard.push(event.thread.version);
    });
    const before = (await second.thread(person, thread.id)).thread;
    await second.start();
    await second.whenIdle();
    const after = (await second.thread(person, thread.id)).thread;
    assert.equal(after.version, before.version + 1);
    assert.deepEqual(heard, [after.version]);
    assert.deepEqual(placed(mailbox, "While away"), [inHome]);
    assert.deepEqual((await second.home(person, {})).items.map((x) => x.id), [thread.id]);
    await second.stop();
    store.close();
  });

  test("stacking and setting a time archive it there; unstacking and cancelling put it back; new mail is filed with its thread", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Photos", date: at(-2 * HOUR), messageId: "photos@lumen.example" });
    const step = async (action: Parameters<TestServer["server"]["act"]>[1]["action"]) => {
      await t.server.act(t.person, { threadIds: [thread.id], action });
      await t.server.whenIdle();
      return placed(mailbox, "Photos")[0];
    };
    assert.deepEqual(await step({ kind: "stack", stack: "reply_later" }), { ...archived, stack: "reply_later" });
    // New mail in a stacked thread isn't a move: it is filed where its thread is.
    mailbox.deliver({ from: KNOWN, subject: "Re: Photos", date: at(-HOUR), inReplyTo: "photos@lumen.example" });
    await t.sync(inbox);
    assert.deepEqual(placed(mailbox, "Re: Photos"), [{ ...archived, stack: "reply_later" }]);
    assert.equal((await t.server.thread(t.person, thread.id)).thread.stack, "reply_later");
    assert.deepEqual(await step({ kind: "unstack" }), inHome);
    assert.deepEqual(await step({ kind: "come_back", at: at(DAY) }), archived);
    assert.deepEqual(await step({ kind: "cancel_come_back" }), inHome);
    assert.deepEqual(await step({ kind: "categorize", category: "newsletter" }), { ...archived, category: "newsletter" });
    // A conversation is in Home, so in the inbox under no label.
    assert.deepEqual(await step({ kind: "categorize", category: "conversation" }), inHome);
  });

  test("taken out of the trash there, it comes out here and is compared with where its thread belongs", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Bin", date: at(-HOUR) });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "trash" } });
    await t.server.whenIdle();
    const ref = mailbox.messages().find((m) => m.subject === "Bin")!.ref;
    // While trashed only that counts: a label dropped there means nothing.
    mailbox.update(ref, { placement: { category: null, inInbox: false } });
    await t.sync(inbox);
    assert.deepEqual([(await t.server.thread(t.person, thread.id)).thread.trashed, (await t.server.thread(t.person, thread.id)).thread.category], [true, "newsletter"]);
    // Restored into the inbox there: out of the trash here, and moved into the inbox, so a conversation in Home.
    mailbox.update(ref, { placement: { trashed: false, inInbox: true } });
    await t.sync(inbox);
    const restored = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([restored.trashed, restored.category, restored.categorizedBy, restored.done], [false, "conversation", "mailbox", false]);
  });
});

describe("notes and what messages carry", () => {
  test("a later note replaces an earlier one on the record that caused the write-back", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", trust: "act_with_undo", agentAccess: true, history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Noted", date: at(-HOUR) });
    const agent = await t.agent([inbox.id]);
    let note = "First note";
    t.providers.register("imap", () => {
      const p = mailbox.provider();
      const apply = p.apply.bind(p);
      p.apply = async (ops) => (await apply(ops)).map((r) => (r.ok ? { ...r, note } : r));
      return p;
    });
    // The open provider was made before; reopen it by pausing and unpausing.
    await t.server.updateInbox(t.person, inbox.id, { paused: true });
    await t.server.updateInbox(t.person, inbox.id, { paused: false });
    const moved = (await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } })).records[0]!;
    await t.server.whenIdle();
    note = "Second note";
    const undo = await t.server.undo(agent.caller, moved.id);
    await t.server.whenIdle();
    const [item] = (await t.server.handled(t.person, { states: ["undone"] })).items;
    assert.deepEqual([item!.record.id, item!.record.note, item!.record.version], [undo.records[0]!.id, "Second note", 4]);
  });

  test("a message carries its List-Id and its attachments their Content-ID", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, {
      from: KNOWN, subject: "Issue 7", date: at(-HOUR), listId: "Lumen News <News.Lumen.example>",
      html: '<p>Hi</p><img src="cid:logo@lumen.example">',
      attachments: [{ id: "0", filename: "logo.png", mimeType: "image/png", size: 3, inline: true, contentId: "logo@lumen.example", data: new Uint8Array([1, 2, 3]) }],
    });
    const [message] = (await t.server.thread(t.person, thread.id)).messages;
    assert.equal(message!.listId, "news.lumen.example");
    assert.deepEqual(message!.attachments.map((a) => [a.filename, a.inline, a.contentId]), [["logo.png", true, "logo@lumen.example"]]);
  });
});
