// Silent records (rules', agents' and the server's AI's), undoing allow and block across a sender's threads, and
// what lets a sender in and what doesn't.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ServiceError, type Inbox } from "@usualmail/core";
import { at, DAY, HOUR, historyFromKnown, KNOWN, listen, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => (t = await makeServer()));
afterEach(async () => t.close());

const TOMAS = { name: "Tomas", email: "tomas@brightfield.example" };
const code = (error: unknown) => (error instanceof ServiceError ? error.code : String(error));
const thread = async (id: string) => (await t.server.thread(t.person, id)).thread;

describe("silent records", () => {
  test("what an agent applies alone in an act_silently inbox is silent: undoable, left out of Handled and brief counts", async () => {
    const { inbox } = await t.connect({ address: "quiet@acme.example", trust: "act_silently", agentAccess: true, history: [historyFromKnown] });
    const news = await t.receive(inbox, { from: KNOWN, subject: "Newsletter", date: at(-HOUR) });
    const agent = await t.agent([inbox.id]);
    const moved = (await t.server.act(agent.caller, { threadIds: [news.id], action: { kind: "categorize", category: "newsletter" }, reason: "News" })).records[0]!;
    assert.deepEqual([moved.state, moved.silent, moved.undoable], ["applied", true, true]);
    assert.deepEqual((await t.server.handled(t.person, {})).items, []);
    assert.deepEqual((await t.server.handled(t.person, { includeSilent: true })).items.map((i) => i.record.id), [moved.id]);

    // A person's own action is never silent.
    const own = (await t.server.act(t.person, { threadIds: [news.id], action: { kind: "stack", stack: "set_aside" } })).records[0]!;
    assert.equal(own.silent, false);
    const brief = await t.server.writeBrief(agent.caller, { from: at(-DAY), to: at(HOUR), sections: [{ inboxId: inbox.id, highlights: [] }] });
    assert.deepEqual(brief.sections[0]!.counts, {}, "silent records don't count");

    // Changing the trust changes no earlier record; a silent record can be undone like any other.
    await t.server.updateInbox(t.person, inbox.id, { trust: "act_with_undo" });
    assert.equal((await t.server.handled(t.person, { includeSilent: true })).items[0]!.record.silent, true);
    const undone = await t.server.undo(t.person, moved.id);
    assert.deepEqual([undone.records[0]!.state, undone.threads[0]!.category, undone.threads[0]!.categorizedBy], ["undone", "unknown", "person"]);
  });

  test("the server's AI's categorize is silent in every inbox; undoing it decides the thread, and an agent undoes it only where it could categorize itself", async () => {
    const open = (await t.connect({ address: "open@acme.example", trust: "act_with_undo", agentAccess: true, history: [historyFromKnown] })).inbox;
    const careful = (await t.connect({ address: "careful@acme.example", trust: "suggest", agentAccess: true, history: [historyFromKnown] })).inbox;
    await t.aiOn();
    t.models.choose = () => "newsletter";
    const a = await t.receive(open, { from: KNOWN, subject: "Open news", date: at(-2 * HOUR) });
    const b = await t.receive(careful, { from: KNOWN, subject: "Careful news", date: at(-HOUR) });
    const records = (await t.server.handled(t.person, { includeSilent: true })).items.filter((i) => i.record.actor.kind === "ai");
    assert.deepEqual(records.map((i) => [i.thread.id, i.record.state, i.record.silent]).sort(), [[a.id, "applied", true], [b.id, "applied", true]].sort(),
      "applied and silent, whatever the inbox's trust");
    assert.deepEqual((await t.server.handled(t.person, {})).items, []);
    const brief = await t.server.writeBrief(t.person, { from: at(-DAY), to: at(HOUR), sections: [{ inboxId: open.id, highlights: [] }] });
    assert.deepEqual(brief.sections[0]!.counts, {}, "the AI's records don't count in a brief");

    const agent = await t.agent([open.id, careful.id]);
    const ofA = records.find((i) => i.thread.id === a.id)!.record;
    const ofB = records.find((i) => i.thread.id === b.id)!.record;
    await assert.rejects(t.server.undo(agent.caller, ofB.id), (e) => code(e) === "needs_person");
    const byAgent = await t.server.undo(agent.caller, ofA.id);
    assert.deepEqual([byAgent.threads[0]!.category, byAgent.threads[0]!.categorizedBy], ["unknown", "agent"]);
    const byPerson = await t.server.undo(t.person, ofB.id);
    assert.deepEqual([byPerson.threads[0]!.category, byPerson.threads[0]!.categorizedBy], ["unknown", "person"]);
    // Decided now, so the AI leaves both alone, even when new mail joins.
    const asked = t.models.sent("choose").length;
    const mailbox = t.mailboxes.get(careful.address)!;
    mailbox.deliver({ from: KNOWN, subject: "Re: Careful news", threadKey: mailbox.messages().find((m) => m.subject === "Careful news")!.threadKey, date: at(-HOUR / 2) });
    await t.sync(careful);
    assert.equal(t.models.sent("choose").length, asked);
    assert.equal((await thread(b.id)).category, "unknown");
  });

  test("a proposal is never silent, and neither is the proposal a person approves", async () => {
    const { inbox } = await t.connect({ address: "quiet@acme.example", trust: "act_silently", agentAccess: true, history: [historyFromKnown] });
    const spam = await t.receive(inbox, { from: KNOWN, subject: "Win a prize", date: at(-HOUR) });
    const agent = await t.agent([inbox.id]);
    const proposed = (await t.server.act(agent.caller, { threadIds: [spam.id], action: { kind: "trash" } })).records[0]!;
    assert.deepEqual([proposed.state, proposed.silent], ["proposed", false]);
    const approved = (await t.server.approve(t.person, [proposed.id])).records[0]!;
    assert.deepEqual([approved.state, approved.silent], ["applied", false]);
    assert.deepEqual((await t.server.handled(t.person, {})).items.map((i) => [i.record.id, i.thread.trashed]), [[proposed.id, true]]);
  });

  test("a refusal, a refused undo or a note ends the silence for good, and the record shows in Handled", async () => {
    const { inbox, mailbox } = await t.connect({ address: "quiet@acme.example", trust: "act_silently", agentAccess: true, history: [historyFromKnown], mailbox: { keepsStacks: false } });
    const [a, b, c] = [
      await t.receive(inbox, { from: KNOWN, subject: "Refused", date: at(-3 * HOUR) }),
      await t.receive(inbox, { from: KNOWN, subject: "Noted", date: at(-2 * HOUR) }),
      await t.receive(inbox, { from: KNOWN, subject: "Undo refused", date: at(-HOUR) }),
    ];
    const agent = await t.agent([inbox.id]);

    mailbox.refuse = (op) => (op.op === "place" ? "Folder Usual Mail/Newsletters is missing" : undefined);
    const refused = (await t.server.act(agent.caller, { threadIds: [a.id], action: { kind: "categorize", category: "newsletter" } })).records[0]!;
    await t.server.whenIdle();
    mailbox.refuse = null;

    const noted = (await t.server.act(agent.caller, { threadIds: [b.id], action: { kind: "stack", stack: "reply_later" } })).records[0]!;
    await t.server.whenIdle();

    const quiet = (await t.server.act(agent.caller, { threadIds: [c.id], action: { kind: "done" } })).records[0]!;
    await t.server.whenIdle();
    assert.equal(quiet.silent, true);
    mailbox.refuse = () => "Read-only mailbox";
    await t.server.undo(t.person, quiet.id);
    await t.server.whenIdle();
    mailbox.refuse = null;

    const shown = new Map((await t.server.handled(t.person, { states: ["applied", "failed"] })).items.map((i) => [i.record.id, i.record]));
    assert.deepEqual([shown.get(refused.id)?.state, shown.get(refused.id)?.silent, shown.get(refused.id)?.error], ["failed", false, "Folder Usual Mail/Newsletters is missing"]);
    assert.deepEqual([shown.get(noted.id)?.state, shown.get(noted.id)?.silent, shown.get(noted.id)?.note], ["applied", false, "This mailbox can't keep stacks, so the stack only shows in Usual Mail"]);
    assert.deepEqual([shown.get(quiet.id)?.state, shown.get(quiet.id)?.silent, shown.get(quiet.id)?.error], ["applied", false, "Undo failed at the provider: Read-only mailbox"]);

    // For good: undone cleanly afterwards, it stays not silent.
    const again = await t.server.undo(t.person, quiet.id);
    await t.server.whenIdle();
    assert.deepEqual([again.records[0]!.state, again.records[0]!.silent], ["undone", false]);
  });
});

describe("undoing allow_sender and block_sender", () => {
  async function screened(inbox: Inbox, subjects: string[]) {
    const out = [];
    for (const [index, subject] of subjects.entries()) out.push(await t.receive(inbox, { from: TOMAS, subject, date: at(-(10 - index) * HOUR) }));
    return out;
  }

  test("always puts the sender back, and each thread only if nothing changed it since; a come-back passing doesn't count", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const [a, b, c] = await screened(inbox, ["Pricing?", "Pricing, again", "Pricing, third"]);
    assert.deepEqual([a.screened, b.screened, c.screened], [true, true, true]);
    await t.server.act(t.person, { threadIds: [c.id], action: { kind: "come_back", at: at(2 * HOUR) } });

    const allowed = (await t.server.act(t.person, { threadIds: [a.id], action: { kind: "allow_sender" } })).records[0]!;
    assert.deepEqual([(await thread(a.id)).screened, (await thread(b.id)).screened, (await thread(c.id)).screened], [false, false, false]);
    // A later change to one of the threads: the allow stays undoable, but that thread is no longer its to put back.
    await t.server.act(t.person, { threadIds: [b.id], action: { kind: "categorize", category: "newsletter" } });
    // c's come-back time passes: its version rises, which is no change for undo.
    const waiting = await thread(c.id);
    t.clock.advance(3 * HOUR);
    await t.server.whenIdle();
    assert.equal((await thread(c.id)).version, waiting.version + 1);

    const undone = await t.server.undo(t.person, allowed.id);
    assert.equal(undone.records[0]!.state, "undone");
    const [afterA, afterB, afterC] = [await thread(a.id), await thread(b.id), await thread(c.id)];
    assert.deepEqual([afterA.screened, afterB.screened, afterB.category, afterC.screened], [true, false, "newsletter", true]);
    const later = await t.receive(inbox, { from: TOMAS, subject: "Hello again", date: at(4 * HOUR) });
    assert.equal(later.screened, true, "the sender is unknown again");
  });

  test("stays undoable until a later allow or block of the same sender is applied", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const [a] = await screened(inbox, ["Pricing?"]);
    const other = await t.receive(inbox, { from: { email: "ines@lumen.example" }, subject: "Workshop", date: at(-HOUR) });
    const allowed = (await t.server.act(t.person, { threadIds: [a.id], action: { kind: "allow_sender" } })).records[0]!;
    await t.server.act(t.person, { threadIds: [a.id], action: { kind: "categorize", category: "receipt" } });
    await t.server.act(t.person, { threadIds: [other.id], action: { kind: "allow_sender" } });
    const heard = listen(t);
    await t.server.act(t.person, { threadIds: [a.id], action: { kind: "block_sender" } });
    heard.stop();
    assert.ok(heard.events.some((e) => e.type === "action.recorded" && e.record.id === allowed.id && !e.record.undoable));
    await assert.rejects(t.server.undo(t.person, allowed.id), (e) => code(e) === "conflict");
  });

  test("undoing a block puts the sender back and leaves alone a thread changed since", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const [a, b] = await screened(inbox, ["Deal", "Another deal"]);
    const blocked = (await t.server.act(t.person, { threadIds: [a.id], action: { kind: "block_sender" } })).records[0]!;
    assert.deepEqual([(await thread(a.id)).done, (await thread(b.id)).done], [true, true]);
    await t.server.act(t.person, { threadIds: [b.id], action: { kind: "categorize", category: "newsletter" } });
    await t.server.undo(t.person, blocked.id);
    const [afterA, afterB] = [await thread(a.id), await thread(b.id)];
    assert.deepEqual([afterA.done, afterA.screened, afterB.done, afterB.category], [false, true, true, "newsletter"]);
    const later = await t.receive(inbox, { from: TOMAS, subject: "Not blocked now", date: at(-HOUR / 2) });
    assert.deepEqual([later.screened, later.done], [true, false]);
  });
});

describe("letting senders in", () => {
  test("deciding a category, as an action or a triage decision, lets no one in, also once a proposal is approved", async () => {
    const careful = (await t.connect({ address: "careful@acme.example", trust: "suggest", agentAccess: true, history: [historyFromKnown] })).inbox;
    const a = await t.receive(careful, { from: TOMAS, subject: "Pricing?", date: at(-3 * HOUR) });
    assert.equal(a.screened, true);
    const agent = await t.agent([careful.id]);
    const [proposal] = (await t.server.decide(agent.caller, [{ threadId: a.id, category: "conversation", need: "reply", reason: "A customer question" }])).records;
    assert.equal(proposal!.state, "proposed");
    await t.server.approve(t.person, [proposal!.id]);
    const approved = await thread(a.id);
    assert.deepEqual([approved.category, approved.screened], ["conversation", true], "a category says what mail is, not who may write");
    assert.equal((await t.receive(careful, { from: TOMAS, subject: "Still screened", date: at(-HOUR) })).screened, true);
  });

  test("a rule's match lets no one in, and a blocked sender stays blocked when a person decides their thread's category", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const rule = await t.server.createRule(t.person, { inboxId: inbox.id, text: "Shop mail is a receipt", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }] });
    const receipt = await t.receive(inbox, { from: { email: "a@shop.example" }, subject: "Receipt", date: at(-4 * HOUR) });
    assert.deepEqual([receipt.category, receipt.categorizedBy, receipt.screened], ["receipt", "rule", false]);
    await t.server.updateRule(t.person, rule.id, { enabled: false });
    assert.equal((await t.receive(inbox, { from: { email: "a@shop.example" }, subject: "Hello", date: at(-3 * HOUR) })).screened, true);

    const pest = await t.receive(inbox, { from: { email: "pest@spam.example" }, subject: "Deal", date: at(-2 * HOUR) });
    await t.server.act(t.person, { threadIds: [pest.id], action: { kind: "block_sender" } });
    await t.server.act(t.person, { threadIds: [pest.id], action: { kind: "categorize", category: "conversation" } });
    const again = await t.receive(inbox, { from: { email: "pest@spam.example" }, subject: "Deal 2", date: at(-HOUR) });
    assert.deepEqual([again.done, again.reason], [true, "You blocked this sender"]);
  });

  test("writing into a thread that isn't screened lets the writer in; so does the first sync's history", async () => {
    const { inbox, mailbox } = await t.connect({
      address: "me@acme.example",
      history: [
        { from: KNOWN, subject: "Kickoff", date: at(-5 * DAY), messageId: "kickoff@lumen.example", seen: true },
        { from: { email: "copied@lumen.example" }, subject: "Re: Kickoff", date: at(-4 * DAY), inReplyTo: "kickoff@lumen.example", seen: true },
      ],
    });
    assert.equal((await t.receive(inbox, { from: { email: "copied@lumen.example" }, subject: "Own thread", date: at(-3 * HOUR) })).screened, false);
    const project = await t.receive(inbox, { from: KNOWN, subject: "Project", date: at(-2 * HOUR), messageId: "project@lumen.example" });
    mailbox.deliver({ from: { email: "new@lumen.example" }, cc: [KNOWN], subject: "Re: Project", date: at(-HOUR), inReplyTo: "project@lumen.example" });
    await t.sync(inbox);
    assert.equal((await thread(project.id)).messageCount, 2);
    assert.equal((await t.receive(inbox, { from: { email: "new@lumen.example" }, subject: "Hi", date: at(-HOUR / 2) })).screened, false);
  });
});
