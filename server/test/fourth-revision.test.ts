// What the contract's fourth revision brought, as the fifth revision keeps it: rules with versions, makers and events;
// what needs a person in Handled; how an inbox is connected; a paused inbox writing nothing; mail filed outside the
// inbox keeping its filing; spam; what counts as "changed since" for undoing an allow; and a refused write-back that
// leaves a later change alone.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ServiceError, type ActionRecord, type MailEvent } from "@usualmail/core";
import { createApp } from "../src/rest/app.ts";
import { at, DAY, HOUR, historyFromKnown, KNOWN, listen, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => (t = await makeServer()));
afterEach(async () => t.close());

const TOMAS = { name: "Tomas", email: "tomas@brightfield.example" };
const code = (error: unknown) => (error instanceof ServiceError ? error.code : String(error));
const thread = async (id: string) => (await t.server.thread(t.person, id)).thread;
const ruleEvents = (events: MailEvent[]) => events.flatMap((e) => e.type === "rule.changed" ? [[e.rule.id, e.rule.version, e.rule.hits, e.rule.enabled]] : e.type === "rule.removed" ? [[e.ruleId, "removed"]] : []);

describe("rules", () => {
  test("say who made them; every change raises the version and sends rule.changed, a deletion rule.removed", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const agent = await t.agent([inbox.id], "Sorter");
    const heard = listen(t);
    const heardByAgent = listen(t, agent.caller);
    const mine = await t.server.createRule(t.person, { inboxId: inbox.id, text: "Shop receipts", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }] });
    assert.deepEqual([mine.createdBy, mine.version, mine.source], [t.person.actor, 1, "person"]);
    const suggested = await t.server.createRule(agent.caller, { inboxId: inbox.id, text: "News are newsletters", match: { domain: "news.example" }, then: [{ kind: "categorize", category: "newsletter" }] });
    assert.deepEqual([suggested.createdBy, suggested.enabled], [agent.caller.actor, false]);

    const on = await t.server.updateRule(t.person, suggested.id, { enabled: true });
    assert.deepEqual([on.version, on.createdBy], [2, agent.caller.actor], "a person turning it on doesn't change who made it");
    assert.equal((await t.server.updateRule(t.person, suggested.id, { enabled: true })).version, 2, "a change that changes nothing raises nothing");
    const rewritten = await t.server.updateRule(agent.caller, suggested.id, { match: { domain: "paper.example" } });
    assert.deepEqual([rewritten.version, rewritten.enabled], [3, false]);
    await t.server.deleteRule(agent.caller, suggested.id);
    heard.stop();
    heardByAgent.stop();
    assert.deepEqual(ruleEvents(heard.events), [
      [mine.id, 1, 0, true], [suggested.id, 1, 0, false], [suggested.id, 2, 0, true], [suggested.id, 3, 0, false], [suggested.id, "removed"],
    ]);
    assert.deepEqual(ruleEvents(heardByAgent.events), ruleEvents(heard.events), "an agent hears rules of inboxes it sees");
    assert.deepEqual((await t.server.listRules(t.person, inbox.id)).map((r) => r.id), [mine.id]);

    // A rule taught by answering a prompt is the person's.
    const news = await t.receive(inbox, { from: KNOWN, subject: "Lumen news", date: at(-HOUR) });
    const { teach } = await t.server.act(t.person, { threadIds: [news.id], action: { kind: "categorize", category: "newsletter" } });
    const taught = (await t.server.answerTeach(t.person, teach!.id, true))!;
    assert.deepEqual([taught.source, taught.createdBy], ["correction", t.person.actor]);
  });

  test("sorting a batch of new mail raises hits and version, with one rule.changed per rule for the batch", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const rule = await t.server.createRule(t.person, { inboxId: inbox.id, text: "Shop receipts", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }, { kind: "done" }] });
    for (const n of [1, 2, 3]) mailbox.deliver({ from: { email: "billing@shop.example" }, subject: `Receipt ${n}`, date: at(-HOUR + n) });
    const heard = listen(t);
    await t.sync(inbox);
    heard.stop();
    assert.deepEqual(ruleEvents(heard.events), [[rule.id, 4, 3, true]], "one event carrying the batch's hits");
    assert.deepEqual((await t.server.listRules(t.person, inbox.id)).map((r) => [r.hits, r.version]), [[3, 4]]);
  });

  test("an agent hears no rule events for an inbox it can't see", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", agentAccess: true });
    const hidden = (await t.connect({ address: "private@acme.example" })).inbox;
    const agent = await t.agent([inbox.id, hidden.id]);
    const heard = listen(t, agent.caller);
    const rule = await t.server.createRule(t.person, { inboxId: hidden.id, text: "x", match: { domain: "x.example" }, then: [{ kind: "done" }] });
    await t.server.deleteRule(t.person, rule.id);
    heard.stop();
    assert.deepEqual(ruleEvents(heard.events), []);
  });
});

describe("Handled with attentionOnly", () => {
  test("lists only records that failed or carry an error or a note, from every state; REST takes attentionOnly=true", async () => {
    // A mailbox that can't keep stacks adds a note when a thread is stacked.
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown], mailbox: { keepsStacks: false } });
    const agent = await t.agent([inbox.id]);
    const one = await t.receive(inbox, { from: KNOWN, subject: "One", date: at(-3 * HOUR) });
    const two = await t.receive(inbox, { from: KNOWN, subject: "Two", date: at(-2 * HOUR) });
    const three = await t.receive(inbox, { from: KNOWN, subject: "Three", date: at(-HOUR) });
    const clean = (await t.server.act(agent.caller, { threadIds: [one.id], action: { kind: "categorize", category: "newsletter" }, reason: "News" })).records[0]!;
    mailbox.refuse = (op) => (op.op === "place" && op.category === "receipt" ? "Folder is read-only" : undefined);
    const failed = (await t.server.act(agent.caller, { threadIds: [two.id], action: { kind: "categorize", category: "receipt" }, reason: "Receipt" })).records[0]!;
    await t.server.whenIdle();
    mailbox.refuse = null;
    const noted = (await t.server.act(agent.caller, { threadIds: [three.id], action: { kind: "stack", stack: "set_aside" }, reason: "Later" })).records[0]!;
    await t.server.whenIdle();
    const proposal = (await t.server.act(agent.caller, { threadIds: [one.id], action: { kind: "trash" }, reason: "Junk" })).records[0]!;

    const attention = await t.server.handled(t.person, { attentionOnly: true });
    assert.deepEqual(attention.items.map((i) => [i.record.id, i.record.state]), [[noted.id, "applied"], [failed.id, "failed"]]);
    assert.ok(attention.items[0]!.record.note);
    assert.deepEqual((await t.server.handled(t.person, { attentionOnly: true, states: ["failed"] })).items.map((i) => i.record.id), [failed.id]);
    const everything = (await t.server.handled(t.person, {})).items.map((i) => i.record.id);
    assert.ok(everything.includes(clean.id) && everything.includes(proposal.id));

    const app = createApp(t.server, { scheduler: t.clock, log: t.host.log });
    const get = (query: string) => app.request(`/v1/handled?${query}`, { headers: { authorization: `Bearer ${t.personToken}` } });
    const rest = await (await get("attentionOnly=true")).json() as { items: Array<{ record: { id: string } }> };
    assert.deepEqual(rest.items.map((i) => i.record.id), [noted.id, failed.id]);
    const wrong = await get("attentionOnly=yes");
    assert.equal(wrong.status, 400);
  });
});

describe("how an inbox is connected", () => {
  test("is the provider's description without secrets; new credentials replace it and make the inbox connecting", async () => {
    const mailbox = { address: "me@acme.example" };
    const connection = (host: string) => ({
      kind: "imap" as const,
      imap: { host, port: 993, secure: true, user: mailbox.address },
      smtp: { host, port: 465, secure: true, user: mailbox.address },
      saveSent: false,
    });
    const inbox = await t.server.connectInbox(t.person, {
      name: "Acme", color: "#2F6FED", provider: "imap", credentials: { mailbox: mailbox.address, password: "first-secret", connection: connection("old.acme.example") },
    });
    assert.deepEqual(inbox.connection, connection("old.acme.example"));
    await t.sync(inbox);
    assert.equal((await t.server.listInboxes(t.person))[0]!.status, "ok");
    const heard = listen(t);
    const changed = await t.server.updateInbox(t.person, inbox.id, { credentials: { mailbox: mailbox.address, password: "second-secret", connection: connection("new.acme.example") } });
    heard.stop();
    assert.deepEqual([changed.connection, changed.status], [connection("new.acme.example"), "connecting"]);
    assert.deepEqual(heard.events.filter((e) => e.type === "inbox.changed").map((e) => e.type === "inbox.changed" && e.inbox.connection), [connection("new.acme.example")]);
    const listed = JSON.stringify(await t.server.listInboxes(t.person));
    assert.ok(!listed.includes("secret"), "no password in what the server shows");
    await t.sync(inbox);
    assert.equal((await t.server.listInboxes(t.person))[0]!.status, "ok", "connecting until the next good sync");
  });
});

describe("a paused inbox", () => {
  test("writes nothing to the provider; its actions apply here and go out after it is resumed and synced", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const news = await t.receive(inbox, { from: KNOWN, subject: "Lumen news", date: at(-HOUR) });
    const waiting = await t.receive(inbox, { from: KNOWN, subject: "Ask again", date: at(-HOUR) });
    await t.server.act(t.person, { threadIds: [waiting.id], action: { kind: "come_back", at: at(2 * HOUR) } });
    await t.server.whenIdle();
    mailbox.applied.length = 0;

    await t.server.updateInbox(t.person, inbox.id, { paused: true });
    const moved = await t.server.act(t.person, { threadIds: [news.id], action: { kind: "categorize", category: "newsletter" } });
    assert.equal(moved.threads[0]!.category, "newsletter", "it applies here at once");
    t.clock.advance(3 * HOUR);
    await t.server.whenIdle();
    assert.deepEqual(mailbox.applied, [], "nothing was written while paused, not even the come-back time passing");
    const [news0] = mailbox.messages().filter((m) => m.subject === "Lumen news");
    assert.equal(news0!.placement.inInbox, true);
    await assert.rejects(t.server.syncInbox(t.person, inbox.id), (e) => code(e) === "conflict");

    await t.server.updateInbox(t.person, inbox.id, { paused: false });
    await t.server.whenIdle();
    const placed = Object.fromEntries(mailbox.messages().map((m) => [m.subject, [m.placement.inInbox, m.placement.category ?? null]]));
    assert.deepEqual([placed["Lumen news"], placed["Ask again"]], [[false, "newsletter"], [true, null]]);
    assert.equal((await t.server.handled(t.person, { attentionOnly: true })).items.length, 0);
  });

  test("a write-back held while paused that the provider refuses on resume fails its record", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const news = await t.receive(inbox, { from: KNOWN, subject: "Lumen news", date: at(-HOUR) });
    await t.server.updateInbox(t.person, inbox.id, { paused: true });
    const agent = await t.agent([inbox.id]);
    await t.server.updateInbox(t.person, inbox.id, { agentAccess: true });
    const record = (await t.server.act(agent.caller, { threadIds: [news.id], action: { kind: "categorize", category: "newsletter" }, reason: "News" })).records[0]!;
    mailbox.refuse = () => "Folder is read-only";
    await t.server.updateInbox(t.person, inbox.id, { paused: false });
    await t.server.whenIdle();
    const [item] = (await t.server.handled(t.person, { attentionOnly: true })).items;
    assert.deepEqual([item!.record.id, item!.record.state, item!.record.error, item!.thread.category], [record.id, "failed", "Folder is read-only", "unknown"]);
  });

  test("reads nothing: attachments and sending answer conflict", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const withFile = await t.receive(inbox, { from: KNOWN, subject: "File", date: at(-HOUR), attachments: [{ id: "a1", filename: "a.pdf", mimeType: "application/pdf", size: 3, inline: false, data: new Uint8Array([1, 2, 3]) }] });
    const message = (await t.server.thread(t.person, withFile.id)).messages[0]!;
    await t.server.updateInbox(t.person, inbox.id, { paused: true });
    await assert.rejects(t.server.fetchAttachment(t.person, message.id, message.attachments[0]!.id), (e) => code(e) === "conflict");
  });
});

describe("new mail filed outside the inbox", () => {
  test("keeps the person's filing: no rules, no screening, and its sender isn't let in", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    await t.server.createRule(t.person, { inboxId: inbox.id, text: "Everything from shops is done", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }, { kind: "done" }] });
    const heard = listen(t);
    const archived = await t.receive(inbox, { from: TOMAS, subject: "Filed by a filter", date: at(-HOUR), placement: { inInbox: false } });
    const labelled = await t.receive(inbox, { from: { email: "billing@shop.example" }, subject: "Labelled Newsletters", date: at(-HOUR), placement: { inInbox: false, category: "newsletter" } });
    const stacked = await t.receive(inbox, { from: TOMAS, subject: "Labelled Reply Later", date: at(-HOUR), placement: { inInbox: false, stack: "reply_later" } });
    heard.stop();
    // Archived with no label: done, and nobody decided its category.
    assert.deepEqual([archived.category, archived.done, archived.categorizedBy, archived.screened], ["unknown", true, undefined, false]);
    // A filed category's label is that category, decided by the mailbox, and it isn't done by that.
    assert.deepEqual([labelled.category, labelled.done, labelled.categorizedBy], ["newsletter", false, "mailbox"], "the matching rule didn't run");
    assert.deepEqual([stacked.category, stacked.stack, stacked.done, stacked.screened], ["unknown", "reply_later", false, false]);
    assert.deepEqual((await t.server.listRules(t.person, inbox.id))[0]!.hits, 0);
    // Without the AI, the undecided thread that isn't done waits in the triage queue.
    assert.deepEqual((await t.server.triageQueue(t.person, {})).map((item) => item.thread.id), [stacked.id]);
    assert.deepEqual((await t.server.handled(t.person, { includeSilent: true })).items, []);
    assert.equal(heard.events.filter((e) => e.type === "rule.changed").length, 0);
    // Nothing was written back: the filing stands at the provider.
    assert.deepEqual(mailbox.applied, []);
    // Their next mail to the inbox is screened: being filed let nobody in.
    const later = await t.receive(inbox, { from: TOMAS, subject: "To the inbox", date: at(-HOUR / 2) });
    assert.equal(later.screened, true);
  });

  test("a blocked sender's filed mail is done; mail joining a thread goes where the thread is", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const first = await t.receive(inbox, { from: TOMAS, subject: "Deal", date: at(-3 * HOUR) });
    await t.server.act(t.person, { threadIds: [first.id], action: { kind: "block_sender" } });
    const filed = await t.receive(inbox, { from: TOMAS, subject: "Deal, filed", date: at(-2 * HOUR), placement: { inInbox: false, stack: "set_aside" } });
    assert.deepEqual([filed.done, filed.stack], [true, undefined]);

    const ongoing = await t.receive(inbox, { from: KNOWN, subject: "Project", date: at(-2 * HOUR), messageId: "project@lumen.example" });
    assert.deepEqual([ongoing.category, ongoing.done], ["unknown", false]);
    const reply = await t.receive(inbox, { from: KNOWN, subject: "Project", date: at(-HOUR), inReplyTo: "project@lumen.example", placement: { inInbox: false, category: "newsletter" } });
    assert.deepEqual([reply.id, reply.category, reply.done], [ongoing.id, "unknown", false]);
    // Written where its thread belongs: in the inbox, under no label.
    const placed = t.mailboxes.get(inbox.address)!.messages().filter((m) => m.subject === "Project").map((m) => [m.placement.inInbox, m.placement.category ?? null]);
    assert.deepEqual(placed, [[true, null], [true, null]]);
  });
});

describe("spam", () => {
  test("a thread moved to spam there is trashed here and comes back when taken out; new mail to spam is ignored", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const deal = await t.receive(inbox, { from: KNOWN, subject: "Great deal", date: at(-HOUR) });
    const ref = mailbox.messages().find((m) => m.subject === "Great deal")!.ref;
    mailbox.update(ref, { placement: { spam: true } });
    await t.sync(inbox);
    assert.equal((await thread(deal.id)).trashed, true);
    assert.deepEqual((await t.server.home(t.person, {})).items.filter((x) => x.id === deal.id), []);
    mailbox.update(ref, { placement: { spam: false, inInbox: true } });
    await t.sync(inbox);
    assert.deepEqual([(await thread(deal.id)).trashed, (await thread(deal.id)).category], [false, "unknown"]);
    assert.ok((await t.server.home(t.person, {})).items.some((x) => x.id === deal.id), "back in Home");

    mailbox.deliver({ from: TOMAS, subject: "Spam from the start", date: at(-HOUR / 2), placement: { inInbox: false, spam: true } });
    await t.sync(inbox);
    await assert.rejects(t.threadBySubject("Spam from the start"));
  });

  test("new mail delivered to spam and then taken out of it arrives as new mail, where it now sits", async () => {
    // A mailbox that sends placement changes as `changed`, as Gmail does: leaving spam must still come whole.
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown], mailbox: { sendChanges: true } });
    const toInbox = mailbox.deliver({ from: TOMAS, subject: "Not spam after all", date: at(-HOUR), placement: { inInbox: false, spam: true } });
    const toNewsletters = mailbox.deliver({ from: KNOWN, subject: "Lumen digest", date: at(-HOUR), placement: { inInbox: false, spam: true } });
    await t.sync(inbox);
    await assert.rejects(t.threadBySubject("Not spam after all"), "ignored while in spam");
    mailbox.update(toInbox.ref, { placement: { spam: false, inInbox: true } });
    mailbox.update(toNewsletters.ref, { placement: { spam: false, inInbox: false, category: "newsletter" } });
    await t.sync(inbox);
    const screened = await t.threadBySubject("Not spam after all");
    assert.deepEqual([screened.screened, screened.done, screened.trashed], [true, false, false], "sorted as new mail delivered to the inbox");
    const filed = await t.threadBySubject("Lumen digest");
    assert.deepEqual([filed.category, filed.categorizedBy], ["newsletter", "mailbox"], "new mail outside the inbox keeps where it was put");
  });
});

describe("undoing an allow", () => {
  test("puts back a thread only read since, and leaves one whose place changed", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const a = await t.receive(inbox, { from: TOMAS, subject: "Pricing?", date: at(-3 * HOUR) });
    const b = await t.receive(inbox, { from: TOMAS, subject: "Pricing, again", date: at(-2 * HOUR) });
    const c = await t.receive(inbox, { from: TOMAS, subject: "Pricing, third", date: at(-HOUR) });
    const allowed = (await t.server.act(t.person, { threadIds: [a.id], action: { kind: "allow_sender" } })).records[0]!;
    await t.server.act(t.person, { threadIds: [b.id], action: { kind: "read" } });
    await t.server.act(t.person, { threadIds: [c.id], action: { kind: "come_back", at: at(DAY) } });
    await t.server.undo(t.person, allowed.id);
    assert.deepEqual([(await thread(a.id)).screened, (await thread(b.id)).screened, (await thread(c.id)).screened], [true, true, false]);
    assert.equal((await thread(b.id)).unread, false, "reading it isn't undone either");
  });
});

describe("a refused write-back", () => {
  test("doesn't overwrite a later action's change to the same thread; that action's undo goes back to before both", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const news = await t.receive(inbox, { from: KNOWN, subject: "Lumen news", date: at(-HOUR) });
    let refusals = 0;
    mailbox.refuse = (op) => (op.op === "place" && refusals++ === 0 ? "The server is busy" : undefined);
    // Both actions are recorded before the first write-back runs: the second waits for the lock the first holds.
    const [first, second] = await Promise.all([
      t.server.act(t.person, { threadIds: [news.id], action: { kind: "categorize", category: "newsletter" } }),
      t.server.act(t.person, { threadIds: [news.id], action: { kind: "categorize", category: "receipt" } }),
    ]);
    await t.server.whenIdle();
    const [failed, later] = [first.records[0]!, second.records[0]!];
    const records = new Map(personsRecords().map((r) => [r.id, r]));
    assert.deepEqual([records.get(failed.id)?.state, records.get(later.id)?.state], ["failed", "applied"]);
    assert.equal((await thread(news.id)).category, "receipt", "the later categorize stands");
    const atProvider = mailbox.messages().find((m) => m.subject === "Lumen news")!;
    assert.equal(atProvider.placement.category, "receipt");

    const undone = await t.server.undo(t.person, later.id);
    assert.equal(undone.threads[0]!.category, "unknown", "back to where it was before the failed categorize, not to Newsletters");
  });

  test("a refused undo doesn't overwrite a change made after the undo, and the later change's undo goes back to before the undo", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const news = await t.receive(inbox, { from: KNOWN, subject: "Lumen news", date: at(-HOUR) });
    const moved = (await t.server.act(t.person, { threadIds: [news.id], action: { kind: "categorize", category: "newsletter" } })).records[0]!;
    await t.server.whenIdle();
    let refusals = 0;
    mailbox.refuse = (op) => (op.op === "place" && refusals++ === 0 ? "The server is busy" : undefined);
    const [, stacked, receipts] = await Promise.all([
      t.server.undo(t.person, moved.id),
      t.server.act(t.person, { threadIds: [news.id], action: { kind: "stack", stack: "set_aside" } }),
      t.server.act(t.person, { threadIds: [news.id], action: { kind: "categorize", category: "receipt" } }),
    ]);
    await t.server.whenIdle();
    const after = await thread(news.id);
    assert.deepEqual([after.category, after.stack], ["receipt", "set_aside"], "the undo was refused, but the changes after it stay");
    const record = personsRecords().find((r) => r.id === moved.id)!;
    assert.deepEqual([record.state, record.undoable, Boolean(record.error)], ["applied", false, true], "a later categorize took over the category");
    void stacked;
    // The later categorize found the thread where the refused undo had put it; undone, it goes back to Newsletters.
    assert.equal((await t.server.undo(t.person, receipts.records[0]!.id)).threads[0]!.category, "newsletter");
  });

  test("an allow whose undo was refused, undone again, leaves the sender's threads changed after the first undo", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const a = await t.receive(inbox, { from: TOMAS, subject: "First from Tomas", date: at(-3 * HOUR) });
    const b = await t.receive(inbox, { from: TOMAS, subject: "Second from Tomas", date: at(-2 * HOUR) });
    const c = await t.receive(inbox, { from: TOMAS, subject: "Third from Tomas", date: at(-HOUR) });
    const allowed = (await t.server.act(t.person, { threadIds: [a.id], action: { kind: "allow_sender" } })).records[0]!;
    await t.server.whenIdle();
    let refusals = 0;
    mailbox.refuse = (op) => (op.op === "place" && refusals++ === 0 ? "The server is busy" : undefined);
    // Before the undo's write-back runs, the person categorizes one of Tomas's threads and stacks another.
    await Promise.all([
      t.server.undo(t.person, allowed.id),
      t.server.act(t.person, { threadIds: [b.id], action: { kind: "categorize", category: "newsletter" } }),
      t.server.act(t.person, { threadIds: [c.id], action: { kind: "stack", stack: "set_aside" } }),
    ]);
    await t.server.whenIdle();
    const [ia, ib, ic] = [await thread(a.id), await thread(b.id), await thread(c.id)];
    assert.deepEqual([ia.screened, [ib.category, ib.screened], [ic.screened, ic.stack]], [false, ["newsletter", false], [false, "set_aside"]]);
    // Tried again, the undo puts back only the thread nobody changed since.
    await t.server.undo(t.person, allowed.id);
    await t.server.whenIdle();
    const [ra, rb, rc] = [await thread(a.id), await thread(b.id), await thread(c.id)];
    assert.deepEqual([ra.screened, [rb.category, rb.screened], [rc.screened, rc.stack]], [true, ["newsletter", false], [false, "set_aside"]]);
  });
});

// Handled lists only rules', agents' and the AI's records, so a person's own records are read from the events: the
// newest copy of each, as a client keeps them.
let recorded: MailEvent[] = [];
let stopRecording: (() => void) | null = null;
beforeEach(() => {
  recorded = [];
  stopRecording = t.server.subscribe(t.person, (event) => recorded.push(event));
});
afterEach(() => stopRecording?.());

function personsRecords(): ActionRecord[] {
  const newest = new Map<string, ActionRecord>();
  for (const event of recorded) {
    if (event.type !== "action.recorded") continue;
    const held = newest.get(event.record.id);
    if (!held || held.version <= event.record.version) newest.set(event.record.id, event.record);
  }
  return [...newest.values()];
}
