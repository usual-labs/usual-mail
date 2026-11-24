// The revised provider interface: flag-only `changed`, mailboxes without stacks, `reset`, `untrash` with a
// destination, notes, batches in any order, and the repair after a start or a reconnect.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { MailProvider, ProviderMessage, ProviderOp, SyncBatch } from "@usualmail/core";
import { aesGcmSecrets, FakeModels, MailServer, MemoryEventBus, ProviderRegistry, webRandom, type Host } from "../src/index.ts";
import { openDatabase } from "../src/node/db.ts";
import { ManualClock, MemoryMailbox, memoryFactory, NO_STACKS_NOTE } from "../src/testing/index.ts";
import { remoteId } from "../src/search/remote.ts";
import { at, DAY, HOUR, historyFromKnown, KNOWN, listen, makeServer, START, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => (t = await makeServer()));
afterEach(async () => t.close());

const refOf = (mailbox: MemoryMailbox, subject: string) => mailbox.messages().find((m) => m.subject === subject)!.ref;

describe("changes the provider sends without the message", () => {
  test("flag and placement changes arrive as `changed` and win; a change to an unknown message is ignored", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown], mailbox: { sendChanges: true } });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Lunch?", date: at(-HOUR) });
    mailbox.deliver({ from: KNOWN, subject: "Junk", date: at(-HOUR), placement: { spam: true } });
    await t.sync(inbox);
    const cursor = mailbox.cursor;
    mailbox.update(refOf(mailbox, "Lunch?"), { placement: { inInbox: false }, seen: true });
    mailbox.update(refOf(mailbox, "Junk"), { seen: true });
    const batch = mailbox.sync(cursor, null);
    assert.deepEqual(batch.upserted, []);
    assert.deepEqual(batch.changed!.map((c) => [c.ref, c.seen, c.placement.inInbox]), [[refOf(mailbox, "Lunch?"), true, false], [refOf(mailbox, "Junk"), true, true]]);

    await t.sync(inbox);
    const after = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([after.done, after.unread], [true, false]);
    await assert.rejects(t.threadBySubject("Junk"));
    assert.deepEqual(t.errors, []);
  });
});

describe("a mailbox that can't keep stacks", () => {
  test("reports no stack; the server keeps the stack itself, puts the provider's note on the record and doesn't keep writing", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown], mailbox: { keepsStacks: false } });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Photos", date: at(-HOUR) });
    assert.equal("stack" in mailbox.sync(null, null).upserted[0]!.placement, false);

    // A stacked thread is out of the provider's inbox; the stack itself is nothing the mailbox can show.
    const heard = listen(t);
    const stacked = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "stack", stack: "reply_later" } });
    await t.server.whenIdle();
    heard.stop();
    assert.deepEqual(mailbox.applied.map((op) => (op.op === "place" ? [op.inInbox, op.category, op.screened, op.stack] : op.op)), [[false, null, false, "reply_later"]]);
    const noted = heard.events.flatMap((e) => (e.type === "action.recorded" ? [[e.record.id, e.record.version, e.record.note, e.record.silent]] : []));
    assert.deepEqual(noted, [[stacked.records[0]!.id, 1, undefined, false], [stacked.records[0]!.id, 2, NO_STACKS_NOTE, false]]);
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } });
    await t.server.whenIdle();
    assert.equal(mailbox.applied.length, 2);

    await t.sync(inbox);
    await t.sync(inbox);
    const after = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([after.category, after.stack], ["newsletter", "reply_later"]);
    assert.equal(mailbox.applied.length, 2);
    assert.deepEqual((await t.server.stack(t.person, "reply_later", {})).items.map((x) => x.id), [thread.id]);
    assert.deepEqual(t.infos, [], "notes go on records, not to the log");
  });
});

describe("stacks changed at the provider", () => {
  const at0 = { trashed: false, spam: false };
  const unfiled = { category: null, screened: false };

  test("a stacked thread is archived with its label; moved into the inbox there, it is a conversation in Home and loses the label", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Photos", date: at(-HOUR) });
    const stacked = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "stack", stack: "reply_later" } });
    await t.server.whenIdle();
    assert.deepEqual(mailbox.get(refOf(mailbox, "Photos"))!.placement, { inInbox: false, ...unfiled, stack: "reply_later", ...at0 });

    mailbox.update(refOf(mailbox, "Photos"), { placement: { inInbox: true } });
    await t.sync(inbox);
    const inHome = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([inHome.category, inHome.categorizedBy, inHome.done, inHome.stack], ["conversation", "mailbox", false, undefined]);
    assert.deepEqual((await t.server.home(t.person, {})).items.map((x) => x.id), [thread.id]);
    assert.deepEqual(mailbox.get(refOf(mailbox, "Photos"))!.placement, { inInbox: true, ...unfiled, stack: null, ...at0 }, "the server removed the label");
    await assert.rejects(t.server.undo(t.person, stacked.records[0]!.id), /can no longer be undone/);
  });

  test("a stack label added there stacks it, even when archived at the same time; removed there, it is done", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Photos", date: at(-HOUR) });

    mailbox.update(refOf(mailbox, "Photos"), { placement: { stack: "set_aside" } });
    await t.sync(inbox);
    const restacked = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([restacked.done, restacked.stack], [false, "set_aside"]);
    assert.deepEqual(mailbox.get(refOf(mailbox, "Photos"))!.placement, { inInbox: false, ...unfiled, stack: "set_aside", ...at0 }, "written back out of the inbox");

    mailbox.update(refOf(mailbox, "Photos"), { placement: { stack: null } });
    await t.sync(inbox);
    const unstacked = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([unstacked.done, unstacked.stack], [true, undefined], "an undecided thread out of the inbox and not waiting is done");

    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "not_done" } });
    await t.server.whenIdle();
    assert.deepEqual(mailbox.get(refOf(mailbox, "Photos"))!.placement, { inInbox: true, ...unfiled, stack: null, ...at0 });
    mailbox.update(refOf(mailbox, "Photos"), { placement: { inInbox: false, stack: "reply_later" } });
    await t.sync(inbox);
    const both = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([both.done, both.stack], [false, "reply_later"]);

    // Archived there while in Home: done, off its stack.
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "unstack" } });
    await t.server.whenIdle();
    assert.equal(mailbox.get(refOf(mailbox, "Photos"))!.placement.inInbox, true);
    mailbox.update(refOf(mailbox, "Photos"), { placement: { inInbox: false } });
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, thread.id)).thread.done, true);
  });

  test("moved to a category's label there changes only the category; a waiting thread taken into the inbox there stops waiting", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Digest", date: at(-HOUR) });
    mailbox.update(refOf(mailbox, "Digest"), { placement: { inInbox: false, category: "newsletter" } });
    await t.sync(inbox);
    const filed = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([filed.category, filed.categorizedBy, filed.done], ["newsletter", "mailbox", false]);
    assert.deepEqual((await t.server.category(t.person, "newsletter", {})).items.map((x) => x.id), [thread.id]);

    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "conversation" } });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "come_back", at: at(2 * DAY) } });
    await t.server.whenIdle();
    assert.deepEqual(mailbox.get(refOf(mailbox, "Digest"))!.placement, { inInbox: false, ...unfiled, stack: null, ...at0 }, "waiting: out of the inbox");
    mailbox.update(refOf(mailbox, "Digest"), { placement: { inInbox: true } });
    await t.sync(inbox);
    const back = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([back.comeBackAt, back.done, back.category], [undefined, false, "conversation"]);
    assert.ok((await t.server.home(t.person, {})).items.some((x) => x.id === thread.id));
  });

  test("the Screening label added there screens the thread, taken away it stops screening; the sender isn't let in or out", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown], mailbox: { kind: "gmail" } });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Hmm", date: at(-HOUR) });
    mailbox.update(refOf(mailbox, "Hmm"), { placement: { inInbox: false, screened: true } });
    await t.sync(inbox);
    const screened = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([screened.screened, screened.done], [true, false]);
    assert.deepEqual((await t.server.screening(t.person, {})).items.map((x) => x.id), [thread.id]);
    // Its sender is still let in: their next mail isn't screened.
    const next = await t.receive(inbox, { from: KNOWN, subject: "Hmm again", date: at(-HOUR / 2) });
    assert.equal(next.screened, false);

    mailbox.update(refOf(mailbox, "Hmm"), { placement: { screened: false } });
    await t.sync(inbox);
    const unscreened = (await t.server.thread(t.person, thread.id)).thread;
    // Out of the inbox, undecided, on no stack and not waiting: it reads as done.
    assert.deepEqual([unscreened.screened, unscreened.done], [false, true]);
  });
});

describe("a reset", () => {
  test("lists the window again; what the listing didn't include is dropped, and a thread left empty is removed", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const lone = await t.receive(inbox, { from: KNOWN, subject: "Lone", date: at(-3 * HOUR) });
    const pair = await t.receive(inbox, { from: KNOWN, subject: "Pair", date: at(-2 * HOUR) });
    mailbox.deliver({ from: KNOWN, subject: "Re: Pair", date: at(-HOUR), inReplyTo: mailbox.messages().find((m) => m.subject === "Pair")!.messageId! });
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, pair.id)).thread.messageCount, 2);

    // Gone from the mailbox without a trace in its change history: only a full listing shows it.
    mailbox.forget(refOf(mailbox, "Lone"));
    mailbox.forget(refOf(mailbox, "Pair"));
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, pair.id)).thread.messageCount, 2);

    mailbox.loseCursor();
    const heard = listen(t);
    await t.sync(inbox);
    heard.stop();
    const after = await t.server.thread(t.person, pair.id);
    assert.deepEqual(after.messages.map((m) => m.subject), ["Re: Pair"]);
    assert.deepEqual(heard.events.flatMap((e) => (e.type === "thread.removed" ? [e.threadId] : [])), [lone.id]);
    assert.deepEqual((await t.server.search(t.person, { q: "Lone" })).items, []);
    // The next sync carries on as usual.
    await t.receive(inbox, { from: KNOWN, subject: "After the reset", date: at(-HOUR / 2) });
    assert.equal(t.mailboxes.get(inbox.address)!.messages().length, 3);
  });
});

/** A provider that answers `sync` with batches a test lines up, and accepts every write. */
class ScriptedProvider implements MailProvider {
  readonly kind = "gmail" as const;
  readonly batches: SyncBatch[] = [];
  readonly applied: ProviderOp[] = [];
  /** Older mail the mailbox holds and no sync sends: what a person opens from a search of the mailbox. */
  readonly older: ProviderMessage[] = [];
  async search() {
    return { hits: [] };
  }
  async fetchThread(threadKey: string): Promise<ProviderMessage[]> {
    return this.older.filter((m) => m.threadKey === threadKey);
  }
  connection() {
    return { kind: "gmail" as const, clientId: "scripted-client.apps.example" };
  }
  async verify() {
    return { address: "me@scripted.example" };
  }
  async sync(): Promise<SyncBatch> {
    return this.batches.shift() ?? { upserted: [], removed: [], cursor: "end", more: false };
  }
  async fetchAttachment(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async apply(ops: ProviderOp[]) {
    this.applied.push(...ops);
    return ops.map((op) => ({ ok: true, ref: op.ref }));
  }
  async send() {
    return { messageId: "sent@scripted.example" };
  }
  async close() {}
}

function message(ref: string, subject: string, date: string, extra: Partial<ProviderMessage> = {}): ProviderMessage {
  return {
    ref,
    threadKey: "conversation",
    messageId: `${ref}@scripted.example`,
    references: [],
    from: KNOWN,
    to: [{ email: "me@scripted.example" }],
    cc: [],
    bcc: [],
    date,
    subject,
    attachments: [],
    seen: false,
    outgoing: false,
    placement: { inInbox: true, category: null, screened: false, stack: null, trashed: false, spam: false },
    automated: false,
    ...extra,
  };
}

describe("batches in any order", () => {
  let provider: ScriptedProvider;
  const connect = async () => {
    provider = new ScriptedProvider();
    t.providers.register("gmail", () => provider);
    provider.batches.push({ upserted: [message("h1", "History", at(-10 * DAY), { threadKey: "history" })], removed: [], cursor: "1", more: false });
    const inbox = await t.server.connectInbox(t.person, { name: "Scripted", color: "#000000", provider: "gmail", credentials: {} });
    await t.sync(inbox);
    return inbox;
  };

  test("a reply that arrives before its original joins the same thread; the thread is ordered by date", async () => {
    const inbox = await connect();
    provider.batches.push({ upserted: [message("r2", "Re: Plan", at(-HOUR))], removed: [], cursor: "2", more: false });
    await t.sync(inbox);
    const thread = await t.threadBySubject("Re: Plan");
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } });
    provider.batches.push({ upserted: [message("r1", "Plan", at(-5 * HOUR))], removed: [], cursor: "3", more: false });
    await t.sync(inbox);
    const detail = await t.server.thread(t.person, thread.id);
    assert.deepEqual(detail.messages.map((m) => m.subject), ["Plan", "Re: Plan"]);
    assert.deepEqual([detail.thread.subject, detail.thread.lastMessageAt], ["Plan", at(-HOUR).replace(".000Z", "Z")]);
    // Older mail catching up is not new mail: the done thread stays done.
    assert.equal(detail.thread.done, true);
  });

  test("within one batch the oldest message starts the thread", async () => {
    const inbox = await connect();
    provider.batches.push({ upserted: [message("b2", "Re: Order", at(-HOUR)), message("b1", "Order", at(-2 * HOUR))], removed: [], cursor: "2", more: false });
    await t.sync(inbox);
    const thread = await t.threadBySubject("Order");
    assert.deepEqual([thread.messageCount, thread.lastMessageAt], [2, at(-HOUR).replace(".000Z", "Z")]);
  });

  test("a reset listing over several batches drops only what none of them included, once it ends", async () => {
    const inbox = await connect();
    provider.batches.push({ upserted: [message("k1", "Keep 1", at(-3 * HOUR), { threadKey: "k1" }), message("k2", "Keep 2", at(-2 * HOUR), { threadKey: "k2" }), message("g1", "Gone", at(-HOUR), { threadKey: "g1" })], removed: [], cursor: "2", more: false });
    await t.sync(inbox);
    provider.batches.push(
      { upserted: [message("k1", "Keep 1", at(-3 * HOUR), { threadKey: "k1" })], removed: [], reset: true, cursor: "r1", more: true },
      { upserted: [], changed: [{ ref: "k2", seen: true, placement: { inInbox: true, category: null, screened: false, stack: null, trashed: false, spam: false } }, { ref: "h1", seen: true, placement: { inInbox: false, category: null, screened: false, stack: null, trashed: false, spam: false } }], removed: [], cursor: "r2", more: false },
    );
    await t.sync(inbox);
    assert.equal((await t.threadBySubject("Keep 1")).messageCount, 1);
    assert.equal((await t.threadBySubject("Keep 2")).unread, false);
    await t.threadBySubject("History");
    await assert.rejects(t.threadBySubject("Gone"));
  });

  test("a later reset listing leaves an old conversation opened from the mailbox alone: it is outside every listing", async () => {
    const inbox = await connect();
    const archived = { inInbox: false, category: null, screened: false, stack: null, trashed: false, spam: false };
    provider.older.push(message("o1", "Opened old", at(-400 * DAY), { threadKey: "old", placement: archived }));
    const opened = await t.server.openRemote(t.person, remoteId(inbox.id, "old"));
    assert.equal(opened.thread.done, true);
    // The provider lost its place: it lists its window again, which never held the old conversation.
    provider.batches.push({ upserted: [message("h1", "History", at(-10 * DAY), { threadKey: "history" })], removed: [], reset: true, cursor: "r1", more: false });
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, opened.thread.id)).messages.length, 1, "still held");
    assert.deepEqual((await t.server.search(t.person, { q: "opened" })).items.map((hit) => hit.id), [opened.thread.id]);
    // Gone at the provider is still gone here when the provider says so.
    provider.batches.push({ upserted: [], removed: ["o1"], cursor: "r2", more: false });
    await t.sync(inbox);
    assert.deepEqual((await t.server.search(t.person, { q: "opened" })).items, []);
  });

  test("opening an old conversation while a reset listing runs ends no listing and drops nothing", async () => {
    const inbox = await connect();
    provider.batches.push({ upserted: [message("k1", "Keep 1", at(-3 * HOUR), { threadKey: "k1" }), message("k2", "Keep 2", at(-2 * HOUR), { threadKey: "k2" })], removed: [], cursor: "2", more: false });
    await t.sync(inbox);
    provider.older.push(message("o1", "Opened old", at(-400 * DAY), { threadKey: "old", placement: { inInbox: false, category: null, screened: false, stack: null, trashed: false, spam: false } }));
    // The listing comes in two batches; the conversation is opened between them.
    const changedPlacement = { inInbox: true, category: null, screened: false, stack: null, trashed: false, spam: false };
    const rest: SyncBatch = { upserted: [], changed: [{ ref: "k2", seen: true, placement: changedPlacement }, { ref: "h1", seen: true, placement: { ...changedPlacement, inInbox: false } }], removed: [], cursor: "r2", more: false };
    let between!: () => void;
    const reached = new Promise<void>((resolve) => (between = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    provider.sync = async () => {
      if (calls++ === 0) return { upserted: [message("k1", "Keep 1", at(-3 * HOUR), { threadKey: "k1" })], removed: [], reset: true, cursor: "r1", more: true };
      if (calls === 2) {
        between();
        await gate;
        return rest;
      }
      return { upserted: [], removed: [], cursor: "end", more: false };
    };
    await t.server.syncInbox(t.person, inbox.id);
    await reached;
    const opened = await t.server.openRemote(t.person, remoteId(inbox.id, "old"));
    await t.threadBySubject("Keep 2");
    await t.threadBySubject("History");
    release();
    await t.server.whenIdle();
    assert.equal((await t.threadBySubject("Keep 2")).unread, false);
    await t.threadBySubject("History");
    assert.equal((await t.server.thread(t.person, opened.thread.id)).messages.length, 1, "and the opened conversation stays");
  });
});

describe("trash and untrash", () => {
  test("untrash puts each message back where its thread is: category, inbox and stack", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Keep", date: at(-HOUR) });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "stack", stack: "set_aside" } });
    const trashed = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "trash" } });
    await t.server.whenIdle();
    assert.equal(mailbox.get(refOf(mailbox, "Keep"))!.placement.trashed, true);
    await t.server.undo(t.person, trashed.records[0]!.id);
    await t.server.whenIdle();
    const untrash = mailbox.applied.at(-1)!;
    assert.deepEqual(untrash.op === "untrash" ? [untrash.inInbox, untrash.category, untrash.screened, untrash.stack] : untrash.op, [false, "newsletter", false, "set_aside"]);
    assert.deepEqual(mailbox.get(refOf(mailbox, "Keep"))!.placement, { inInbox: false, category: "newsletter", screened: false, stack: "set_aside", trashed: false, spam: false });
    // The next sync sees exactly what was written and changes nothing.
    const before = (await t.server.thread(t.person, thread.id)).thread;
    await t.sync(inbox);
    assert.deepEqual((await t.server.thread(t.person, thread.id)).thread, before);
  });

  test("trashed at the provider is thread.changed with trashed; gone from the provider is thread.removed", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Bin", date: at(-HOUR) });
    const heard = listen(t);
    mailbox.update(refOf(mailbox, "Bin"), { placement: { trashed: true } });
    await t.sync(inbox);
    mailbox.remove(refOf(mailbox, "Bin"));
    await t.sync(inbox);
    heard.stop();
    const events = heard.events.flatMap((e) => (e.type === "thread.changed" ? [["changed", e.thread.trashed]] : e.type === "thread.removed" ? [["removed", e.threadId === thread.id]] : []));
    assert.deepEqual(events, [["changed", true], ["removed", true]]);
  });

  test("new mail from a blocked sender doesn't bring a done thread back", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Group", date: at(-2 * HOUR) });
    const spammer = await t.receive(inbox, { from: { email: "pest@spam.example" }, subject: "Hi", date: at(-2 * HOUR) });
    await t.server.act(t.person, { threadIds: [spammer.id], action: { kind: "block_sender" } });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } });
    mailbox.deliver({ from: { email: "pest@spam.example" }, subject: "Re: Group", date: at(-HOUR), inReplyTo: mailbox.messages().find((m) => m.subject === "Group")!.messageId! });
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, thread.id)).thread.done, true);
  });
});

describe("repair", () => {
  test("after a restart, a write-back lost when the process stopped is sent", async () => {
    const store = await openDatabase(":memory:");
    const clock = new ManualClock(START);
    const mailboxes = new Map<string, MemoryMailbox>();
    const mailbox = new MemoryMailbox({ address: "me@acme.example", now: () => clock.now() });
    mailboxes.set(mailbox.address, mailbox);
    mailbox.deliver(historyFromKnown);
    const host = async (): Promise<Host> => ({
      db: store.db,
      clock,
      scheduler: clock,
      random: webRandom,
      events: new MemoryEventBus(),
      secrets: await aesGcmSecrets(new Uint8Array(32).fill(1), webRandom),
      log: { info: () => {}, error: () => {} },
    });
    // The first process: its write-back never finishes, as if the process stopped in the middle of it.
    let stall = false;
    const stalling = new ProviderRegistry();
    stalling.register("imap", (credentials, options) => {
      const provider = memoryFactory(mailboxes)(credentials, options);
      const apply = provider.apply.bind(provider);
      provider.apply = (ops) => (stall ? new Promise(() => {}) : apply(ops));
      return provider;
    });
    const first = await MailServer.create(await host(), { providers: stalling, models: new FakeModels() });
    // Started as a process is: a server that isn't started syncs nothing.
    await first.start();
    const person = (await first.authenticate((await first.pair({ code: (await first.ownerPairingCode())!.code, name: "Mac" })).token))!;
    const inbox = await first.connectInbox(person, { name: "Acme", color: "#000000", provider: "imap", credentials: { mailbox: mailbox.address } });
    await first.syncInbox(person, inbox.id);
    await first.whenIdle();
    mailbox.deliver({ from: KNOWN, subject: "Done with this", date: at(-HOUR) });
    await first.syncInbox(person, inbox.id);
    await first.whenIdle();
    stall = true;
    const thread = (await first.search(person, { q: "Done with this" })).items[0]!;
    await first.act(person, { threadIds: [thread.id], action: { kind: "done" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(mailbox.get(refOf(mailbox, "Done with this"))!.placement.inInbox, true);

    // The next process starts on the same store, syncs, and repairs what the provider is missing.
    const providers = new ProviderRegistry();
    providers.register("imap", memoryFactory(mailboxes));
    const second = await MailServer.create(await host(), { providers, models: new FakeModels() });
    await second.start();
    await second.whenIdle();
    assert.equal(mailbox.get(refOf(mailbox, "Done with this"))!.placement.inInbox, false);
    assert.equal((await second.thread(person, thread.id)).thread.done, true);
    await second.stop();
    store.close();
  });

  test("after a reconnect, what a refused tidy-up left behind is sent", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    mailbox.refuse = (op) => (op.op === "place" ? "Folder missing" : undefined);
    const screened = await t.receive(inbox, { from: { email: "new@stranger.example" }, subject: "Hello", date: at(-HOUR) });
    assert.deepEqual([screened.screened, screened.category], [true, "unknown"]);
    assert.ok(t.errors.some((line) => line.includes("Folder missing")));
    mailbox.refuse = null;
    // An ordinary sync with nothing new doesn't compare every thread.
    await t.sync(inbox);
    assert.equal(mailbox.get(refOf(mailbox, "Hello"))!.placement.inInbox, true);
    // The mailbox goes away and comes back: the first good sync after that repairs.
    mailbox.failSync = "Connection reset";
    await t.sync(inbox);
    assert.equal((await t.server.listInboxes(t.person))[0]!.status, "needs_attention");
    mailbox.failSync = null;
    await t.sync(inbox);
    assert.equal((await t.server.listInboxes(t.person))[0]!.status, "ok");
    assert.deepEqual(mailbox.get(refOf(mailbox, "Hello"))!.placement, { inInbox: false, category: null, screened: true, stack: null, trashed: false, spam: false });
  });
});
