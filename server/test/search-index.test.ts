// Keeping search's index right (docs/contract-search.md, "Keeping the index right"): mail joining, the AI's facts
// landing, a thread trashed or gone, an inbox removed, a blocked sender's messages in someone else's thread, who may
// search, and the first start's build. Made-up mail only.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { sql } from "drizzle-orm";
import { threads } from "../src/db/index.ts";
import { historyFromKnown, KNOWN, makeServer, type TestServer } from "./helpers.ts";

const STRANGER = { name: "Mallory", email: "mallory@stranger.example" };
const ALICE = { name: "Alice", email: "alice@people.example" };
const found = async (t: TestServer, q: string) => (await t.server.search(t.person, { q })).items.map((item) => item.subject);
const count = async (t: TestServer, table: string) =>
  Number((await t.host.db.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${table}`)))[0]!.n);

describe("keeping the index right", () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await makeServer();
  });
  afterEach(() => t.close());

  test("mail joining a thread is found, and its words are the excerpt", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@index.example", history: [historyFromKnown] });
    await t.receive(inbox, { from: KNOWN, subject: "Trip", text: "Where shall we go?", messageId: "trip@index.example" });
    assert.deepEqual(await found(t, "lisbon"), []);
    mailbox.deliver({ from: KNOWN, subject: "Re: Trip", text: "What about Lisbon in May?", inReplyTo: "trip@index.example" });
    await t.sync(inbox);
    const hit = (await t.server.search(t.person, { q: "lisbon" })).items[0]!;
    assert.equal(hit.subject, "Trip");
    assert.deepEqual(hit.match!.excerpt!.runs.filter((run) => run.match).map((run) => run.text), ["Lisbon"]);
  });

  test("a summary, payment details or an event landing is found, also when no event told of it", async () => {
    const { inbox } = await t.connect({ address: "me@index.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Notice", text: "Something happened." });
    await t.host.db.update(threads).set({
      category: "notification",
      summary: "The boiler service is booked",
      event: { status: "Appointment confirmed", about: "Boiler service", when: { date: "2026-11-20", time: null, endTime: null } },
      version: sql`${threads.version} + 1`,
    }).where(sql`${threads.id} = ${thread.id}`);
    assert.deepEqual(await found(t, "boiler"), ["Notice"]);
    const hit = (await t.server.search(t.person, { q: "appointment confirmed" })).items[0]!;
    assert.deepEqual(hit.match!.fields, ["facts"]);
    assert.equal(hit.match!.excerpt!.field, "facts");
  });

  test("the AI's own summary is found once it is written", async () => {
    const { inbox } = await t.connect({ address: "me@index.example", history: [historyFromKnown] });
    t.models.write = () => "Quarterly figures for the garden club";
    await t.aiOn();
    await t.receive(inbox, { from: KNOWN, subject: "Numbers", text: "See the attached numbers." });
    await t.tick();
    assert.equal((await t.threadBySubject("Numbers")).summary, "Quarterly figures for the garden club");
    const hit = (await t.server.search(t.person, { q: "garden club" })).items[0]!;
    assert.equal(hit.subject, "Numbers");
    assert.deepEqual(hit.match!.fields, ["summary"]);
  });

  test("a trashed thread isn't found until the trash is undone; a thread gone from the mailbox leaves the index", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@index.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Ephemeral", text: "Here today." });
    const trashed = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "trash" } });
    await t.server.whenIdle();
    assert.deepEqual(await found(t, "ephemeral"), []);
    await t.server.undo(t.person, trashed.records[0]!.id);
    await t.server.whenIdle();
    assert.deepEqual(await found(t, "ephemeral"), ["Ephemeral"]);
    const docs = await count(t, "search_docs");
    for (const message of mailbox.messages().filter((m) => m.subject === "Ephemeral")) mailbox.remove(message.ref);
    await t.sync(inbox);
    assert.deepEqual(await found(t, "ephemeral"), []);
    assert.equal(await count(t, "search_docs"), docs - 1);
    assert.equal(await count(t, "search_index"), docs - 1, "the trigger took the index's row");
  });

  test("removing an inbox removes its entries; other inboxes keep theirs", async () => {
    const { inbox } = await t.connect({ address: "me@one.example", history: [{ ...historyFromKnown, subject: "One's mail" }] });
    await t.connect({ address: "me@two.example", history: [{ ...historyFromKnown, subject: "Two's mail" }] });
    assert.deepEqual((await found(t, "mail")).sort(), ["One's mail", "Two's mail"]);
    assert.equal(await count(t, "search_docs"), 2);
    await t.server.removeInbox(t.person, inbox.id);
    await t.server.whenIdle();
    assert.deepEqual(await found(t, "mail"), ["Two's mail"]);
    assert.equal(await count(t, "search_docs"), 1);
    assert.equal(await count(t, "search_index"), 1);
    assert.equal(Number((await t.host.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM search_people WHERE inbox_id = ${inbox.id}`))[0]!.n), 0);
  });

  test("a blocked sender's words in someone else's thread are never found nor shown; their own thread is found, done", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@index.example", history: [historyFromKnown] });
    const theirs = await t.receive(inbox, { from: STRANGER, subject: "Offer", text: "Buy now." });
    await t.server.act(t.person, { threadIds: [theirs.id], action: { kind: "block_sender" } });
    await t.server.whenIdle();
    await t.receive(inbox, { from: ALICE, subject: "Plans", text: "Shall we?", messageId: "plans@index.example" });
    mailbox.deliver({ from: STRANGER, subject: "Re: Plans", text: "Secret pineapple words.", inReplyTo: "plans@index.example" });
    await t.sync(inbox);
    assert.deepEqual(await found(t, "pineapple"), [], "hidden in Alice's thread");
    assert.deepEqual((await t.server.search(t.person, { from: "mallory@stranger.example" })).items.map((item) => [item.subject, item.done]), [["Offer", true]]);
    const people = (await t.server.search(t.person, { q: "plans" })).items[0]!;
    assert.ok(!JSON.stringify(people).includes("pineapple"));
  });

  test("a screened thread is found; an agent finds only in the inboxes it may see", async () => {
    const { inbox: one } = await t.connect({ address: "me@one.example", agentAccess: true, history: [historyFromKnown] });
    const { inbox: two } = await t.connect({ address: "me@two.example", history: [historyFromKnown] });
    await t.receive(one, { from: STRANGER, subject: "Hello from afar", text: "First mail." });
    await t.receive(two, { from: STRANGER, subject: "Hello again from afar", text: "First mail." });
    const screened = (await t.server.search(t.person, { q: "afar", kinds: ["screened"] })).items;
    assert.equal(screened.length, 2);
    const { caller } = await t.agent([one.id, two.id]);
    assert.deepEqual((await t.server.search(caller, { q: "afar" })).items.map((item) => item.subject), ["Hello from afar"], "two has no agent access");
    await assert.rejects(t.server.search(caller, { q: "afar", inboxIds: [two.id] }), { code: "not_found" });
    await assert.rejects(t.server.searchRemote(caller, { q: "afar" }), { code: "needs_person" });
    await assert.rejects(t.server.openRemote(caller, "rem_x"), { code: "needs_person" });
  });
});

test("the first start builds the index from what is stored, by rule, and logs counts only", async () => {
  const t = await makeServer();
  try {
    const { inbox } = await t.connect({ address: "me@build.example", history: [historyFromKnown] });
    await t.receive(inbox, { from: KNOWN, subject: "Secret subject words", text: "Nothing of this in the log." });
    // As a store from before search: the index emptied, then the server started again on it.
    await t.host.db.run(sql`DELETE FROM search_docs`);
    assert.equal(await count(t, "search_index"), 0);
    t.infos.length = 0;
    await t.server.stop();
    await t.server.start();
    await t.server.whenIdle();
    const line = t.infos.find((info) => info.startsWith("Search index:"));
    assert.match(line ?? "", /^Search index: 2 threads \(2 messages\) indexed in \d+\.\d s$/);
    assert.ok(!t.infos.some((info) => /secret|nothing/i.test(info)));
    assert.equal(t.models.requests.length, 0, "no AI request");
    assert.deepEqual(await found(t, "secret"), ["Secret subject words"]);
  } finally {
    await t.close();
  }
});

test("remote search: an inbox whose mailbox can't be searched answers unsupported, a paused one paused", async () => {
  const t = await makeServer();
  try {
    const { inbox: imap } = await t.connect({ address: "me@imap.example", history: [historyFromKnown] });
    const { inbox: gmail } = await t.connect({ address: "me@gmail.example", mailbox: { kind: "gmail" }, history: [historyFromKnown] });
    const answer = await t.server.searchRemote(t.person, { q: "anything" });
    assert.deepEqual(answer.inboxes.map((i) => [i.inboxId, i.state]), [[imap.id, "unsupported"], [gmail.id, "ok"]]);
    await t.server.updateInbox(t.person, gmail.id, { paused: true });
    assert.deepEqual((await t.server.searchRemote(t.person, { q: "anything", inboxIds: [gmail.id] })).inboxes.map((i) => i.state), ["paused"]);
    await assert.rejects(t.server.openRemote(t.person, "rem_made-up"), { code: "not_found" });
  } finally {
    await t.close();
  }
});
