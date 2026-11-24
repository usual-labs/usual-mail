// Lists and counts (docs/contract.md, "Lists"): every count is the length of its list, per inbox the caller may see
// and in all; `counts.changed` at most once a second; the triage queue as redefined; inboxes' icon and position.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { CATEGORIES, INBOX_ICONS, STACKS, type Caller, type Counts, type Inbox, type MailEvent, type ThreadCounts } from "@usualmail/core";
import { DAY, HOUR, historyFromKnown, KNOWN, listen, makeServer, START, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

const STRANGER = { email: "new@stranger.example" };
const at = (ms: number) => new Date(Date.parse(START) + ms).toISOString();

/** Every list's length for the caller, by reading the lists themselves. */
async function listLengths(caller: Caller, inboxId?: string): Promise<ThreadCounts> {
  const scope = inboxId ? { inboxId, limit: 200 } : { limit: 200 };
  const home = (await t.server.home(caller, scope)).items;
  const categories = Object.fromEntries(await Promise.all(CATEGORIES.map(async (c) => [c, (await t.server.category(caller, c, scope)).items.length])));
  const stacks = Object.fromEntries(await Promise.all(STACKS.map(async (s) => [s, (await t.server.stack(caller, s, scope)).items.length])));
  return {
    home: home.length,
    unread: home.filter((thread) => thread.unread).length,
    categories: categories as ThreadCounts["categories"],
    stacks: stacks as ThreadCounts["stacks"],
    waiting: (await t.server.waiting(caller, scope)).items.length,
    screened: (await t.server.screening(caller, scope)).items.length,
  };
}

async function busyInbox(address: string): Promise<Inbox> {
  const { inbox } = await t.connect({ address, history: [historyFromKnown] });
  await t.aiOn();
  t.models.choose = (request) => (request.data.includes("Receipt") ? "receipt" : request.data.includes("News") ? "newsletter" : "conversation");
  const chat = await t.receive(inbox, { from: KNOWN, subject: `Chat ${address}` });
  await t.receive(inbox, { from: KNOWN, subject: `Unread chat ${address}` });
  const receipt = await t.receive(inbox, { from: KNOWN, subject: `Receipt ${address}` });
  const news = await t.receive(inbox, { from: KNOWN, subject: `News ${address}` });
  await t.receive(inbox, { from: STRANGER, subject: `Stranger ${address}` });
  await t.server.act(t.person, { threadIds: [chat.id], action: { kind: "read" } });
  await t.server.act(t.person, { threadIds: [receipt.id], action: { kind: "done" } });
  await t.server.act(t.person, { threadIds: [news.id], action: { kind: "stack", stack: "reply_later" } });
  const waiting = await t.receive(inbox, { from: KNOWN, subject: `Later ${address}` });
  await t.server.act(t.person, { threadIds: [waiting.id], action: { kind: "come_back", at: at(2 * DAY) } });
  return inbox;
}

describe("counts", () => {
  test("each count is the length of its list, per inbox and in all, and an agent sees only its inboxes", async () => {
    const one = await busyInbox("one@counts.example");
    const two = await busyInbox("two@counts.example");
    const counts = await t.server.counts(t.person);
    assert.deepEqual(counts.inboxes.map((entry) => entry.inboxId), [one.id, two.id], "in the inbox list's order");
    for (const entry of counts.inboxes) {
      const { inboxId, ...numbers } = entry;
      assert.deepEqual(numbers, await listLengths(t.person, inboxId), `inbox ${inboxId}`);
    }
    assert.deepEqual(counts.all, await listLengths(t.person));
    assert.equal(counts.inboxes[0]!.screened, 1);
    assert.equal(counts.inboxes[0]!.waiting, 1);
    assert.equal(counts.inboxes[0]!.stacks.reply_later, 1);
    assert.equal(counts.inboxes[0]!.categories.receipt, 0, "a done receipt is in no list");

    await t.server.updateInbox(t.person, two.id, { agentAccess: true });
    const agent = await t.agent([two.id]);
    const theirs = await t.server.counts(agent.caller);
    assert.deepEqual(theirs.inboxes.map((entry) => entry.inboxId), [two.id]);
    assert.deepEqual(theirs.all, await listLengths(agent.caller));
    assert.equal(theirs.version, counts.version, "the same version for every caller");
  });

  test("counts.changed goes out at most once a second, carrying the latest, filtered per receiver", async () => {
    const one = await busyInbox("one@counts.example");
    const two = await busyInbox("two@counts.example");
    await t.server.updateInbox(t.person, two.id, { agentAccess: true });
    const agent = await t.agent([two.id]);
    await t.tick(1_000);
    const person = listen(t);
    const theirs = listen(t, agent.caller);
    const first = (await t.server.home(t.person, { inboxId: one.id })).items[0]!;
    await t.server.act(t.person, { threadIds: [first.id], action: { kind: "unread" } });
    await t.server.act(t.person, { threadIds: [first.id], action: { kind: "done" } });
    await t.server.whenIdle();
    const counted = (events: MailEvent[]) => events.filter((e): e is Extract<MailEvent, { type: "counts.changed" }> => e.type === "counts.changed");
    assert.equal(counted(person.events).length, 0, "nothing before the second is up");
    await t.tick(1_000);
    const sent = counted(person.events);
    assert.equal(sent.length, 1, "one event for both changes");
    assert.deepEqual(sent[0]!.counts, await t.server.counts(t.person), "the latest counts");
    const agentSent = counted(theirs.events);
    assert.equal(agentSent.length, 1);
    assert.deepEqual(agentSent[0]!.counts.inboxes.map((entry) => entry.inboxId), [two.id], "the agent hears only its inbox");
    const previous: Counts = sent[0]!.counts;
    await t.server.act(t.person, { threadIds: [first.id], action: { kind: "not_done" } });
    await t.tick(1_000);
    const next = counted(person.events).at(-1)!.counts;
    assert.ok(next.version > previous.version, "the version rises with each change");
    await t.tick(5_000);
    assert.equal(counted(person.events).length, 2, "nothing changed, nothing sent");
    person.stop();
    theirs.stop();
  });
});

describe("the lists", () => {
  test("Home holds undecided threads and conversations, newest first, and a passed come-back time sorts by itself", async () => {
    const { inbox } = await t.connect({ address: "home@lists.example", history: [historyFromKnown] });
    const older = await t.receive(inbox, { from: KNOWN, subject: "Older", date: at(-3 * HOUR) });
    const newer = await t.receive(inbox, { from: KNOWN, subject: "Newer", date: at(-HOUR) });
    assert.deepEqual((await t.server.home(t.person, {})).items.map((x) => x.id), [newer.id, older.id]);
    await t.server.act(t.person, { threadIds: [older.id], action: { kind: "come_back", at: at(HOUR) } });
    assert.deepEqual((await t.server.waiting(t.person, {})).items.map((x) => x.id), [older.id]);
    await t.tick(2 * HOUR);
    assert.deepEqual((await t.server.home(t.person, {})).items.map((x) => x.id), [older.id, newer.id], "back on top by its come-back time");
    assert.deepEqual((await t.server.waiting(t.person, {})).items, []);
  });

  test("notifications aren't in Home but in their own list (the owner's decision of 2026-11-19); at the provider they stay under their label, done too", async () => {
    const { inbox, mailbox } = await t.connect({ address: "notes@lists.example", history: [historyFromKnown] });
    await t.aiOn();
    t.models.choose = (request) => (request.data.includes("Alert") ? "notification" : request.data.includes("Receipt") ? "receipt" : "conversation");
    const chat = await t.receive(inbox, { from: KNOWN, subject: "Chat", date: at(-3 * HOUR) });
    const alert = await t.receive(inbox, { from: KNOWN, subject: "Alert", date: at(-2 * HOUR) });
    await t.receive(inbox, { from: KNOWN, subject: "Receipt", date: at(-HOUR) });
    await t.server.whenIdle();
    assert.equal((await t.server.thread(t.person, alert.id)).thread.category, "notification");
    assert.deepEqual((await t.server.home(t.person, {})).items.map((x) => x.id), [chat.id], "not the notification, not the receipt");
    assert.deepEqual([(await t.server.counts(t.person)).all.home, (await t.server.counts(t.person)).all.categories.notification], [1, 1]);
    assert.deepEqual((await t.server.category(t.person, "notification", {})).items.map((x) => x.id), [alert.id]);
    const atProvider = () => mailbox.messages().find((m) => m.subject === "Alert")!.placement;
    assert.deepEqual([atProvider().inInbox, atProvider().category], [false, "notification"], "out of the inbox, under its label");
    await t.server.act(t.person, { threadIds: [alert.id], action: { kind: "done" } });
    await t.server.whenIdle();
    assert.deepEqual((await t.server.category(t.person, "notification", {})).items, [], "done from its list");
    assert.deepEqual((await t.server.home(t.person, {})).items.map((x) => x.id), [chat.id]);
    assert.deepEqual([atProvider().inInbox, atProvider().category], [false, "notification"], "done changes nothing there");
  });

  test("search finds summaries, done and screened threads too", async () => {
    const { inbox } = await t.connect({ address: "search@lists.example", history: [historyFromKnown] });
    await t.aiOn();
    t.models.write = () => "Asks about the quarterly volcano budget.";
    const thread = await t.receive(inbox, { from: STRANGER, subject: "Hello" });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } });
    assert.deepEqual((await t.server.search(t.person, { q: "volcano" })).items.map((x) => x.id), [thread.id]);
  });
});

describe("the triage queue", () => {
  test("holds undecided threads the AI won't process: the AI not working, or its answer dropped", async () => {
    const { inbox: one } = await t.connect({ address: "one@triage.example", history: [historyFromKnown] });
    const { inbox: two } = await t.connect({ address: "two@triage.example", history: [historyFromKnown] });
    const queued = async () => (await t.server.triageQueue(t.person, {})).map((item) => item.thread.subject).sort();
    await t.receive(one, { from: KNOWN, subject: "Recent, first inbox" });
    await t.receive(one, { from: KNOWN, subject: "Old, first inbox", date: at(-10 * DAY) });
    await t.receive(two, { from: KNOWN, subject: "Recent, second inbox" });
    await t.receive(two, { from: STRANGER, subject: "Screened, second inbox" });
    const all = ["Old, first inbox", "Recent, first inbox", "Recent, second inbox"];
    assert.deepEqual(await queued(), all, "not set up: every undecided thread that isn't screened");

    const heard = listen(t);
    // Set while paused, so nothing is processed yet: paused, the AI isn't working.
    await t.server.updateAiSettings(t.person, { credentials: { kind: "gateway", gateway: "vercel", apiKey: "vck_triage" }, paused: true });
    assert.deepEqual(await queued(), all, "paused: the AI isn't working");
    t.models.choose = () => null;
    t.models.write = () => null;
    const release = t.models.pause();
    await t.server.updateAiSettings(t.person, { paused: false });
    // The AI works and processes every inbox's synced mail, however old (history is all synced mail since 2026-11-18).
    assert.deepEqual(await queued(), [], "the AI will decide them all");
    release();
    await t.server.whenIdle();
    assert.deepEqual(await queued(), all, "its answers were dropped: they wait for an agent");
    await t.tick(1_000);
    assert.ok(heard.events.some((e) => e.type === "triage.pending" && e.inboxId === two.id), "the count changed with the AI's state");
    heard.stop();
  });
});

describe("inboxes' icon and position", () => {
  test("new inboxes come last and take person, building and briefcase in turn", async () => {
    const made: Inbox[] = [];
    for (const name of ["a", "b", "c", "d"]) made.push((await t.connect({ address: `${name}@order.example` })).inbox);
    assert.deepEqual(made.map((inbox) => [inbox.position, inbox.icon]), [[0, "person"], [1, "building"], [2, "briefcase"], [3, "person"]]);
    const chosen = await t.server.connectInbox(t.person, { name: "E", color: "#2F6FED", provider: "imap", credentials: { mailbox: "e@order.example" }, icon: "shop" });
    assert.deepEqual([chosen.position, chosen.icon], [4, "shop"]);
    await assert.rejects(t.server.updateInbox(t.person, chosen.id, { icon: "castle" as never }), { code: "invalid" });
  });

  test("the owner's eight more icons (2026-11-20) are each accepted, after the six, in their order; an unknown one is still refused", async () => {
    const { inbox } = await t.connect({ address: "icons@order.example" });
    assert.deepEqual([...INBOX_ICONS], ["person", "building", "briefcase", "house", "shop", "globe", "plane", "wallet", "family", "rocket", "school", "heart", "star", "leaf"]);
    for (const icon of ["plane", "wallet", "family", "rocket", "school", "heart", "star", "leaf"] as const) {
      assert.equal((await t.server.updateInbox(t.person, inbox.id, { icon })).icon, icon);
    }
    await assert.rejects(t.server.updateInbox(t.person, inbox.id, { icon: "castle" as never }), { code: "invalid" });
  });

  test("setting a position moves the inbox there and renumbers the others, each with a new version and an event", async () => {
    const made: Inbox[] = [];
    for (const name of ["a", "b", "c", "d"]) made.push((await t.connect({ address: `${name}@order.example` })).inbox);
    const heard = listen(t);
    const moved = await t.server.updateInbox(t.person, made[3]!.id, { position: 1 });
    assert.equal(moved.position, 1);
    const list = await t.server.listInboxes(t.person);
    assert.deepEqual(list.map((inbox) => inbox.address), ["a@order.example", "d@order.example", "b@order.example", "c@order.example"]);
    assert.deepEqual(list.map((inbox) => inbox.position), [0, 1, 2, 3]);
    const changed = heard.events.filter((e): e is Extract<MailEvent, { type: "inbox.changed" }> => e.type === "inbox.changed").map((e) => e.inbox.address).sort();
    assert.deepEqual(changed, ["b@order.example", "c@order.example", "d@order.example"], "a didn't move, so it didn't change");
    assert.ok(list[2]!.version > made[1]!.version);
    const last = await t.server.updateInbox(t.person, made[0]!.id, { position: 99 });
    assert.equal(last.position, 3, "beyond the end is the end");

    await t.server.removeInbox(t.person, made[1]!.id);
    assert.deepEqual((await t.server.listInboxes(t.person)).map((inbox) => [inbox.address, inbox.position]), [
      ["d@order.example", 0], ["c@order.example", 1], ["a@order.example", 2],
    ], "removing one closes the gap");
    assert.deepEqual((await t.server.counts(t.person)).inboxes.map((entry) => entry.inboxId), (await t.server.listInboxes(t.person)).map((inbox) => inbox.id));
    heard.stop();
  });
});
