// No statement binds more than 100 parameters, the most a Durable Object's SQLite takes (docs/agents/decisions.md,
// 2026-11-21). Here: the check every test runs under (test/parameters.ts) is in place and catches what it should, the
// helpers that keep lists and inserts within the limit, and every list scoped to the caller's inboxes with more than
// 100 inboxes. The paths with more than 100 threads, messages or senders are in statement-limits-mail.test.ts.

import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { afterEach, describe, test } from "node:test";
import { asc, eq, sql } from "drizzle-orm";
import { searchPeople, threads } from "../src/db/index.ts";
import { inList, insertChunks, MAX_PARAMS } from "../src/db/params.ts";
import { openDatabase } from "../src/node/db.ts";
import { at, DAY, KNOWN, makeServer, type TestServer } from "./helpers.ts";
import { jsonLists, overLimit } from "./parameters.ts";
import { listScans } from "./list-plans.ts";

describe("the check every test runs under", () => {
  test("refuses a statement over 100 parameters, alone, in a batch, in a transaction and in a migration", async () => {
    const client = createClient({ url: ":memory:" });
    const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");
    const args = (n: number) => Array.from({ length: n }, (_, i) => i);
    try {
      assert.equal((await client.execute({ sql: `SELECT ${marks(MAX_PARAMS)}`, args: args(MAX_PARAMS) })).columns.length, 100);
      await assert.rejects(client.execute({ sql: `SELECT ${marks(101)}`, args: args(101) }), /too many SQL variables/);
      await assert.rejects(client.execute(`SELECT ${marks(101)}`, args(101)), /too many SQL variables/);
      await assert.rejects(client.batch([{ sql: "SELECT 1", args: [] }, { sql: `SELECT ${marks(101)}`, args: args(101) }]), /too many SQL variables/);
      await assert.rejects(client.batch([[`SELECT ${marks(101)}`, args(101)]]), /too many SQL variables/);
      await assert.rejects(client.migrate([{ sql: `SELECT ${marks(101)}`, args: args(101) }]), /too many SQL variables/);
      const named = Object.fromEntries(args(101).map((i) => [`p${i}`, i]));
      await assert.rejects(client.execute({ sql: `SELECT ${args(101).map((i) => `:p${i}`).join(", ")}`, args: named }), /too many SQL variables/);
      const tx = await client.transaction("write");
      await assert.rejects(tx.execute({ sql: `SELECT ${marks(101)}`, args: args(101) }), /too many SQL variables/);
      await assert.rejects(tx.batch([{ sql: `SELECT ${marks(101)}`, args: args(101) }]), /too many SQL variables/);
      await tx.rollback();
      assert.equal(overLimit.length, 8, "each is remembered, so a caught error still fails its test file");
      assert.match(overLimit[0]!, /^101 parameters: SELECT \?, \?/);
    } finally {
      // These were on purpose; the check after this file's tests would fail on them otherwise.
      overLimit.length = 0;
      client.close();
    }
  });

  test("refuses a LIKE or GLOB pattern over 50 bytes, bound or written, and one it can't measure", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      assert.equal((await client.execute({ sql: "SELECT ? LIKE ?", args: ["x", `%${"a".repeat(49)}`] })).rows.length, 1, "50 bytes pass");
      await assert.rejects(client.execute({ sql: "SELECT ? LIKE ?", args: ["x", `%${"a".repeat(50)}`] }), /LIKE or GLOB pattern too complex/);
      await assert.rejects(client.execute({ sql: "SELECT ? LIKE ?", args: ["x", `%${"山".repeat(17)}%`] }), /53 bytes/, "17 CJK characters");
      await assert.rejects(client.execute(`SELECT 'x' NOT LIKE '${"b".repeat(51)}'`), /too complex/);
      await assert.rejects(client.batch([{ sql: "SELECT ? GLOB ?", args: ["x", `*${"c".repeat(50)}`] }]), /too complex/);
      await assert.rejects(client.execute({ sql: "SELECT 'x' LIKE '%' || ?", args: ["a"] }), /unmeasurable/, "a pattern joined in SQL");
      // A `?` in a literal, an identifier or a comment isn't a parameter: the LIKE's is the second, two bytes long.
      const quoted = { sql: `SELECT 'a?b' AS "c?", ? -- ?\n LIKE ? ESCAPE '\\', ?`, args: ["x", "%a", "z".repeat(60)] };
      assert.equal((await client.execute(quoted)).rows.length, 1);
      assert.equal(overLimit.length, 5);
      assert.match(overLimit[0]!, /^a LIKE or GLOB pattern of 51 bytes: SELECT \? LIKE \?/);
    } finally {
      overLimit.length = 0;
      client.close();
    }
  });

  test("counts what Drizzle sends in a batch, which its logger never sees", async () => {
    const store = await openDatabase(":memory:");
    try {
      const ids = Array.from({ length: 101 }, (_, i) => `thr_${i}`);
      await assert.rejects(store.db.batch([store.db.select().from(threads).where(sql`${threads.id} IN ${ids}`)]), /too many SQL variables/);
      overLimit.length = 0;
    } finally {
      store.close();
    }
  });
});

describe("keeping a statement within the limit", () => {
  test("inList matches any number of values with one parameter, and none with none", async () => {
    const store = await openDatabase(":memory:");
    try {
      const ids = Array.from({ length: 250 }, (_, i) => `id-${String(i).padStart(3, "0")}`);
      const query = store.db.select({ value: sql<string>`value` }).from(sql`json_each(${JSON.stringify(ids)})`)
        .where(inList(sql`value`, ids.filter((_, i) => i % 2 === 0))).orderBy(asc(sql`value`));
      assert.equal(query.toSQL().params.length, 2, "the list, and the table it is matched against");
      assert.deepEqual((await query).map((row) => row.value), ids.filter((_, i) => i % 2 === 0));
      // Text only: from JSON a number comes back a number, which no TEXT column's value equals, so numbers don't type-check.
      await store.db.run(sql`CREATE TABLE codes (code TEXT)`);
      await store.db.run(sql`INSERT INTO codes VALUES ('5'), ('6')`);
      assert.deepEqual(await store.db.all(sql`SELECT code FROM codes WHERE code IN (SELECT value FROM json_each('[5]'))`), [], "why: '5' isn't [5]");
      assert.deepEqual(await store.db.all(sql`SELECT code FROM codes WHERE ${inList(sql`code`, ["5"])}`), [{ code: "5" }]);
      // @ts-expect-error inList takes text only.
      inList(sql`code`, [5]);
      // The made-up table isn't the store's: the plan check below reads only the server's statements.
      for (const text of [...jsonLists.keys()]) if (text.includes("FROM codes")) jsonLists.delete(text);
      assert.deepEqual(await store.db.select().from(threads).where(inList(threads.id, [])), []);
      // Text that needs escaping in JSON comes back as it was.
      const odd = ['a"b', "back\\slash", "new\nline", "ümlaut", "emoji 📬"];
      const back = await store.db.all<{ v: string }>(sql`SELECT value AS v FROM json_each(${JSON.stringify(odd)}) WHERE ${inList(sql`value`, odd)}`);
      assert.deepEqual(back.map((row) => row.v), odd);
    } finally {
      store.close();
    }
  });

  test("insertChunks cuts rows so rows times columns, and what the statement binds besides, stay within 100", () => {
    const rows = Array.from({ length: 250 }, (_, i) => i);
    const people = insertChunks(searchPeople, rows);
    assert.equal(people[0]!.length, 14, "search_people has 7 columns: 14 rows bind 98");
    assert.deepEqual(people.flat(), rows, "every row once, in order");
    assert.equal(insertChunks(searchPeople, rows, 3)[0]!.length, 13, "three bound elsewhere leave room for 13");
    assert.deepEqual(insertChunks(searchPeople, []), []);
  });
});

describe("more than 100 inboxes", () => {
  let t: TestServer;
  afterEach(() => t?.close());

  test("every list over the caller's inboxes still holds what each inbox gives it", async () => {
    t = await makeServer();
    // The first inbox knows Dana from its history; the last hears from a stranger, who is screened.
    const first = await t.connect({ address: "me@first.example", history: [{ from: KNOWN, subject: "Lease question", text: "About the lease, Dana.", date: at(-DAY) }] });
    for (let i = 0; i < 110; i++) await t.connect({ address: `me${i}@many.example` });
    const last = await t.connect({ address: "me@last.example" });
    await t.receive(last.inbox, { from: { name: "Quill Stranger", email: "quill@stranger.example" }, subject: "Lease offer", text: "A lease for you." });
    await t.server.createRule(t.person, { inboxId: first.inbox.id, text: "Kestrel is a receipt", match: { domain: "kestrel.example" }, then: [{ kind: "categorize", category: "receipt" }] });
    await t.receive(first.inbox, { from: { name: "Kestrel Roasters", email: "billing@kestrel.example" }, subject: "Beans receipt", text: "Paid." });
    const dana = await t.threadBySubject("Lease question");
    await t.server.act(t.person, { threadIds: [(await t.threadBySubject("Lease offer")).id], action: { kind: "block_sender" } });
    await t.server.saveDraft(t.person, { inboxId: last.inbox.id, to: [{ email: "someone@else.example" }], subject: "A draft", body: "Not yet." });
    assert.equal((await t.server.listInboxes(t.person)).length, 112);

    const subjects = (page: { items: Array<{ subject: string }> }) => page.items.map((thread) => thread.subject);
    assert.deepEqual(subjects(await t.server.home(t.person, {})), ["Lease question"]);
    assert.deepEqual(subjects(await t.server.category(t.person, "receipt", {})), ["Beans receipt"]);
    assert.deepEqual(subjects(await t.server.screening(t.person, {})), [], "the blocked stranger's thread is done");
    assert.deepEqual(subjects(await t.server.waiting(t.person, {})), []);
    const handled = await t.server.handled(t.person, {});
    assert.deepEqual(handled.items.map((item) => [item.record.actor.kind, item.thread.subject]), [["rule", "Beans receipt"]]);
    assert.deepEqual((await t.server.listDrafts(t.person, {})).items.map((draft) => draft.subject), ["A draft"]);
    assert.deepEqual((await t.server.senders(t.person, {})).items.map((sender) => [sender.inboxId, sender.address]), [[last.inbox.id, "quill@stranger.example"]]);
    assert.deepEqual((await t.server.triageQueue(t.person, {})).map((item) => item.thread.id), [dana.id], "undecided, with the AI off");

    const found = await t.server.search(t.person, { q: "lease" });
    assert.deepEqual(found.items.map((hit) => hit.subject).sort(), ["Lease offer", "Lease question"]);
    assert.ok(found.items.every((hit) => hit.match?.fields.length), "each with where it matched");
    assert.deepEqual(subjects(await t.server.search(t.person, { kinds: ["receipt"] })), ["Beans receipt"], "a filter alone lists");
    const people = await t.server.search(t.person, { q: "dana" });
    assert.deepEqual(people.people?.map((p) => [p.email, p.name]), [[KNOWN.email, KNOWN.name]]);
    const stored = await t.host.db.select({ id: threads.id }).from(threads).where(eq(threads.inboxId, first.inbox.id));
    assert.equal(stored.length, 2);
  });
});

describe("query plans", () => {
  test("every list this file bound as JSON is read through an index, never a scan", async (t) => {
    const { statements, scans } = await listScans();
    if (statements === 0) return t.skip("no list was bound: the tests above didn't run");
    assert.deepEqual(scans, []);
  });
});
