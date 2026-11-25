// Sync with MemoryProvider: new mail, threading, changes at the provider, write-back and come back.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { memoryFactory } from "../src/testing/index.ts";
import { at, content, DAY, HOUR, historyFromKnown, KNOWN, listen, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => (t = await makeServer()));
afterEach(async () => t.close());

describe("sync", () => {
  test("the first sync takes the last 30 days as the provider has them, reading labels; new mail after it is sorted", async () => {
    const { inbox, mailbox } = await t.connect({
      address: "me@acme.example",
      history: [
        historyFromKnown,
        { from: { email: "old@friend.example" }, subject: "Still in the inbox", date: at(-2 * DAY), seen: false },
        { from: { email: "news@paper.example" }, subject: "Filed under Newsletters", date: at(-3 * DAY), placement: { inInbox: false, category: "newsletter" } },
        { from: { email: "lotte@friend.example" }, subject: "Archived but on a stack", date: at(-4 * DAY), placement: { inInbox: false, stack: "reply_later" } },
        { from: { email: "ancient@friend.example" }, subject: "Too old", date: at(-31 * DAY) },
      ],
    });
    const inboxes = await t.server.listInboxes(t.person);
    assert.equal(inboxes[0]!.status, "ok");
    assert.equal(inboxes[0]!.lastSyncedAt, at(0).replace(".000Z", "Z"));
    // A thread under no category's label is undecided; archived history is done, except under a category's label
    // within the history days (7 by default), so a new server's category lists show recent mail.
    const archived = await t.threadBySubject("Earlier conversation");
    assert.deepEqual([archived.category, archived.done, archived.categorizedBy, archived.screened], ["unknown", true, undefined, false]);
    const open = await t.threadBySubject("Still in the inbox");
    assert.deepEqual([open.category, open.done, open.categorizedBy, open.unread], ["unknown", false, undefined, true]);
    const filed = await t.threadBySubject("Filed under Newsletters");
    assert.deepEqual([filed.category, filed.categorizedBy, filed.done], ["newsletter", "mailbox", false]);
    // A thread on a stack is never done, so the stack wins over being archived.
    const stacked = await t.threadBySubject("Archived but on a stack");
    assert.deepEqual([stacked.stack, stacked.done, stacked.category], ["reply_later", false, "unknown"]);
    await assert.rejects(t.threadBySubject("Too old"));
    // Without the AI, the undecided threads that aren't done wait in the triage queue, oldest first. Nothing is screened.
    assert.deepEqual((await t.server.triageQueue(t.person, {})).map((item) => item.thread.subject), ["Archived but on a stack", "Still in the inbox"]);
    assert.deepEqual((await t.server.screening(t.person, {})).items, []);

    mailbox.deliver({ from: { name: "Ines", email: "ines@lumen.example" }, subject: "Workshop", text: "Thanks for Thursday!", date: at(-HOUR) });
    await t.sync(inbox);
    const fresh = await t.threadBySubject("Workshop");
    assert.deepEqual([fresh.category, fresh.screened, fresh.snippet, fresh.messageCount], ["unknown", true, "Thanks for Thursday!", 1]);
    assert.deepEqual(fresh.participants, [{ name: "Ines", email: "ines@lumen.example" }]);
    // The screened thread was filed out of the inbox at the provider, under Screening.
    const atProvider = mailbox.messages().find((m) => m.subject === "Workshop")!;
    assert.deepEqual(atProvider.placement, { inInbox: false, category: null, screened: true, stack: null, trashed: false, spam: false });
  });

  test("a reply joins its thread and brings a done thread back", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Contract", text: "Here it is", date: at(-3 * HOUR), attachments: [{ id: "a1", filename: "c.pdf", mimeType: "application/pdf", size: 3, inline: false, data: new Uint8Array([1, 2, 3]) }] });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } });
    await t.server.whenIdle();
    const first = mailbox.messages().find((m) => m.subject === "Contract")!;
    assert.equal(first.placement.inInbox, false);

    mailbox.deliver({ from: KNOWN, subject: "Re: Contract", text: "Any news?", inReplyTo: first.messageId!, date: at(-HOUR) });
    await t.sync(inbox);
    const detail = await t.server.thread(t.person, thread.id);
    assert.equal(detail.messages.length, 2);
    assert.deepEqual([detail.thread.done, detail.thread.messageCount, detail.thread.snippet, detail.thread.hasAttachments], [false, 2, "Any news?", true]);
    assert.equal(detail.thread.lastMessageAt, at(-HOUR).replace(".000Z", "Z"));
    assert.equal((await t.server.home(t.person, {})).items[0]!.id, thread.id);
    // The attachment comes from the provider.
    const file = await t.server.fetchAttachment(t.person, detail.messages[0]!.id, detail.messages[0]!.attachments[0]!.id);
    assert.deepEqual([...file.data], [1, 2, 3]);
  });

  test("archiving in the provider's own app marks the thread done; read there is read here", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Lunch?", date: at(-HOUR) });
    const ref = mailbox.messages().find((m) => m.subject === "Lunch?")!.ref;
    mailbox.update(ref, { placement: { inInbox: false }, seen: true });
    await t.sync(inbox);
    const after = (await t.server.thread(t.person, thread.id)).thread;
    // Archiving decides nothing about the category.
    assert.deepEqual([after.done, after.unread, after.category, after.categorizedBy], [true, false, "unknown", undefined]);
    assert.ok(!(await t.server.home(t.person, {})).items.some((x) => x.id === thread.id));

    // Moved back into the inbox there: in Home, a conversation the mailbox decided.
    mailbox.update(ref, { placement: { inInbox: true } });
    await t.sync(inbox);
    const back = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([back.done, back.category, back.categorizedBy], [false, "conversation", "mailbox"]);

    mailbox.update(ref, { placement: { trashed: true } });
    await t.sync(inbox);
    assert.ok(!(await t.server.home(t.person, {})).items.some((x) => x.id === thread.id));
    mailbox.remove(ref);
    await t.sync(inbox);
    assert.ok(!(await t.server.search(t.person, { q: "Lunch" })).items.length);
  });

  test("write-back keeps the provider in step, including an IMAP move that renames the message", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown], mailbox: { renameOnMove: true } });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Report", date: at(-HOUR), seen: false });
    const before = mailbox.messages().find((m) => m.subject === "Report")!;

    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "stack", stack: "reply_later" } });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "read" } });
    await t.server.whenIdle();
    const moved = mailbox.messages().find((m) => m.subject === "Report")!;
    assert.notEqual(moved.ref, before.ref);
    assert.deepEqual(moved.placement, { inInbox: false, category: "newsletter", screened: false, stack: "reply_later", trashed: false, spam: false });
    assert.equal(moved.seen, true);

    // The next sync sees the renamed message as the same one, and the old name as gone, and changes nothing.
    await t.sync(inbox);
    const detail = await t.server.thread(t.person, thread.id);
    assert.equal(detail.messages.length, 1);
    assert.deepEqual([detail.thread.category, detail.thread.stack, detail.thread.unread], ["newsletter", "reply_later", false]);

    // Later changes use the new name.
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "conversation" } });
    await t.server.whenIdle();
    const back = mailbox.messages().find((m) => m.subject === "Report")!;
    // A stacked conversation is out of the provider's inbox, under no category's label, with its stack.
    assert.deepEqual(back.placement, { inInbox: false, category: null, screened: false, stack: "reply_later", trashed: false, spam: false });
    assert.deepEqual(t.errors, []);
  });

  test("a refused write-back marks the record failed with the reason and puts the thread back", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Hold", date: at(-HOUR) });
    const before = (await t.server.thread(t.person, thread.id)).thread;
    const agent = await t.agent([inbox.id]);
    mailbox.refuse = (op) => (op.op === "place" ? "Folder Usual Mail/Receipts doesn't exist" : undefined);
    const heard: string[] = [];
    const stop = t.server.subscribe(t.person, (event) => {
      if (event.type === "action.recorded") heard.push(event.record.state);
    });
    const result = await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "receipt" }, reason: "A receipt" });
    assert.equal(result.records[0]!.state, "applied");
    await t.server.whenIdle();
    stop();
    assert.deepEqual(heard, ["applied", "failed"]);
    const failed = (await t.server.handled(t.person, { inboxId: inbox.id, states: ["failed"] })).items;
    assert.equal(failed.length, 1);
    assert.deepEqual([failed[0]!.record.id, failed[0]!.record.state, failed[0]!.record.undoable, failed[0]!.record.error],
      [result.records[0]!.id, "failed", false, "Folder Usual Mail/Receipts doesn't exist"]);
    const after = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual(content(after), content(before));
    assert.equal(after.version, before.version + 2);
    assert.equal(mailbox.get(mailbox.messages().find((m) => m.subject === "Hold")!.ref)!.placement.inInbox, true);
    await assert.rejects(t.server.undo(t.person, result.records[0]!.id), /failed, so there is nothing to undo/);
  });

  test("a refused undo leaves the action applied with the reason, so it can be tried again", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Hold", date: at(-HOUR) });
    const done = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } });
    await t.server.whenIdle();
    mailbox.refuse = () => "Mailbox is read-only";
    const records: Array<{ state: string; error?: string }> = [];
    const stop = t.server.subscribe(t.person, (event) => {
      if (event.type === "action.recorded") records.push({ state: event.record.state, ...(event.record.error && { error: event.record.error }) });
    });
    const undone = await t.server.undo(t.person, done.records[0]!.id);
    assert.equal(undone.records[0]!.state, "undone");
    await t.server.whenIdle();
    assert.deepEqual(records, [{ state: "undone" }, { state: "applied", error: "Undo failed at the provider: Mailbox is read-only" }]);
    assert.equal((await t.server.thread(t.person, thread.id)).thread.done, true);
    mailbox.refuse = null;
    const retried = await t.server.undo(t.person, done.records[0]!.id);
    await t.server.whenIdle();
    stop();
    assert.equal(retried.records[0]!.state, "undone");
    assert.equal((await t.server.thread(t.person, thread.id)).thread.done, false);
    assert.equal(mailbox.messages().find((m) => m.subject === "Hold")!.placement.inInbox, true);
  });

  test("an inbox whose mailbox refuses the login needs attention, with the reason", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example" });
    mailbox.failSync = "The mail server refused the password.";
    mailbox.signInRefused = true;
    await t.sync(inbox);
    const [after] = await t.server.listInboxes(t.person);
    assert.deepEqual(
      [after!.status, after!.statusDetail, after!.statusReason],
      ["needs_attention", "The mail server refused the password.", "needs_sign_in"],
      "a refused login needs attention at once",
    );
    mailbox.failSync = null;
    await t.sync(inbox);
    assert.equal((await t.server.listInboxes(t.person))[0]!.status, "ok");
  });

  test("a mailbox that can watch is synced when it changes; one that can't is polled", async () => {
    const watched = await t.connect({ address: "watch@acme.example", history: [historyFromKnown], mailbox: { watch: true } });
    const polled = await t.connect({ address: "poll@acme.example", history: [historyFromKnown] });
    await t.server.whenIdle();
    watched.mailbox.deliver({ from: KNOWN, subject: "Pushed", date: at(-HOUR) });
    polled.mailbox.deliver({ from: KNOWN, subject: "Polled", date: at(-HOUR) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.server.whenIdle();
    assert.equal((await t.threadBySubject("Pushed")).category, "unknown");
    await assert.rejects(t.threadBySubject("Polled"));
    t.clock.advance(60_000);
    await t.server.whenIdle();
    assert.equal((await t.threadBySubject("Polled")).category, "unknown");
  });

  test("a watched mailbox is still polled, since a watch may not see every folder (IMAP watches only INBOX)", async () => {
    // A watch that hears nothing, like IMAP's when mail is filed straight into another folder.
    const base = memoryFactory(t.mailboxes, { kind: "imap", now: () => t.clock.now() });
    t.providers.register("imap", (credentials, options) => {
      const provider = base(credentials, options);
      provider.watch = async () => async () => {};
      return provider;
    });
    const { mailbox } = await t.connect({ address: "watch@acme.example", history: [historyFromKnown] });
    await t.server.whenIdle();
    mailbox.deliver({ from: KNOWN, subject: "Filed by a server rule", date: at(-HOUR), placement: { inInbox: false, category: "newsletter" } });
    await t.server.whenIdle();
    await assert.rejects(t.threadBySubject("Filed by a server rule"));
    t.clock.advance(60_000);
    await t.server.whenIdle();
    const filed = await t.threadBySubject("Filed by a server rule");
    // New mail filed under a category keeps it, decided by the mailbox, and isn't done by that.
    assert.deepEqual([filed.category, filed.categorizedBy, filed.done], ["newsletter", "mailbox", false]);
  });
});

describe("come back", () => {
  test("a thread waits out of Home, then sorts at the top by its come-back time, which stays on it", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Later", date: at(-5 * HOUR) });
    await t.receive(inbox, { from: KNOWN, subject: "Newer", date: at(-HOUR) });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } });
    const set = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "come_back", at: at(2 * DAY) } });
    assert.equal(set.threads[0]!.done, false);
    await t.server.whenIdle();
    assert.ok(!(await t.server.home(t.person, {})).items.some((x) => x.id === thread.id));
    assert.ok(!(await t.server.category(t.person, "unknown", {})).items.some((x) => x.id === thread.id), "out of sight until it comes back: only waiting and search hold it");
    assert.equal((await t.server.counts(t.person)).all.categories.unknown, 1, "its category's count leaves it out too");
    assert.deepEqual((await t.server.search(t.person, { q: "later" })).items.map((x) => x.id), [thread.id]);
    assert.deepEqual((await t.server.waiting(t.person, {})).items.map((x) => x.id), [thread.id]);

    // A reply while waiting doesn't end a plain come-back.
    const mailbox = t.mailboxes.get(inbox.address)!;
    mailbox.deliver({ from: KNOWN, subject: "Re: Later", inReplyTo: mailbox.messages().find((m) => m.subject === "Later")!.messageId!, date: at(DAY) });
    t.clock.advance(DAY + HOUR);
    await t.sync(inbox);
    const waiting = (await t.server.thread(t.person, thread.id)).thread;
    assert.equal(waiting.comeBackAt, at(2 * DAY).replace(".000Z", "Z"));
    assert.ok(!(await t.server.home(t.person, {})).items.some((x) => x.id === thread.id));

    // When the time comes, nothing in the thread changes but its version, and an event says so.
    await t.receive(inbox, { from: KNOWN, subject: "Newest", date: at(DAY + 2 * HOUR) });
    const heard = listen(t);
    t.clock.advance(DAY);
    await t.server.whenIdle();
    heard.stop();
    const after = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual(content(after), content(waiting));
    assert.equal(after.version, waiting.version + 1);
    const threadEvents = heard.events.flatMap((e) => (e.type === "thread.changed" ? [[e.thread.id, e.thread.version]] : []));
    assert.deepEqual(threadEvents, [[thread.id, after.version]]);
    // Its come-back time is later than any message, so it is at the top of Home, and no longer waiting.
    assert.equal((await t.server.home(t.person, {})).items[0]!.id, thread.id);
    assert.deepEqual((await t.server.waiting(t.person, {})).items, []);
    assert.ok((await t.server.category(t.person, "unknown", {})).items.some((x) => x.id === thread.id), "back in its category's list");
    // Coming back isn't an action, so the come_back can still be undone.
    const undone = await t.server.undo(t.person, set.records[0]!.id);
    assert.deepEqual([undone.threads[0]!.done, undone.threads[0]!.comeBackAt], [true, undefined]);
  });

  test("with comeBackIfNoReply, someone else's reply ends the wait at once", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Offer", date: at(-HOUR) });
    const set = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "come_back", at: at(7 * DAY), ifNoReply: true } });
    await t.server.whenIdle();
    const original = mailbox.messages().find((m) => m.subject === "Offer")!;

    // The mailbox's own message (in Sent) doesn't count as a reply.
    t.clock.advance(HOUR);
    mailbox.deliver({ from: { email: "me@acme.example" }, to: [KNOWN], subject: "Re: Offer", inReplyTo: original.messageId!, date: at(HOUR), outgoing: true });
    await t.sync(inbox);
    assert.ok((await t.server.thread(t.person, thread.id)).thread.comeBackAt);

    t.clock.advance(HOUR);
    mailbox.deliver({ from: KNOWN, subject: "Re: Offer", inReplyTo: original.messageId!, date: at(2 * HOUR) });
    await t.sync(inbox);
    const after = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([after.comeBackAt, after.comeBackIfNoReply, after.done], [undefined, undefined, false]);
    assert.equal((await t.server.home(t.person, {})).items[0]!.id, thread.id);
    // The reply changed the come-back, so the come_back can't be undone exactly any more.
    const record = (await t.server.handled(t.person, { states: ["applied"] })).items;
    assert.deepEqual(record, []);
    await assert.rejects(t.server.undo(t.person, set.records[0]!.id), /can no longer be undone/);
  });
});

describe("inbox lifecycle", () => {
  test("pausing stops syncing; removing deletes the inbox and everything in it", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Before pause", date: at(-HOUR) });
    const paused = await t.server.updateInbox(t.person, inbox.id, { paused: true });
    assert.equal(paused.status, "paused");
    await assert.rejects(t.server.syncInbox(t.person, inbox.id), /paused/);
    mailbox.deliver({ from: KNOWN, subject: "During pause", date: at(-HOUR / 2) });
    t.clock.advance(5 * 60_000);
    await t.server.whenIdle();
    await assert.rejects(t.threadBySubject("During pause"));

    assert.equal((await t.server.updateInbox(t.person, inbox.id, { paused: false })).status, "connecting");
    await t.server.whenIdle();
    assert.equal((await t.server.listInboxes(t.person))[0]!.status, "ok");
    assert.equal((await t.threadBySubject("During pause")).category, "unknown");

    const heard: string[] = [];
    const stop = t.server.subscribe(t.person, (event) => heard.push(event.type));
    await t.server.removeInbox(t.person, inbox.id);
    stop();
    assert.deepEqual(heard, ["inbox.removed"]);
    assert.deepEqual(await t.server.listInboxes(t.person), []);
    await assert.rejects(t.server.thread(t.person, thread.id), /No such thread/);
    assert.deepEqual((await t.server.search(t.person, { q: "pause" })).items, []);
  });

  test("a write-back refused because its inbox was removed meanwhile isn't logged as an error", async () => {
    // The inbox is removed while a write-back's changes are at the provider, which then refuses them, as Gmail does
    // once a removed inbox's sign-in is revoked.
    let removeNow = false;
    let removed = false;
    for (const kind of ["imap", "gmail"] as const) {
      const factory = t.providers.get(kind)!;
      t.providers.register(kind, (credentials, options) => {
        const provider = factory(credentials, options);
        const apply = provider.apply.bind(provider);
        provider.apply = async (ops) => {
          if (!removeNow) return apply(ops);
          removeNow = false;
          await t.server.removeInbox(t.person, (await t.server.listInboxes(t.person))[0]!.id);
          removed = true;
          return ops.map(() => ({ ok: false, error: "Token has been expired or revoked." }));
        };
        return provider;
      });
    }
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Later", date: at(-HOUR) });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "come_back", at: at(DAY) } });
    await t.server.whenIdle();
    // Its come-back puts it back in the provider's inbox, a write-back no record caused.
    removeNow = true;
    t.clock.advance(DAY);
    await t.server.whenIdle();
    assert.equal(removed, true, "the inbox was removed during the come-back's write-back");
    assert.deepEqual(await t.server.listInboxes(t.person), []);
    assert.deepEqual(t.errors, []);
  });
});
