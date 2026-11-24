// Trust, proposals, undo and who may do what.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ServiceError, type Caller, type Inbox, type Thread, type TrustLevel } from "@usualmail/core";
import { at, content, DAY, HOUR, historyFromKnown, KNOWN, listen, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => (t = await makeServer()));
afterEach(async () => t.close());

async function inboxWith(trust: TrustLevel, address = `${trust}@acme.example`) {
  const { inbox, mailbox } = await t.connect({ address, trust, agentAccess: true, history: [historyFromKnown] });
  const thread = await t.receive(inbox, { from: KNOWN, subject: `Question for ${address}`, text: "Can we talk?", date: at(-HOUR) });
  return { inbox, mailbox, thread };
}

function code(error: unknown): string {
  assert.ok(error instanceof ServiceError, `expected a ServiceError, got ${String(error)}`);
  return error.code;
}

async function rejects(work: Promise<unknown>, expected: string) {
  await assert.rejects(work, (error) => code(error) === expected);
}

describe("trust", () => {
  for (const [trust, state] of [["suggest", "proposed"], ["act_with_undo", "applied"], ["act_silently", "applied"]] as const) {
    test(`an agent's categorize in a ${trust} inbox is ${state}`, async () => {
      const { inbox, thread } = await inboxWith(trust);
      const agent = await t.agent([inbox.id]);
      const result = await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" }, reason: "A newsletter" });
      assert.equal(result.records[0]!.state, state);
      assert.equal(result.records[0]!.undoable, state === "applied");
      assert.equal(result.records[0]!.silent, trust === "act_silently");
      const after = (await t.server.thread(t.person, thread.id)).thread;
      assert.equal(after.category, state === "applied" ? "newsletter" : "unknown");
      assert.equal(after.categorizedBy, "agent", "a proposal still says who decided");
      assert.equal(after.reason, "A newsletter");
    });

    test(`an agent's rule in a ${trust} inbox is ${state}`, async () => {
      const { inbox } = await inboxWith(trust);
      const agent = await t.agent([inbox.id]);
      const made = await t.server.createRule(agent.caller, { inboxId: inbox.id, text: "Receipts from shop.example are receipts", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }] });
      await t.server.updateRule(t.person, made.id, { enabled: true });
      const thread = await t.receive(inbox, { from: { email: "billing@shop.example" }, subject: "Your receipt", date: at(-HOUR) });
      assert.equal(thread.category, state === "applied" ? "receipt" : "unknown");
      assert.equal(thread.categorizedBy, "rule");
      const handled = await t.server.handled(t.person, { inboxId: inbox.id, includeSilent: true });
      assert.equal(handled.items[0]!.record.state, state);
      assert.deepEqual(handled.items[0]!.record.actor.kind, "rule");
      assert.equal(handled.items[0]!.record.silent, trust === "act_silently");
    });

    test(`a rule the person taught applies in a ${trust} inbox, whatever the trust`, async () => {
      const { inbox } = await inboxWith(trust);
      await t.server.createRule(t.person, { inboxId: inbox.id, text: "Receipts from shop.example are receipts", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }, { kind: "done" }] });
      const thread = await t.receive(inbox, { from: { email: "billing@shop.example" }, subject: "Your receipt", date: at(-HOUR) });
      assert.deepEqual([thread.category, thread.categorizedBy, thread.done], ["receipt", "rule", true]);
      const records = (await t.server.handled(t.person, { inboxId: inbox.id, includeSilent: true })).items.map((item) => item.record);
      assert.deepEqual(records.map((record) => [record.action.kind, record.state, record.undoable]), [["done", "applied", true], ["categorize", "applied", true]]);
      assert.ok(records.every((record) => record.silent === (trust === "act_silently")), "silent only where the trust is act_silently");
      const proposals = await t.server.handled(t.person, { inboxId: inbox.id, states: ["proposed"] });
      assert.deepEqual(proposals.items, [], "the person's own rules fill Handled with no proposals");
    });
  }

  test("a correction the person accepted applies at once in a suggest inbox", async () => {
    const { inbox } = await inboxWith("suggest");
    const first = await t.receive(inbox, { from: { name: "Weekly", email: "issue@weekly.example" }, subject: "Issue 1", date: at(-2 * HOUR) });
    const corrected = await t.server.act(t.person, { threadIds: [first.id], action: { kind: "categorize", category: "newsletter" } });
    const rule = await t.server.answerTeach(t.person, corrected.teach!.id, true);
    assert.equal(rule!.source, "correction");
    const next = await t.receive(inbox, { from: { name: "Weekly", email: "issue@weekly.example" }, subject: "Issue 2", date: at(-HOUR) });
    assert.deepEqual([next.category, next.categorizedBy, next.categorizedByActor], ["newsletter", "rule", { kind: "rule", ruleId: rule!.id }]);
    assert.ok(!(await t.server.home(t.person, {})).items.some((item) => item.id === next.id), "out of Home, and so out of the provider's inbox");
  });

  test("a person's own action is always applied, even in a suggest inbox", async () => {
    const { thread } = await inboxWith("suggest");
    const result = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "trash" } });
    assert.equal(result.records[0]!.state, "applied");
  });

  test("trash and block_sender are always proposed for agents and agents' rules, whatever the trust", async () => {
    const { inbox, thread } = await inboxWith("act_silently");
    const agent = await t.agent([inbox.id]);
    for (const kind of ["trash", "block_sender"] as const) {
      const result = await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind } });
      assert.equal(result.records[0]!.state, "proposed", kind);
    }
    const made = await t.server.createRule(agent.caller, { inboxId: inbox.id, text: "Spam goes", match: { domain: "spam.example" }, then: [{ kind: "trash" }] });
    await t.server.updateRule(t.person, made.id, { enabled: true });
    const spam = await t.receive(inbox, { from: { email: "x@spam.example" }, subject: "Win", date: at(-HOUR) });
    const handled = await t.server.handled(t.person, { inboxId: inbox.id, states: ["proposed"] });
    assert.ok(handled.items.some((item) => item.thread.id === spam.id && item.record.action.kind === "trash"));
    assert.equal((await t.server.thread(t.person, spam.id)).thread.trashed, false);
  });

  test("a rule the person taught trashes and blocks itself, as the person's own instruction, and a person can undo it", async () => {
    const { inbox } = await inboxWith("suggest");
    await t.server.createRule(t.person, { inboxId: inbox.id, text: "Spam goes", match: { domain: "spam.example" }, then: [{ kind: "trash" }] });
    await t.server.createRule(t.person, { inboxId: inbox.id, text: "Never from the pest", match: { from: "pest@pest.example" }, then: [{ kind: "block_sender" }] });
    const mailbox = t.mailboxes.get(inbox.address)!;
    mailbox.deliver({ from: { email: "x@spam.example" }, subject: "Win", date: at(-2 * HOUR) });
    mailbox.deliver({ from: { email: "pest@pest.example" }, subject: "Buy", date: at(-HOUR) });
    await t.sync(inbox);
    const items = (await t.server.handled(t.person, { inboxId: inbox.id })).items;
    assert.deepEqual(items.map((item) => [item.record.action.kind, item.record.state]).sort(), [["block_sender", "applied"], ["trash", "applied"]]);
    assert.equal(items.find((item) => item.thread.subject === "Win")!.thread.trashed, true);
    assert.equal(items.find((item) => item.thread.subject === "Buy")!.thread.done, true);
    const records = items.map((item) => item.record);
    const trash = records.find((record) => record.action.kind === "trash")!;
    const agent = await t.agent([inbox.id]);
    await rejects(t.server.undo(agent.caller, trash.id), "needs_person");
    assert.equal((await t.server.undo(t.person, trash.id)).threads[0]!.trashed, false);
  });
});

describe("proposals", () => {
  test("approve applies a proposal at that moment; reject turns one down", async () => {
    const { inbox, thread } = await inboxWith("suggest");
    const agent = await t.agent([inbox.id]);
    const proposed = (await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } })).records[0]!;
    t.clock.advance(HOUR);
    const approval = await t.server.approve(t.person, [proposed.id]);
    const [approved] = approval.records;
    assert.deepEqual(approval.threads.map((x) => [x.id, x.category]), [[thread.id, "newsletter"]]);
    assert.equal(approved!.id, proposed.id);
    assert.equal(approved!.state, "applied");
    assert.equal(approved!.undoable, true);
    assert.equal(approved!.at, new Date(t.clock.now()).toISOString().replace(".000Z", "Z"));
    assert.equal((await t.server.thread(t.person, thread.id)).thread.category, "newsletter");

    const second = (await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "done" } })).records[0]!;
    const [rejected] = (await t.server.reject(t.person, [second.id])).records;
    assert.equal(rejected!.state, "rejected");
    assert.equal((await t.server.thread(t.person, thread.id)).thread.done, false);
    await rejects(t.server.approve(t.person, [second.id]), "conflict");
  });

  test("the same proposal twice returns the open one", async () => {
    const { inbox, thread } = await inboxWith("suggest");
    const agent = await t.agent([inbox.id]);
    const one = (await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } })).records[0]!;
    const two = (await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } })).records[0]!;
    assert.equal(two.id, one.id);
  });

  test("approving a proposal for a thread that changed since fails with conflict", async () => {
    const { inbox, thread } = await inboxWith("suggest");
    const agent = await t.agent([inbox.id]);
    const proposed = (await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } })).records[0]!;
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "receipt" } });
    await rejects(t.server.approve(t.person, [proposed.id]), "conflict");
    const after = await t.server.handled(t.person, { inboxId: inbox.id, states: ["proposed"] });
    assert.equal(after.items[0]!.record.id, proposed.id);
    assert.equal((await t.server.thread(t.person, thread.id)).thread.category, "receipt");
  });
});

describe("undo", () => {
  test("puts category, screened, done, stack, come-back, unread and trashed back exactly, without a second record", async () => {
    const { inbox } = await inboxWith("act_with_undo");
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Two parts", text: "One", date: at(-2 * HOUR), seen: false });
    const mailbox = t.mailboxes.get(inbox.address)!;
    mailbox.deliver({ from: KNOWN, subject: "Re: Two parts", text: "Two", date: at(-HOUR), threadKey: mailbox.messages().find((m) => m.subject === "Two parts")!.threadKey, seen: false });
    await t.sync(inbox);
    // Decided by the person already, so undoing a categorize (which says the undoer decided) leaves it as it was.
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "conversation" } });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "stack", stack: "set_aside" } });

    const actions = [
      { kind: "categorize", category: "newsletter" },
      { kind: "categorize", category: "otp" },
      { kind: "done" },
      { kind: "stack", stack: "reply_later" },
      { kind: "unstack" },
      { kind: "come_back", at: at(3 * DAY), ifNoReply: true },
      { kind: "read" },
      { kind: "trash" },
    ] as const;
    for (const action of actions) {
      const before = await t.server.thread(t.person, thread.id);
      const result = await t.server.act(t.person, { threadIds: [thread.id], action });
      await t.server.whenIdle();
      assert.equal(result.records[0]!.state, "applied", action.kind);
      const undone = await t.server.undo(t.person, result.records[0]!.id);
      await t.server.whenIdle();
      assert.equal(undone.records[0]!.id, result.records[0]!.id);
      assert.equal(undone.records[0]!.state, "undone");
      assert.equal(undone.records[0]!.undoable, false);
      const after = await t.server.thread(t.person, thread.id);
      assert.deepEqual(content(after.thread), content(before.thread), action.kind);
      assert.deepEqual(undone.threads, [after.thread], action.kind);
      assert.equal(after.thread.version, before.thread.version + 2, `${action.kind}: one version for the action, one for the undo`);
      assert.equal(undone.records[0]!.version, 2, action.kind);
      assert.deepEqual(after.messages.map((m) => m.unread), before.messages.map((m) => m.unread), action.kind);
    }

    // Marking unread marks the newest message; undo reads it again.
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "read" } });
    const before = await t.server.thread(t.person, thread.id);
    const unread = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "unread" } });
    assert.deepEqual((await t.server.thread(t.person, thread.id)).messages.map((m) => m.unread), [false, true]);
    await t.server.undo(t.person, unread.records[0]!.id);
    assert.deepEqual(content((await t.server.thread(t.person, thread.id)).thread), content(before.thread));
  });

  test("a later action on the same part makes an earlier one not undoable", async () => {
    const { thread } = await inboxWith("act_with_undo");
    const first = (await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } })).records[0]!;
    const done = (await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } })).records[0]!;
    // A done doesn't touch the category, so it can still be undone after the category changes again.
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "receipt" } });
    await rejects(t.server.undo(t.person, first.id), "conflict");
    const undone = await t.server.undo(t.person, done.id);
    assert.equal(undone.records[0]!.state, "undone");
    await rejects(t.server.undo(t.person, done.id), "conflict");
  });

  test("an agent may undo only what it could have done", async () => {
    const open = await inboxWith("act_with_undo");
    const careful = await inboxWith("suggest");
    const agent = await t.agent([open.inbox.id, careful.inbox.id]);
    const own = (await t.server.act(agent.caller, { threadIds: [open.thread.id], action: { kind: "categorize", category: "newsletter" } })).records[0]!;
    const undone = await t.server.undo(agent.caller, own.id);
    assert.equal(undone.records[0]!.state, "undone");
    assert.deepEqual([undone.threads[0]!.category, undone.threads[0]!.categorizedBy], ["unknown", "agent"], "the agent that undid it decided it");
    const persons = (await t.server.act(t.person, { threadIds: [careful.thread.id], action: { kind: "categorize", category: "newsletter" } })).records[0]!;
    await rejects(t.server.undo(agent.caller, persons.id), "needs_person");
    const trashed = (await t.server.act(t.person, { threadIds: [open.thread.id], action: { kind: "trash" } })).records[0]!;
    await rejects(t.server.undo(agent.caller, trashed.id), "needs_person");
  });
});

describe("what each action does", () => {
  test("done takes a thread off its stack and clears its come-back time; undo puts both back", async () => {
    const { thread } = await inboxWith("act_with_undo");
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "stack", stack: "reply_later" } });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "come_back", at: at(DAY) } });
    const done = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } });
    const [after] = done.threads;
    assert.deepEqual([after!.done, after!.stack, after!.comeBackAt], [true, undefined, undefined]);
    const undone = (await t.server.undo(t.person, done.records[0]!.id)).threads[0]!;
    assert.deepEqual([undone.done, undone.stack, undone.comeBackAt], [false, "reply_later", at(DAY).replace(".000Z", "Z")]);
  });

  test("stack and come_back clear done; not_done reverses only done; categorize changes only the category", async () => {
    const { thread } = await inboxWith("act_with_undo");
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } });
    const stacked = (await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "stack", stack: "set_aside" } })).threads[0]!;
    assert.deepEqual([stacked.done, stacked.stack], [false, "set_aside"]);
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } });
    const waiting = (await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "come_back", at: at(DAY) } })).threads[0]!;
    assert.deepEqual([waiting.done, waiting.comeBackAt], [false, at(DAY).replace(".000Z", "Z")]);
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "stack", stack: "reply_later" } });
    const moved = (await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } })).threads[0]!;
    assert.deepEqual([moved.category, moved.stack, moved.done, moved.comeBackAt], ["newsletter", "reply_later", false, at(DAY).replace(".000Z", "Z")]);
    // A waiting thread is out of sight until it comes back (the owner's decision of 2026-11-20): not in its category's
    // list, stacked or not, nor in Home; it stays on its stack and in the waiting list.
    assert.deepEqual((await t.server.category(t.person, "newsletter", {})).items.map((x) => x.id), []);
    assert.deepEqual((await t.server.stack(t.person, "reply_later", {})).items.map((x) => x.id), [thread.id]);
    assert.deepEqual((await t.server.waiting(t.person, {})).items.map((x) => x.id), [thread.id]);
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "cancel_come_back" } });
    assert.deepEqual((await t.server.category(t.person, "newsletter", {})).items.map((x) => x.id), [thread.id], "a stacked thread is in its category's list");
    assert.ok(!(await t.server.home(t.person, {})).items.some((x) => x.id === thread.id));
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } });
    const notDone = (await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "not_done" } })).threads[0]!;
    assert.deepEqual([notDone.done, notDone.stack, notDone.comeBackAt, notDone.category], [false, undefined, undefined, "newsletter"]);
  });

  test("trash sets trashed and sends thread.changed; the thread leaves every list, other actions conflict, undo brings it back", async () => {
    const { inbox, thread } = await inboxWith("act_with_undo");
    const other = await t.receive(inbox, { from: KNOWN, subject: "Another", date: at(-2 * HOUR) });
    const agent = await t.agent([inbox.id]);
    await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "stack", stack: "set_aside" } });
    assert.equal((await t.server.handled(t.person, {})).items.length, 1);
    const heard = listen(t);
    const trashed = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "trash" } });
    heard.stop();
    assert.equal(trashed.threads[0]!.trashed, true);
    assert.deepEqual(heard.events.filter((e) => e.type.startsWith("thread.")).map((e) => e.type), ["thread.changed"]);
    assert.ok(!(await t.server.home(t.person, {})).items.some((x) => x.id === thread.id));
    assert.deepEqual((await t.server.search(t.person, { q: "Question" })).items, []);
    // Every list of threads leaves out trashed threads; Handled keeps the records, each with its trashed thread.
    const handled = (await t.server.handled(t.person, {})).items;
    assert.deepEqual(handled.map((item) => [item.thread.id, item.thread.trashed]), [[thread.id, true]]);
    assert.equal((await t.server.thread(t.person, thread.id)).thread.trashed, true);
    await rejects(t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } }), "conflict");
    // Every named thread is checked first, so the other thread isn't changed either.
    await rejects(t.server.act(t.person, { threadIds: [other.id, thread.id], action: { kind: "done" } }), "conflict");
    assert.equal((await t.server.thread(t.person, other.id)).thread.done, false);
    // Trashing it again changes nothing, so there is no record.
    assert.deepEqual((await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "trash" } })).records, []);
    const back = await t.server.undo(t.person, trashed.records[0]!.id);
    assert.equal(back.threads[0]!.trashed, false);
    assert.deepEqual((await t.server.stack(t.person, "set_aside", {})).items.map((x) => x.id), [thread.id]);
    assert.equal((await t.server.handled(t.person, {})).items.length, 1);
  });
});

describe("no-op actions", () => {
  test("a thread the action wouldn't change gets no record, but is still returned as it is", async () => {
    const { inbox, thread } = await inboxWith("act_with_undo");
    const other = await t.receive(inbox, { from: KNOWN, subject: "Already done", date: at(-2 * HOUR) });
    await t.server.act(t.person, { threadIds: [other.id], action: { kind: "done" } });
    const before = (await t.server.thread(t.person, other.id)).thread;
    const result = await t.server.act(t.person, { threadIds: [thread.id, other.id], action: { kind: "done" } });
    assert.deepEqual(result.records.map((r) => r.threadId), [thread.id]);
    assert.deepEqual(result.threads.map((x) => x.id), [thread.id, other.id]);
    assert.deepEqual(result.threads[1], before);
    const decided = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "conversation" } });
    const none = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "conversation" } });
    assert.deepEqual(none.records, []);
    assert.equal(none.teach, undefined);
    assert.equal(none.threads[0]!.version, decided.threads[0]!.version);
  });
});

describe("versions and events", () => {
  test("every change raises the version by one and sends an event; a record's changes do too", async () => {
    const { thread } = await inboxWith("act_with_undo");
    const heard = listen(t);
    const moved = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } });
    const stacked = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "stack", stack: "set_aside" } });
    const moveBack = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "conversation" } });
    heard.stop();
    const versions = heard.events.flatMap((e) => (e.type === "thread.changed" ? [e.thread.version] : []));
    assert.deepEqual(versions, [thread.version + 1, thread.version + 2, thread.version + 3]);
    assert.equal(moveBack.threads[0]!.version, thread.version + 3);
    // The second categorize retired the first one's undo: that record changed, so it got a new version and an event.
    const records = heard.events.flatMap((e) => (e.type === "action.recorded" ? [[e.record.id, e.record.version, e.record.undoable]] : []));
    assert.deepEqual(records, [
      [moved.records[0]!.id, 1, true],
      [stacked.records[0]!.id, 1, true],
      [moveBack.records[0]!.id, 1, true],
      [moved.records[0]!.id, 2, false],
    ]);
  });
});

describe("approving several", () => {
  test("two proposals that change the same part of one thread can't be approved together", async () => {
    const { inbox, thread } = await inboxWith("suggest");
    const agent = await t.agent([inbox.id]);
    const news = (await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } })).records[0]!;
    const receipt = (await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "receipt" } })).records[0]!;
    const done = (await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "done" } })).records[0]!;
    await rejects(t.server.approve(t.person, [news.id, receipt.id]), "conflict");
    assert.equal((await t.server.thread(t.person, thread.id)).thread.category, "unknown");
    const both = await t.server.approve(t.person, [news.id, done.id]);
    assert.deepEqual(both.records.map((r) => [r.id, r.state, r.version]), [[news.id, "applied", 2], [done.id, "applied", 2]]);
    assert.deepEqual(both.threads.map((x) => [x.id, x.category, x.done]), [[thread.id, "newsletter", true]]);
  });
});

describe("who may see and do what", () => {
  let shared: Inbox;
  let closed: Inbox;
  let unlisted: Inbox;
  let agent: Caller;
  let hidden: Thread;

  beforeEach(async () => {
    shared = (await inboxWith("act_with_undo", "shared@acme.example")).inbox;
    const closedInbox = await t.connect({ address: "closed@acme.example", history: [historyFromKnown] });
    closed = closedInbox.inbox;
    hidden = await t.receive(closed, { from: KNOWN, subject: "Private", date: at(-HOUR) });
    unlisted = (await inboxWith("act_with_undo", "unlisted@acme.example")).inbox;
    agent = (await t.agent([shared.id, closed.id])).caller;
  });

  test("an agent sees an inbox only when its token lists it and agentAccess is on", async () => {
    assert.deepEqual((await t.server.listInboxes(agent)).map((i) => i.id), [shared.id]);
    await rejects(t.server.thread(agent, hidden.id), "not_found");
    await rejects(t.server.act(agent, { threadIds: [hidden.id], action: { kind: "done" } }), "not_found");
    await rejects(t.server.listRules(agent, closed.id), "not_found");
    await rejects(t.server.listRules(agent, unlisted.id), "not_found");
    await rejects(t.server.home(agent, { inboxId: unlisted.id }), "not_found");
    const home = await t.server.home(agent, {});
    assert.ok(home.items.every((thread) => thread.inboxId === shared.id));
    const counts = await t.server.counts(agent);
    assert.deepEqual(counts.inboxes.map((c) => c.inboxId), [shared.id]);
    const search = await t.server.search(agent, { q: "Private" });
    assert.equal(search.items.length, 0);
    await t.server.updateInbox(t.person, closed.id, { agentAccess: true });
    assert.equal((await t.server.thread(agent, hidden.id)).thread.id, hidden.id);
  });

  test("events reach an agent only for inboxes it may see", async () => {
    const heard: string[] = [];
    const stop = t.server.subscribe(agent, (event) => heard.push(event.type === "thread.changed" ? event.thread.inboxId : event.type));
    await t.server.act(t.person, { threadIds: [hidden.id], action: { kind: "done" } });
    const visible = await t.threadBySubject("Question for shared@acme.example");
    await t.server.act(t.person, { threadIds: [visible.id], action: { kind: "stack", stack: "set_aside" } });
    stop();
    assert.ok(heard.includes(shared.id));
    assert.ok(!heard.includes(closed.id));
  });

  test("every person-only method answers needs_person to an agent", async () => {
    const proposal = (await t.server.act(agent, { threadIds: [(await t.threadBySubject("Question for shared@acme.example")).id], action: { kind: "trash" } })).records[0]!;
    const draft = await t.server.saveDraft(agent, { inboxId: shared.id, to: [KNOWN], subject: "Hi", body: "Hello" });
    const device = (await t.server.listDevices(t.person))[0]!;
    const attempts: Array<[string, Promise<unknown>]> = [
      ["connectInbox", t.server.connectInbox(agent, { name: "X", color: "#000000", provider: "imap", credentials: { mailbox: "x@acme.example" } })],
      ["removeInbox", t.server.removeInbox(agent, shared.id)],
      ["updateInbox trust", t.server.updateInbox(agent, shared.id, { trust: "act_silently" })],
      ["updateInbox agentAccess", t.server.updateInbox(agent, shared.id, { agentAccess: false })],
      ["updateInbox name", t.server.updateInbox(agent, shared.id, { name: "Renamed" })],
      ["updateInbox icon", t.server.updateInbox(agent, shared.id, { icon: "house" })],
      ["updateInbox position", t.server.updateInbox(agent, shared.id, { position: 2 })],
      ["aiSettings", t.server.aiSettings(agent)],
      ["updateAiSettings", t.server.updateAiSettings(agent, { paused: true })],
      ["testAi", t.server.testAi(agent)],
      ["approve", t.server.approve(agent, [proposal.id])],
      ["reject", t.server.reject(agent, [proposal.id])],
      ["answerTeach", t.server.answerTeach(agent, "tch_x", true)],
      ["sendDraft", t.server.sendDraft(agent, draft.id)],
      ["listDevices", t.server.listDevices(agent)],
      ["createPairingCode", t.server.createPairingCode(agent, { kind: "person" })],
      ["revokeDevice", t.server.revokeDevice(agent, device.id)],
    ];
    for (const [name, attempt] of attempts) {
      await assert.rejects(attempt, (error) => code(error) === "needs_person", name);
    }
    const guided = await t.server.updateInbox(agent, shared.id, { guide: "Clients first." });
    assert.equal(guided.guide, "Clients first.");
  });

  test("an agent may revoke its own token, and only its own", async () => {
    const other = await t.agent([shared.id], "Other Agent");
    assert.equal(agent.actor.kind, "agent");
    const self = agent.actor.kind === "agent" ? agent.actor.agentId : "";
    await rejects(t.server.revokeDevice(other.caller, self), "needs_person");
    const token = await t.agent([shared.id], "Leaving Agent");
    const leaving = token.caller.actor.kind === "agent" ? token.caller.actor.agentId : "";
    await t.server.revokeDevice(token.caller, leaving);
    assert.equal(await t.server.authenticate(token.token), null);
    assert.ok(!(await t.server.listDevices(t.person)).some((d) => d.id === leaving));
  });
});
