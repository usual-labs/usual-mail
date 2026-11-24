// Every path whose list grows with the mail holds more than 100 items and still answers right, with no statement over
// 100 parameters (test/parameters.ts fails any): pages of 150 to 200 threads, a thread of 120 messages, 150 senders let
// in or blocked at once, 120 rules in one batch of mail, 120 sent drafts going together, 150 threads asked about again,
// a mailbox search answering 155 hits.
// Made-up addresses and memory mailboxes only.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { memoryFactory, type DeliverInput } from "../src/testing/index.ts";
import { and, eq, sql } from "drizzle-orm";
import { actions, attachments, drafts, messages, searchDocs, searchPeople, senders, threads } from "../src/db/index.ts";
import { MailServer } from "../src/index.ts";
import { at, DAY, HOUR, listen, makeServer, type TestServer } from "./helpers.ts";
import { listScans } from "./list-plans.ts";

let t: TestServer;
let restarted: MailServer | undefined;
afterEach(async () => {
  await restarted?.stop();
  restarted = undefined;
  await t?.close();
});

const N = 150;
const SHOP = { name: "Kestrel Roasters", email: "orders@kestrel.example" };
const file = (i: number) => ({ id: `att-${i}`, filename: `invoice-${i}.pdf`, mimeType: "application/pdf", size: 1200, inline: false });
/** Order `i` from the shop, each its own thread with an invoice attached, a minute apart. */
const order = (i: number, extra: Partial<DeliverInput> = {}): DeliverInput => ({
  from: SHOP, subject: `Order ${i}`, text: `Kestrel beans, order number ${i}.`, date: at(-DAY + i * 60_000), attachments: [file(i)], ...extra,
});
const stranger = (i: number) => ({ name: `Stranger ${i}`, email: `s${i}@strangers.example` });
const count = async (table: typeof attachments | typeof messages | typeof drafts, where?: ReturnType<typeof eq>) =>
  (await t.host.db.select({ n: sql<number>`count(*)` }).from(table).where(where).get())!.n;

describe("pages and acts over more than 100 threads", () => {
  test("a search page of 150 with where each matched, a filter alone, the index built in chunks, and the triage queue", async () => {
    t = await makeServer();
    const { inbox } = await t.connect({ address: "me@inbox.example", history: Array.from({ length: N }, (_, i) => order(i)) });
    assert.equal((await t.host.db.select({ n: sql<number>`count(*)` }).from(searchDocs).get())!.n, N, "every thread indexed");

    const all = await t.server.search(t.person, { q: "kestrel", limit: 200 });
    assert.equal(all.items.length, N);
    assert.equal(new Set(all.items.map((hit) => hit.id)).size, N);
    assert.ok(all.items.every((hit) => hit.match?.excerpt?.runs.some((run) => run.match)), "each with its excerpt");
    const first = await t.server.search(t.person, { q: "kestrel", limit: 120 });
    const rest = await t.server.search(t.person, { q: "kestrel", limit: 120, cursor: first.nextCursor! });
    assert.deepEqual([first.items.length, rest.items.length, rest.nextCursor], [120, 30, undefined]);
    assert.deepEqual(new Set([...first.items, ...rest.items].map((hit) => hit.id)), new Set(all.items.map((hit) => hit.id)));
    assert.deepEqual(all.people?.map((p) => p.email), [SHOP.email]);

    const attached = await t.server.search(t.person, { hasAttachment: true, limit: 200 });
    assert.equal(attached.items.length, N);
    assert.equal(attached.items[0]!.subject, `Order ${N - 1}`, "a filter alone lists newest first");
    const byName = await t.server.search(t.person, { q: "invoice 42", limit: 200 });
    assert.ok(byName.items.some((hit) => hit.subject === "Order 42"), "attachment names are indexed for every thread");

    const queue = await t.server.triageQueue(t.person, { limit: 200 });
    assert.equal(queue.length, N, "undecided, with the AI off");
    assert.ok(queue.every((item) => item.latest.threadId === item.thread.id && item.latest.attachments.length === 1));
    assert.equal(queue[0]!.thread.subject, "Order 0", "oldest first");
    assert.equal(inbox.id, queue[0]!.thread.inboxId);
  });

  test("a mailbox search page larger than asked for: its 155 hits checked against what is held in one statement", async () => {
    t = await makeServer();
    // Gmail answers at most the page asked for (20); a provider that answered more still costs one parameter.
    const base = memoryFactory(t.mailboxes, { kind: "gmail", now: () => t.clock.now() });
    t.providers.register("gmail", (credentials, options) => {
      const provider = base(credentials, options);
      const search = provider.search!;
      provider.search = (query, page) => search(query, { ...page, limit: 1_000 });
      return provider;
    });
    const old = Array.from({ length: N }, (_, i) => order(i, { date: at(-90 * DAY + i * 60_000) }));
    const recent = Array.from({ length: 5 }, (_, i) => order(1_000 + i, { subject: `Recent order ${i}` }));
    await t.connect({ address: "me@gmail.example", mailbox: { kind: "gmail" }, history: [...old, ...recent] });
    assert.equal((await t.server.search(t.person, { q: "kestrel" })).items.length, 5, "only the recent ones are held");
    const remote = await t.server.searchRemote(t.person, { q: "kestrel" });
    assert.equal(remote.items.length, N, "every old order, none the server holds");
    assert.ok(remote.items.every((hit) => hit.subject.startsWith("Order ")));
  });

  test("a thread's 40 people are all indexed", async () => {
    t = await makeServer();
    const team = Array.from({ length: 40 }, (_, i) => ({ name: `Member ${i}`, email: `member${i}@team.example` }));
    const { inbox } = await t.connect({ address: "me@inbox.example" });
    const thread = await t.receive(inbox, { from: SHOP, to: team, subject: "Team order", text: "For everyone." });
    const rows = await t.host.db.select().from(searchPeople).where(eq(searchPeople.threadId, thread.id));
    assert.equal(rows.length, 41, "who wrote and the 40 written to");
    assert.deepEqual((await t.server.search(t.person, { to: "member39@team.example" })).items.map((hit) => hit.id), [thread.id]);
  });

  test("acting on 150 threads at once, then blocking their sender: every thread, record and write-back", async () => {
    t = await makeServer();
    const { mailbox } = await t.connect({ address: "me@inbox.example", history: Array.from({ length: N }, (_, i) => order(i)) });
    const ids = (await t.server.search(t.person, { q: "kestrel", limit: 200 })).items.map((hit) => hit.id);
    const stacked = await t.server.act(t.person, { threadIds: ids, action: { kind: "stack", stack: "reply_later" } });
    assert.equal(stacked.threads.length, N);
    assert.ok(stacked.threads.every((thread) => thread.stack === "reply_later"));
    assert.equal(stacked.records.length, N);
    await t.server.whenIdle();
    assert.ok(mailbox.messages().every((m) => m.placement.stack === "reply_later"), "written back");

    const blocked = await t.server.act(t.person, { threadIds: [ids[0]!], action: { kind: "block_sender" } });
    assert.equal(blocked.records[0]!.action.kind, "block_sender");
    await t.server.whenIdle();
    const stackRecords = await t.host.db.select({ undoable: actions.undoable }).from(actions).where(eq(actions.kind, "stack"));
    assert.equal(stackRecords.length, N);
    assert.ok(stackRecords.every((row) => !row.undoable), "the block changed all 150, so no stacking can be undone exactly");
    const rows = await t.host.db.select({ done: threads.done, stack: threads.stack }).from(threads);
    assert.ok(rows.length === N && rows.every((row) => row.done && row.stack === null));
    assert.ok(mailbox.messages().every((m) => !m.placement.inInbox && !m.placement.stack), "the block written back for all 150");
  });
});

describe("a thread of 120 messages", () => {
  test("its attachments, its messages read and unread together, and the inbox removed with them", async () => {
    t = await makeServer();
    const { inbox } = await t.connect({ address: "me@inbox.example" });
    const mailbox = t.mailboxes.get(inbox.address)!;
    for (let i = 0; i < 120; i++) mailbox.deliver(order(i, { subject: "Standing order", threadKey: "standing", seen: false, date: at(i * 60_000) }));
    await t.sync(inbox);
    const thread = await t.threadBySubject("Standing order");
    assert.deepEqual([thread.messageCount, thread.hasAttachments, thread.unread], [120, true, true]);
    const detail = await t.server.thread(t.person, thread.id);
    assert.equal(detail.messages.length, 120);
    assert.ok(detail.messages.every((m, i) => m.attachments.length === 1 && m.attachments[0]!.filename === `invoice-${i}.pdf`));

    const read = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "read" } });
    assert.equal(read.threads[0]!.unread, false);
    assert.equal(await count(messages, and(eq(messages.threadId, thread.id), eq(messages.unread, true))), 0);
    await t.server.undo(t.person, read.records[0]!.id);
    assert.equal(await count(messages, and(eq(messages.threadId, thread.id), eq(messages.unread, true))), 120, "the undo marks all 120 unread again");

    const other = await t.connect({ address: "me@other.example" });
    await t.receive(other.inbox, order(999, { subject: "Elsewhere" }));
    assert.equal(await count(attachments), 121);
    await t.server.removeInbox(t.person, inbox.id);
    assert.equal(await count(attachments), 1, "only the other inbox's attachment is left");
    assert.equal(await count(messages, eq(messages.inboxId, inbox.id)), 0);
  });
});

describe("more than 100 senders at once", () => {
  async function strangersWrote(): Promise<{ inboxId: string; threadIds: string[] }> {
    t = await makeServer();
    const { inbox, mailbox } = await t.connect({ address: "me@inbox.example" });
    for (let i = 0; i < N; i++) mailbox.deliver({ from: stranger(i), subject: `Hello ${i}`, text: "We haven't met." });
    await t.sync(inbox);
    const screened = await t.server.screening(t.person, { limit: 200 });
    assert.equal(screened.items.length, N, "every stranger is screened");
    return { inboxId: inbox.id, threadIds: screened.items.map((thread) => thread.id) };
  }

  test("a draft to 150 people lets them all in, and their screened threads go where they belong", async () => {
    const { inboxId } = await strangersWrote();
    const people = Array.from({ length: N }, (_, i) => ({ email: stranger(i).email }));
    const draft = await t.server.saveDraft(t.person, { inboxId, to: people.slice(0, 100), cc: people.slice(100), subject: "Hello all", body: "Welcome." });
    await t.server.sendDraft(t.person, draft.id);
    await t.server.whenIdle();
    const known = await t.host.db.select({ email: senders.email, mark: senders.mark }).from(senders)
      .where(and(eq(senders.inboxId, inboxId), eq(senders.status, "known")));
    assert.equal(known.length, N);
    assert.equal(new Set(known.map((row) => row.mark)).size, N, "each with a mark of its own");
    assert.deepEqual((await t.server.screening(t.person, { limit: 200 })).items, [], "none is screened now");
    assert.equal((await t.server.home(t.person, { limit: 200 })).items.length, N);
  });

  test("150 blocked senders on one page, each with their mail", async () => {
    const { threadIds } = await strangersWrote();
    await t.server.act(t.person, { threadIds, action: { kind: "block_sender" } });
    const page = await t.server.senders(t.person, { limit: 200 });
    assert.equal(page.items.length, N);
    assert.ok(page.items.every((item) => item.name === `Stranger ${item.address.slice(1, item.address.indexOf("@"))}`), "each named from their mail");
    assert.ok(page.items.every((item) => item.lastMessageAt !== null && item.blockedBy?.kind === "person"));
  });
});

describe("more than 100 rules, drafts and threads asked about", () => {
  test("120 rules sort one batch of mail, each sends its change once, and a brief counts what they handled", async () => {
    t = await makeServer();
    const senders120 = Array.from({ length: 120 }, (_, i) => ({ name: `Shop ${i}`, email: `billing@shop${i}.example` }));
    // Known from the history, so their new mail isn't screened.
    const { inbox } = await t.connect({ address: "me@inbox.example", history: senders120.map((from, i) => ({ from, subject: `Welcome ${i}`, date: at(-2 * DAY) })) });
    for (const [i, from] of senders120.entries()) {
      await t.server.createRule(t.person, { inboxId: inbox.id, text: `Shop ${i} sends receipts`, match: { from: from.email }, then: [{ kind: "categorize", category: "receipt" }] });
    }
    const mailbox = t.mailboxes.get(inbox.address)!;
    for (const [i, from] of senders120.entries()) mailbox.deliver({ from, subject: `Receipt ${i}`, text: "Paid." });
    const heard = listen(t);
    await t.sync(inbox);
    heard.stop();
    const changed = heard.events.flatMap((event) => (event.type === "rule.changed" ? [event.rule] : []));
    assert.equal(changed.length, 120);
    assert.equal(new Set(changed.map((rule) => rule.id)).size, 120, "one event per rule");
    assert.ok((await t.server.listRules(t.person, inbox.id)).every((rule) => rule.hits === 1));
    assert.equal((await t.server.category(t.person, "receipt", { limit: 200 })).items.length, 120);
    const brief = await t.server.writeBrief(t.person, { from: at(-DAY), to: at(DAY), sections: [{ inboxId: inbox.id, highlights: [] }] });
    assert.deepEqual(brief.sections[0]!.counts, { receipt: 120 });
  });

  test("120 sent drafts kept for a day go together", async () => {
    t = await makeServer();
    const { inbox, mailbox } = await t.connect({ address: "me@inbox.example" });
    mailbox.sendNote = "The mailbox kept no copy";
    for (let i = 0; i < 120; i++) {
      const draft = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [{ email: `friend${i}@friends.example` }], subject: `Note ${i}`, body: "Hi." });
      await t.server.sendDraft(t.person, draft.id);
    }
    await t.server.whenIdle();
    assert.equal(await count(drafts, eq(drafts.state, "sent")), 120);
    const heard = listen(t);
    await t.tick(DAY + HOUR);
    heard.stop();
    assert.equal(await count(drafts), 0);
    assert.equal(heard.events.filter((event) => event.type === "draft.removed").length, 120);
  });

  test("150 threads the AI filed are asked about again at a start", async () => {
    t = await makeServer();
    const { inbox } = await t.connect({ address: "me@inbox.example", history: Array.from({ length: N }, (_, i) => order(i)) });
    await t.host.db.update(threads).set({ category: "receipt", categorizedBy: "ai" }).where(eq(threads.inboxId, inbox.id));
    await t.server.stop();
    restarted = await MailServer.create(t.host, { providers: t.providers, models: t.models, askAgain: { id: "made-up: 150 receipts", categories: ["receipt"], ifStubText: [], ifNeverWrittenIn: [] } });
    await restarted.start();
    await restarted.whenIdle();
    assert.ok(t.infos.includes(`The AI is asked again about the category of ${N} threads it filed`));
    const marked = await t.host.db.select({ n: sql<number>`count(*)` }).from(threads).where(and(eq(threads.categoryDue, true), eq(threads.categoryAskAgain, true))).get();
    assert.equal(marked!.n, N);
  });
});

describe("query plans", () => {
  test("every list this file bound as JSON is read through an index, never a scan", async (t) => {
    const { statements, scans } = await listScans();
    if (statements === 0) return t.skip("no list was bound: the tests above didn't run");
    assert.deepEqual(scans, []);
  });
});
