// Rules, screening as a gate, letting senders in, teaching, triage, drafts and briefs. Without AI credentials the
// server's AI is not set up, so new mail nobody decides is `unknown` and waits in the triage queue; the AI's own steps
// are in ai-sorting.test.ts.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ServiceError } from "@usualmail/core";
import { at, DAY, HOUR, historyFromKnown, KNOWN, listen, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => (t = await makeServer()));
afterEach(async () => t.close());

const code = (error: unknown) => (error instanceof ServiceError ? error.code : String(error));
const TOMAS = { name: "Tomas", email: "tomas@brightfield.example" };

describe("rules", () => {
  test("what a person taught is checked first, newest first, then agents' rules; the first match applies and its hits go up", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const broad = await t.server.createRule(t.person, { inboxId: inbox.id, text: "Anything from shop.example is a receipt", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }, { kind: "done" }] });
    t.clock.advance(1000);
    const narrow = await t.server.createRule(t.person, { inboxId: inbox.id, text: "News from shop.example is a newsletter", match: { from: "news@shop.example" }, then: [{ kind: "categorize", category: "newsletter" }] });
    t.clock.advance(1000);
    const disabled = await t.server.createRule(t.person, { inboxId: inbox.id, text: "Weekly digests are newsletters", match: { subjectContains: "digest" }, then: [{ kind: "categorize", category: "newsletter" }] });
    await t.server.updateRule(t.person, disabled.id, { enabled: false });
    t.clock.advance(1000);
    // The newest rule of all, but an agent's: it comes after everything a person taught.
    const agent = await t.agent([inbox.id]);
    const agents = await t.server.createRule(agent.caller, { inboxId: inbox.id, text: "Shop mail is a conversation", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "conversation" }] });
    await t.server.updateRule(t.person, agents.id, { enabled: true });

    const news = await t.receive(inbox, { from: { email: "news@shop.example" }, subject: "Spring sale", date: at(-3 * HOUR) });
    assert.deepEqual([news.category, news.done, news.categorizedBy, news.reason, news.screened], ["newsletter", false, "rule", narrow.text, false],
      "a rule sorts a stranger's mail first, so it isn't screened");
    const receipt = await t.receive(inbox, { from: { email: "orders@shop.example" }, subject: "Order 1", date: at(-2 * HOUR) });
    assert.deepEqual([receipt.category, receipt.done, receipt.categorizedBy, receipt.reason], ["receipt", true, "rule", broad.text]);

    const digest = await t.receive(inbox, { from: KNOWN, subject: "Your weekly digest", date: at(-HOUR) });
    assert.deepEqual([digest.category, digest.categorizedBy, digest.screened], ["unknown", undefined, false]);

    const rules = await t.server.listRules(t.person, inbox.id);
    assert.deepEqual(rules.map((r) => [r.id, r.hits]), [[broad.id, 1], [narrow.id, 1], [disabled.id, 0], [agents.id, 0]]);
    const handled = await t.server.handled(t.person, { inboxId: inbox.id });
    // Equal times, newest record first.
    assert.deepEqual(handled.items.map((i) => [i.thread.id, i.record.action.kind]), [[receipt.id, "done"], [receipt.id, "categorize"], [news.id, "categorize"]]);
    // A rule's match lets no one in: the shop's next mail that no rule sorts is screened.
    await t.server.deleteRule(t.person, broad.id);
    await t.server.deleteRule(t.person, agents.id);
    const next = await t.receive(inbox, { from: { email: "orders@shop.example" }, subject: "Order 2", date: at(-HOUR / 2) });
    assert.equal(next.screened, true);
  });

  test("an agent's rule starts off; only a person turns it on; an agent changes and deletes only agents' rules", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const agent = await t.agent([inbox.id]);
    const mine = await t.server.createRule(agent.caller, { inboxId: inbox.id, text: "Promotions are newsletters", match: { subjectContains: "sale" }, then: [{ kind: "categorize", category: "newsletter" }] });
    assert.deepEqual([mine.source, mine.enabled], ["agent", false]);
    const off = await t.receive(inbox, { from: KNOWN, subject: "Big sale", date: at(-3 * HOUR) });
    assert.equal(off.category, "unknown");
    await assert.rejects(t.server.updateRule(agent.caller, mine.id, { enabled: true }), (e) => code(e) === "needs_person");
    const on = await t.server.updateRule(t.person, mine.id, { enabled: true });
    assert.equal(on.enabled, true);
    // Changing what an enabled rule does switches it off until a person looks at it again.
    const changed = await t.server.updateRule(agent.caller, mine.id, { then: [{ kind: "categorize", category: "receipt" }] });
    assert.deepEqual([changed.enabled, changed.then], [false, [{ kind: "categorize", category: "receipt" }]]);
    await t.server.updateRule(t.person, mine.id, { enabled: true });
    const renamed = await t.server.updateRule(agent.caller, mine.id, { text: "Sales are receipts" });
    assert.equal(renamed.enabled, true);
    assert.equal((await t.server.updateRule(agent.caller, mine.id, { enabled: false })).enabled, false);

    const persons = await t.server.createRule(t.person, { inboxId: inbox.id, text: "X", match: { domain: "x.example" }, then: [{ kind: "done" }] });
    await assert.rejects(t.server.updateRule(agent.caller, persons.id, { text: "Y" }), (e) => code(e) === "needs_person");
    await assert.rejects(t.server.deleteRule(agent.caller, persons.id), (e) => code(e) === "needs_person");
    await t.server.deleteRule(agent.caller, mine.id);
    assert.deepEqual((await t.server.listRules(t.person, inbox.id)).map((r) => r.id), [persons.id]);
  });

  test("match on list, sender domain and its subdomains, recipient alias and automated mail", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    await t.server.createRule(t.person, { inboxId: inbox.id, text: "The Weekly Build is a newsletter", match: { listId: "weekly-build.weeklybuild.example" }, then: [{ kind: "categorize", category: "newsletter" }] });
    await t.server.createRule(t.person, { inboxId: inbox.id, text: "Billing alias is invoices", match: { to: "billing@acme.example", automated: true }, then: [{ kind: "categorize", category: "invoice" }] });
    await t.server.createRule(t.person, { inboxId: inbox.id, text: "Stripe is receipts", match: { domain: "stripe.example" }, then: [{ kind: "categorize", category: "receipt" }] });
    const list = await t.receive(inbox, { from: { email: "issue@weeklybuild.example" }, subject: "Issue 213", listId: "The Weekly Build <weekly-build.weeklybuild.example>", date: at(-3 * HOUR) });
    const alias = await t.receive(inbox, { from: { email: "bot@vendor.example" }, to: [{ email: "billing@acme.example" }], automated: true, subject: "Invoice", date: at(-2 * HOUR) });
    const sub = await t.receive(inbox, { from: { email: "receipts@mail.stripe.example" }, subject: "Receipt", date: at(-HOUR) });
    assert.deepEqual([list.category, alias.category, sub.category], ["newsletter", "invoice", "receipt"]);
  });

  test("are validated: a match, actions a rule may take, a category someone can decide", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example" });
    await assert.rejects(t.server.createRule(t.person, { inboxId: inbox.id, text: "Empty", match: {}, then: [{ kind: "done" }] }), (e) => code(e) === "invalid");
    await assert.rejects(t.server.createRule(t.person, { inboxId: inbox.id, text: "Later", match: { domain: "x.example" }, then: [{ kind: "come_back", at: at(DAY) }] }), (e) => code(e) === "invalid");
    await assert.rejects(t.server.createRule(t.person, { inboxId: inbox.id, text: "Nobody", match: { domain: "x.example" }, then: [{ kind: "categorize", category: "unknown" as never }] }), (e) => code(e) === "invalid");
    await assert.rejects(t.server.createRule(t.person, { inboxId: inbox.id, text: "Old", match: { domain: "x.example" }, then: [{ kind: "move", pile: "reads" } as never] }), (e) => code(e) === "invalid");
    const agent = await t.agent([inbox.id]);
    await t.server.updateInbox(t.person, inbox.id, { agentAccess: true });
    const byAgent = await t.server.createRule(agent.caller, { inboxId: inbox.id, text: "X", match: { domain: "x.example" }, then: [{ kind: "done" }] }, "person");
    assert.deepEqual([byAgent.source, byAgent.enabled], ["agent", false]);
  });
});

describe("screening", () => {
  test("mail from a sender who isn't let in is screened, whatever its category; allow lets them in, block sends them to done", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const known = await t.receive(inbox, { from: KNOWN, subject: "From Dana", date: at(-5 * HOUR) });
    assert.deepEqual([known.category, known.screened], ["unknown", false]);
    assert.ok((await t.server.home(t.person, {})).items.some((x) => x.id === known.id), "undecided mail shows in Home");

    const first = await t.receive(inbox, { from: TOMAS, subject: "Pricing?", date: at(-4 * HOUR) });
    const second = await t.receive(inbox, { from: { email: TOMAS.email }, subject: "Pricing, again", date: at(-3 * HOUR) });
    assert.deepEqual([first.screened, first.category, first.reason], [true, "unknown", "First mail from this sender"]);
    assert.equal(second.screened, true);
    assert.deepEqual((await t.server.screening(t.person, {})).items.map((x) => x.id), [second.id, first.id]);
    assert.ok(!(await t.server.home(t.person, {})).items.some((x) => x.id === first.id), "screened: in no list but screening and search");
    assert.ok((await t.server.search(t.person, { q: "Pricing" })).items.some((x) => x.id === first.id));

    const allowed = await t.server.act(t.person, { threadIds: [first.id], action: { kind: "allow_sender" } });
    assert.equal(allowed.records.length, 1);
    assert.equal((await t.server.thread(t.person, first.id)).thread.screened, false);
    assert.equal((await t.server.thread(t.person, second.id)).thread.screened, false);
    const later = await t.receive(inbox, { from: { email: TOMAS.email }, subject: "Thanks", date: at(-2 * HOUR) });
    assert.equal(later.screened, false);

    // Undoing the allow puts both threads and the sender back.
    await t.server.undo(t.person, allowed.records[0]!.id);
    assert.equal((await t.server.thread(t.person, second.id)).thread.screened, true);

    const spammer = await t.receive(inbox, { from: { email: "deals@spam.example" }, subject: "Deal", date: at(-HOUR) });
    assert.equal(spammer.screened, true);
    const blocked = await t.server.act(t.person, { threadIds: [spammer.id], action: { kind: "block_sender" } });
    assert.equal(blocked.records[0]!.state, "applied");
    assert.equal((await t.server.thread(t.person, spammer.id)).thread.done, true);
    const again = await t.receive(inbox, { from: { email: "deals@spam.example" }, subject: "Another deal", date: at(-HOUR / 2) });
    assert.equal(again.done, true);
    assert.equal(again.reason, "You blocked this sender");
    assert.ok(!(await t.server.screening(t.person, {})).items.some((x) => x.id === again.id));
  });

  test("deciding a category lets nobody in: a screened thread stays screened, and the sender's next mail is screened too", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const first = await t.receive(inbox, { from: TOMAS, subject: "Our offer", date: at(-2 * HOUR) });
    const result = await t.server.act(t.person, { threadIds: [first.id], action: { kind: "categorize", category: "invoice" } });
    assert.deepEqual([result.threads[0]!.category, result.threads[0]!.screened, result.threads[0]!.categorizedBy], ["invoice", true, "person"]);
    await t.server.whenIdle();
    const placed = mailbox.messages().find((m) => m.subject === "Our offer")!.placement;
    assert.deepEqual([placed.inInbox, placed.screened], [false, true], "still under Screening at the provider");
    const next = await t.receive(inbox, { from: TOMAS, subject: "Following up", date: at(-HOUR) });
    assert.equal(next.screened, true);
  });

  test("someone the inbox has sent mail to is not screened", async () => {
    const { inbox } = await t.connect({
      address: "me@acme.example",
      history: [{ from: { email: "me@acme.example" }, to: [{ email: "lotte@brandt.example" }], subject: "Shoot?", date: at(-10 * DAY), outgoing: true }],
    });
    const reply = await t.receive(inbox, { from: { email: "lotte@brandt.example" }, subject: "New photos", date: at(-HOUR) });
    assert.equal(reply.screened, false);
  });

  test("sending a stranger mail lets them in: their screened threads stop being screened, here and at the provider", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const screened = await t.receive(inbox, { from: TOMAS, subject: "Hello there", date: at(-HOUR) });
    assert.equal(screened.screened, true);
    const draft = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [{ email: TOMAS.email }], subject: "Hi Tomas", body: "Welcome." });
    await t.server.sendDraft(t.person, draft.id);
    await t.server.whenIdle();
    const after = (await t.server.thread(t.person, screened.id)).thread;
    assert.equal(after.screened, false);
    assert.ok((await t.server.home(t.person, {})).items.some((x) => x.id === screened.id), "now in Home");
    const placed = mailbox.messages().find((m) => m.subject === "Hello there")!.placement;
    assert.deepEqual([placed.inInbox, placed.screened], [true, false], "written back: in the provider's inbox, not under Screening");
  });

  test("someone writing in a thread that isn't screened is let in, and their screened threads with them", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const cc = { name: "Priya", email: "priya@lumen.example" };
    const own = await t.receive(inbox, { from: cc, subject: "Priya's own question", date: at(-3 * HOUR) });
    assert.equal(own.screened, true);
    const conversation = await t.receive(inbox, { from: KNOWN, subject: "Project kickoff", messageId: "kickoff@lumen.example", date: at(-2 * HOUR) });
    assert.equal(conversation.screened, false);
    mailbox.deliver({ from: cc, subject: "Re: Project kickoff", inReplyTo: "kickoff@lumen.example", date: at(-HOUR) });
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, conversation.id)).thread.messageCount, 2, "joined the conversation");
    assert.equal((await t.server.thread(t.person, own.id)).thread.screened, false, "let in by writing in a thread that isn't screened");
    const next = await t.receive(inbox, { from: cc, subject: "Another one", date: at(-HOUR / 2) });
    assert.equal(next.screened, false);
  });
});

describe("teaching", () => {
  test("a person undoing an agent's categorize gets one question; yes creates a correction rule", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Update", date: at(-HOUR) });
    const decided = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "conversation" } });
    await t.server.answerTeach(t.person, decided.teach!.id, false);
    const agent = await t.agent([inbox.id]);
    const moved = await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" }, reason: "Looks like news" });
    assert.equal(moved.teach, undefined);
    assert.equal(moved.threads[0]!.reason, "Looks like news");
    const undone = await t.server.undo(t.person, moved.records[0]!.id);
    const after = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([after.category, after.categorizedBy, after.reason], ["conversation", "person", undefined], "the person decided it now");
    const teach = undone.teach!;
    assert.match(teach.question, /Always treat mail from .* as a conversation\?/);
    assert.deepEqual(teach.rule.match, { from: KNOWN.email });
    assert.deepEqual(teach.rule.then, [{ kind: "categorize", category: "conversation" }]);
    assert.equal(teach.fromActionId, moved.records[0]!.id);
    assert.equal(teach.expiresAt, at(DAY).replace(".000Z", "Z"));

    await assert.rejects(t.server.answerTeach(agent.caller, teach.id, true), (e) => code(e) === "needs_person");
    const rule = await t.server.answerTeach(t.person, teach.id, true);
    assert.equal(rule!.source, "correction");
    assert.equal(rule!.inboxId, inbox.id);
    assert.equal(rule!.enabled, true);
    await assert.rejects(t.server.answerTeach(t.person, teach.id, true), (e) => code(e) === "not_found");
  });

  test("undoing a categorize that came from undecided offers nothing: nobody chooses unknown; the thread stays in Home and out of the triage queue", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Unsure", date: at(-HOUR) });
    const agent = await t.agent([inbox.id]);
    const moved = await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "receipt" } });
    const undone = await t.server.undo(t.person, moved.records[0]!.id);
    assert.equal(undone.teach, undefined);
    assert.deepEqual([undone.threads[0]!.category, undone.threads[0]!.categorizedBy], ["unknown", "person"]);
    assert.ok((await t.server.home(t.person, {})).items.some((x) => x.id === thread.id));
    assert.ok(!(await t.server.triageQueue(t.person, {})).some((item) => item.thread.id === thread.id));
  });

  test("a person changing a thread's category is asked; no returns null; prompts expire after a day", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const one = await t.receive(inbox, { from: { email: "news@paper.example" }, subject: "Issue 1", listId: "<paper.example>", date: at(-2 * HOUR) });
    const moved = await t.server.act(t.person, { threadIds: [one.id], action: { kind: "categorize", category: "newsletter" } });
    assert.deepEqual(moved.teach!.rule.match, { listId: "paper.example" });
    assert.match(moved.teach!.question, /as a newsletter\?$/);
    assert.equal(await t.server.answerTeach(t.person, moved.teach!.id, false), null);

    const two = await t.receive(inbox, { from: KNOWN, subject: "Hello", date: at(-HOUR) });
    const second = await t.server.act(t.person, { threadIds: [two.id], action: { kind: "categorize", category: "receipt" } });
    t.clock.advance(DAY + 1000);
    await assert.rejects(t.server.answerTeach(t.person, second.teach!.id, true), (e) => code(e) === "conflict");
  });

  test("a question even when an older rule matches; none when a rule the person taught already says the same", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    await t.server.createRule(t.person, { inboxId: inbox.id, text: "Shop is receipts", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }] });
    const thread = await t.receive(inbox, { from: { email: "a@shop.example" }, subject: "Order", date: at(-2 * HOUR) });
    assert.equal(thread.category, "receipt");
    const corrected = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "conversation" } });
    assert.deepEqual(corrected.teach!.rule.match, { from: "a@shop.example" });
    // The correction is newer than the domain rule, so it wins from now on.
    t.clock.advance(1000);
    await t.server.answerTeach(t.person, corrected.teach!.id, true);
    const next = await t.receive(inbox, { from: { email: "a@shop.example" }, subject: "Order 2", date: at(-HOUR) });
    assert.deepEqual([next.category, next.categorizedBy], ["conversation", "rule"]);

    // An agent files it elsewhere; the person puts it back: their rule already says a conversation, so no question.
    const agent = await t.agent([inbox.id]);
    const moved = await t.server.act(agent.caller, { threadIds: [next.id], action: { kind: "categorize", category: "newsletter" } });
    const back = await t.server.undo(t.person, moved.records[0]!.id);
    assert.equal(back.threads[0]!.category, "conversation");
    assert.equal(back.teach, undefined);
  });

  test("correcting the server's AI is a person's categorize, with a question", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    await t.aiOn();
    t.models.choose = () => "newsletter";
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Our quarterly letter", date: at(-HOUR) });
    assert.deepEqual([thread.category, thread.categorizedBy], ["newsletter", "ai"]);
    const corrected = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "conversation" } });
    assert.deepEqual([corrected.threads[0]!.category, corrected.threads[0]!.categorizedBy], ["conversation", "person"]);
    assert.match(corrected.teach!.question, /as a conversation\?$/);
  });
});

describe("triage", () => {
  test("without the server's AI, the queue holds every undecided thread that isn't screened or done, oldest first, each with its newest message", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const older = await t.receive(inbox, { from: KNOWN, subject: "Older", text: "first", date: at(-3 * HOUR) });
    const newer = await t.receive(inbox, { from: KNOWN, subject: "Newer", text: "second", date: at(-HOUR) });
    const stranger = await t.receive(inbox, { from: TOMAS, subject: "Screened", date: at(-2 * HOUR) });
    assert.equal(stranger.screened, true);
    const done = await t.receive(inbox, { from: KNOWN, subject: "Done already", date: at(-2 * HOUR) });
    await t.server.act(t.person, { threadIds: [done.id], action: { kind: "done" } });
    const agent = await t.agent([inbox.id]);
    assert.equal((await t.server.aiStatus(agent.caller)).state, "not_set_up");
    const queue = await t.server.triageQueue(agent.caller, {});
    assert.deepEqual(queue.map((item) => item.thread.id), [older.id, newer.id]);
    assert.equal(queue[0]!.latest.text, "first");
    assert.equal((await t.server.triageQueue(agent.caller, { limit: 1 })).length, 1);
  });

  test("decide applies under trust, sets categorizedBy agent, need and reason; records nothing when the category doesn't change; a person's decision sets person", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", trust: "act_with_undo", agentAccess: true, history: [historyFromKnown] });
    const a = await t.receive(inbox, { from: KNOWN, subject: "Invoice", date: at(-3 * HOUR) });
    const b = await t.receive(inbox, { from: KNOWN, subject: "Newsletter", date: at(-2 * HOUR) });
    const c = await t.receive(inbox, { from: KNOWN, subject: "Question", date: at(-HOUR) });
    // A conversation already, so the agent's decision changes no category.
    await t.server.act(t.person, { threadIds: [a.id], action: { kind: "categorize", category: "conversation" } });
    const agent = await t.agent([inbox.id]);
    const { records, threads } = await t.server.decide(agent.caller, [
      { threadId: a.id, category: "conversation", need: "pay", reason: "An invoice to pay" },
      { threadId: b.id, category: "newsletter", done: true, reason: "A newsletter" },
    ]);
    assert.deepEqual(records.map((r) => [r.threadId, r.action.kind, r.state]), [
      [b.id, "categorize", "applied"],
      [b.id, "done", "applied"],
    ]);
    assert.deepEqual(threads.map((x) => [x.id, x.categorizedBy, x.category, x.done]), [[a.id, "agent", "conversation", false], [b.id, "agent", "newsletter", true]]);
    const after = (await t.server.thread(t.person, a.id)).thread;
    assert.deepEqual([after.categorizedBy, after.need, after.reason], ["agent", "pay", "An invoice to pay"]);
    const filed = (await t.server.thread(t.person, b.id)).thread;
    assert.deepEqual([filed.category, filed.done, filed.categorizedBy], ["newsletter", true, "agent"]);
    assert.deepEqual((await t.server.triageQueue(agent.caller, {})).map((i) => i.thread.id), [c.id]);

    await t.server.decide(t.person, [{ threadId: c.id, category: "conversation", need: "reply", reason: "Mine" }]);
    assert.equal((await t.server.thread(t.person, c.id)).thread.categorizedBy, "person");
    assert.deepEqual(await t.server.triageQueue(agent.caller, {}), []);
  });

  test("in a suggest inbox the decision is proposed but the thread leaves the queue", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", trust: "suggest", agentAccess: true, history: [historyFromKnown] });
    const a = await t.receive(inbox, { from: KNOWN, subject: "News", date: at(-HOUR) });
    const agent = await t.agent([inbox.id]);
    const [record] = (await t.server.decide(agent.caller, [{ threadId: a.id, category: "newsletter", reason: "News" }])).records;
    assert.equal(record!.state, "proposed");
    const thread = (await t.server.thread(t.person, a.id)).thread;
    assert.deepEqual([thread.category, thread.categorizedBy], ["unknown", "agent"]);
    assert.deepEqual(await t.server.triageQueue(agent.caller, {}), []);
  });
});

describe("drafts", () => {
  test("anyone with access writes them; only a person sends; the reply joins its thread at the next sync", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Renewal", text: "Confirm by Friday?", date: at(-HOUR) });
    const detail = await t.server.thread(t.person, thread.id);
    const agent = await t.agent([inbox.id]);
    const draft = await t.server.saveDraft(agent.caller, {
      inboxId: inbox.id, threadId: thread.id, inReplyToMessageId: detail.messages[0]!.id,
      to: [KNOWN], subject: "Re: Renewal", body: "Confirmed.",
    });
    assert.equal(draft.state, "draft");
    assert.deepEqual(draft.createdBy, agent.caller.actor);
    const edited = await t.server.saveDraft(agent.caller, { id: draft.id, inboxId: inbox.id, threadId: thread.id, inReplyToMessageId: detail.messages[0]!.id, to: [KNOWN], subject: "Re: Renewal", body: "Confirmed, thanks." });
    assert.equal(edited.body, "Confirmed, thanks.");
    assert.deepEqual((await t.server.thread(t.person, thread.id)).drafts.map((d) => d.id), [draft.id]);
    assert.deepEqual((await t.server.listDrafts(agent.caller, {})).items.map((d) => d.id), [draft.id]);

    await assert.rejects(t.server.sendDraft(agent.caller, draft.id), (e) => code(e) === "needs_person");
    mailbox.sendNote = "No copy was saved to Sent";
    const heard = listen(t);
    const sent = await t.server.sendDraft(t.person, draft.id);
    heard.stop();
    assert.equal(sent.state, "sent");
    const original = mailbox.messages().find((m) => m.subject === "Renewal")!;
    assert.equal(mailbox.sent[0]!.inReplyTo, original.messageId);
    assert.deepEqual(mailbox.sent[0]!.references, [original.messageId]);
    assert.equal(mailbox.sent[0]!.threadKey, original.threadKey);
    assert.equal(sent.note, "No copy was saved to Sent", "the provider's note is on the sent draft");
    assert.deepEqual([draft.version, edited.version, sent.version], [1, 2, 4], "saved, changed, sending, sent");
    assert.deepEqual(mailbox.sent[0]!.from, { name: inbox.name, email: inbox.address });
    assert.deepEqual(heard.events.filter((e) => e.type === "draft.changed").map((e) => e.type === "draft.changed" && [e.draft.state, e.draft.note]),
      [["sending", undefined], ["sent", "No copy was saved to Sent"]], "draft.changed carries the note");
    await t.server.whenIdle();
    const after = await t.server.thread(t.person, thread.id);
    assert.equal(after.messages.length, 2);
    assert.equal(after.messages[1]!.outgoing, true);
    // A sent draft with a note stays in its thread for a day, so the note can be shown; it isn't listed.
    assert.deepEqual(after.drafts, [sent]);
    assert.deepEqual((await t.server.listDrafts(t.person, {})).items, []);
    await assert.rejects(t.server.saveDraft(t.person, { id: draft.id, inboxId: inbox.id, to: [KNOWN], subject: "x", body: "y" }), (e) => code(e) === "conflict");
  });

  test("a sent draft with a note goes after a day with draft.removed; one without a note goes at once", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Lunch?", date: at(-HOUR) });
    const reply = (body: string) => t.server.saveDraft(t.person, { inboxId: inbox.id, threadId: thread.id, to: [KNOWN], subject: "Re: Lunch?", body });

    const plain = await reply("Yes.");
    const heard = listen(t);
    const sentPlain = await t.server.sendDraft(t.person, plain.id);
    assert.deepEqual([sentPlain.state, sentPlain.note], ["sent", undefined]);
    assert.deepEqual(heard.events.filter((e) => e.type.startsWith("draft.")).map((e) => e.type === "draft.changed" ? e.draft.state : e.type),
      ["sending", "sent", "draft.removed"], "sent, then removed");
    assert.deepEqual((await t.server.thread(t.person, thread.id)).drafts, []);

    mailbox.sendNote = "No copy was saved to Sent";
    const noted = await t.server.sendDraft(t.person, (await reply("Yes, at one.")).id);
    t.clock.advance(DAY - 1000);
    await t.server.whenIdle();
    assert.deepEqual((await t.server.thread(t.person, thread.id)).drafts.map((d) => [d.id, d.note]), [[noted.id, "No copy was saved to Sent"]]);
    heard.events.length = 0;
    t.clock.advance(1000);
    await t.server.whenIdle();
    assert.deepEqual((await t.server.thread(t.person, thread.id)).drafts, [], "kept for a day, then gone");
    assert.deepEqual(heard.events.filter((e) => e.type === "draft.removed"), [{ type: "draft.removed", draftId: noted.id, inboxId: inbox.id }]);
    heard.stop();
  });

  test("an agent changes or deletes only drafts an agent wrote; a person any; a paused inbox sends nothing", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const agent = await t.agent([inbox.id], "Agent A");
    const other = await t.agent([inbox.id], "Agent B");
    const mine = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [KNOWN], subject: "Mine", body: "A person wrote this." });
    const theirs = await t.server.saveDraft(agent.caller, { inboxId: inbox.id, to: [KNOWN], subject: "Theirs", body: "An agent wrote this." });
    const change = (draft: { id: string; subject: string }, body: string) => ({ id: draft.id, inboxId: inbox.id, to: [KNOWN], subject: draft.subject, body });

    await assert.rejects(t.server.saveDraft(agent.caller, change(mine, "Changed by an agent")), (e) => code(e) === "needs_person");
    await assert.rejects(t.server.deleteDraft(agent.caller, mine.id), (e) => code(e) === "needs_person");
    assert.equal((await t.server.saveDraft(other.caller, change(theirs, "Another agent may change it"))).body, "Another agent may change it");
    const byPerson = await t.server.saveDraft(t.person, change(theirs, "A person may change it"));
    assert.deepEqual(byPerson.createdBy, agent.caller.actor, "who wrote it stays");
    assert.equal((await t.server.saveDraft(agent.caller, change(theirs, "Still an agent's draft"))).body, "Still an agent's draft");
    await t.server.deleteDraft(agent.caller, theirs.id);
    assert.equal((await t.server.saveDraft(t.person, change(mine, "Mine, changed"))).body, "Mine, changed");

    await t.server.updateInbox(t.person, inbox.id, { paused: true });
    await assert.rejects(t.server.sendDraft(t.person, mine.id), (e) => code(e) === "conflict");
    assert.equal((await t.server.listDrafts(t.person, {})).items.find((d) => d.id === mine.id)?.state, "draft", "nothing changed");
    await t.server.deleteDraft(t.person, mine.id);
  });

  test("a refused send leaves the draft failed with the reason; it can be deleted", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example" });
    mailbox.failSend = "Relay access denied";
    const draft = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [KNOWN], subject: "Hi", body: "Hello" });
    const failed = await t.server.sendDraft(t.person, draft.id);
    assert.deepEqual([failed.state, failed.error], ["failed", "Relay access denied"]);
    await t.server.deleteDraft(t.person, draft.id);
    assert.deepEqual((await t.server.listDrafts(t.person, {})).items, []);
  });
});

describe("briefs", () => {
  test("the server fills counts by category from what rules and agents did, and drops sections the caller can't see", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const hidden = (await t.connect({ address: "private@acme.example" })).inbox;
    await t.server.createRule(t.person, { inboxId: inbox.id, text: "Shop receipts", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }, { kind: "done" }] });
    await t.receive(inbox, { from: { email: "a@shop.example" }, subject: "Receipt", date: at(-HOUR) });
    const news = await t.receive(inbox, { from: KNOWN, subject: "News", date: at(-HOUR) });
    const agent = await t.agent([inbox.id, hidden.id]);
    await t.server.act(agent.caller, { threadIds: [news.id], action: { kind: "categorize", category: "newsletter" } });
    await t.server.act(t.person, { threadIds: [news.id], action: { kind: "stack", stack: "set_aside" } });

    const brief = await t.server.writeBrief(agent.caller, {
      from: at(-DAY), to: at(HOUR),
      sections: [
        { inboxId: inbox.id, summary: "A receipt and a newsletter.", highlights: [{ threadId: news.id, line: "Worth a read." }] },
        { inboxId: hidden.id, summary: "Should not appear", highlights: [] },
      ],
    });
    assert.deepEqual(brief.sections.map((s) => s.inboxId), [inbox.id]);
    assert.deepEqual(brief.sections[0]!.counts, { receipt: 1, done: 1, newsletter: 1 });
    assert.deepEqual(brief.writtenBy, agent.caller.actor);

    assert.equal((await t.server.latestBrief(agent.caller))!.id, brief.id);
    const personal = await t.server.writeBrief(t.person, { from: at(-DAY), to: at(HOUR), sections: [{ inboxId: hidden.id, summary: "Quiet", highlights: [] }] });
    assert.equal((await t.server.latestBrief(t.person))!.id, personal.id);
    assert.equal((await t.server.latestBrief(agent.caller))!.id, brief.id);
    await assert.rejects(t.server.brief(agent.caller, personal.id), (e) => code(e) === "not_found");
    await assert.rejects(t.server.writeBrief(agent.caller, { from: at(0), to: at(-1), sections: [] }), (e) => code(e) === "invalid");
  });
});
