// Every migration replayed as a Durable Object would run it (docs/agents/server-cloudflare.md, "Migrations"; the known
// issue of 2026-11-21). Drizzle's durable-sqlite migrator runs all the files a store hasn't had inside one
// `transactionSync`, and there foreign keys stay on, since a Durable Object ignores `PRAGMA foreign_keys = OFF`.
// libSQL's own `migrate` turns them off, so this test runs the statements itself, on a store with rows in every table.
// The first test commits each file on its own, filling the store again before each (so tables a file adds have rows for
// the next): stricter for lost rows than one run, since every file meets rows. The second runs a store's pending files
// in one transaction as the migrator does, and shows a later file's failure undoing the earlier ones. No row of any
// table may be lost and no foreign key broken. The last test shows the replay catches what it is for: a drizzle-kit
// table rebuild cascade-deletes the rebuilt table's children.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { createClient, type Client, type InValue, type Transaction } from "@libsql/client";

const FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));
/** Rows each table gets before each step. */
const ROWS = 2;

interface Migration {
  tag: string;
  when: number;
  statements: string[];
}

async function migrations(): Promise<Migration[]> {
  const journal = JSON.parse(await readFile(`${FOLDER}/meta/_journal.json`, "utf8")) as { entries: Array<{ tag: string; when: number }> };
  return Promise.all(journal.entries.map(async ({ tag, when }) => ({
    tag, when, statements: (await readFile(`${FOLDER}/${tag}.sql`, "utf8")).split("--> statement-breakpoint"),
  })));
}

/**
 * Migrations as the durable-sqlite migrator runs those a store hasn't had: each file's statements as written, then its
 * journal row, all in one transaction, undone together when any fails.
 */
async function apply(client: Client, pending: Migration[]): Promise<void> {
  const tx = await client.transaction("write");
  try {
    await expectForeignKeysOn(tx);
    for (const migration of pending) {
      for (const statement of migration.statements) await tx.execute(statement);
      await tx.execute({ sql: 'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)', args: ["", migration.when] });
    }
    await expectForeignKeysOn(tx);
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function expectForeignKeysOn(tx: Transaction): Promise<void> {
  assert.equal(Number((await tx.execute("PRAGMA foreign_keys")).rows[0]![0]), 1, "foreign keys on, as in a Durable Object");
}

interface Table {
  name: string;
  virtual: boolean;
}

/** The store's tables: ordinary ones, and full-text indexes (their shadow tables are theirs, not counted). */
async function tables(client: Client): Promise<Table[]> {
  const rows = (await client.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name")).rows;
  const virtual = rows.filter((row) => String(row.sql).startsWith("CREATE VIRTUAL TABLE")).map((row) => String(row.name));
  return rows.map((row) => String(row.name))
    .filter((name) => !virtual.some((v) => name.startsWith(`${v}_`)))
    .map((name) => ({ name, virtual: virtual.includes(name) }));
}

async function counts(client: Client): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const { name } of await tables(client)) out.set(name, Number((await client.execute(`SELECT count(*) FROM "${name}"`)).rows[0]![0]));
  return out;
}

let serial = 0;

/**
 * Adds `ROWS` rows to every ordinary table, parents before children: each foreign key names a row of its parent (a
 * different one each time, so a unique key on it holds), each other column a value of its declared type, unique, text
 * as a small JSON object so the migrations' JSON functions can read it. Then a full-text row for each search document
 * without one, under its id, as the server writes them.
 */
async function fill(client: Client): Promise<void> {
  const ordinary = (await tables(client)).filter((table) => !table.virtual).map((table) => table.name);
  const parents = new Map<string, Array<{ id: number; table: string; from: string; to: string }>>();
  for (const name of ordinary) {
    const keys = (await client.execute(`PRAGMA foreign_key_list("${name}")`)).rows;
    parents.set(name, keys.map((key) => ({ id: Number(key.id), table: String(key.table), from: String(key.from), to: String(key.to) })));
  }
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < ordinary.length) {
    const next = ordinary.find((name) => !done.has(name) && parents.get(name)!.every((key) => key.table === name || done.has(key.table)));
    assert.ok(next, "the foreign keys form no cycle");
    done.add(next);
    order.push(next);
  }
  for (const name of order) {
    const columns = (await client.execute(`PRAGMA table_info("${name}")`)).rows;
    const rowid = columns.filter((column) => Number(column.pk) > 0).length === 1
      ? columns.find((column) => Number(column.pk) === 1 && String(column.type).toUpperCase() === "INTEGER") : undefined;
    for (let i = 0; i < ROWS; i++) {
      const values = new Map<string, InValue>();
      const own = Number((await client.execute(`SELECT count(*) FROM "${name}"`)).rows[0]![0]);
      for (const key of parents.get(name)!) {
        const total = Number((await client.execute(`SELECT count(*) FROM "${key.table}"`)).rows[0]![0]);
        assert.ok(total > own, `${key.table} has a row for each of ${name}'s`);
        const parent = (await client.execute(`SELECT "${key.to}" FROM "${key.table}" ORDER BY rowid LIMIT 1 OFFSET ${own}`)).rows[0]!;
        values.set(key.from, parent[0] as InValue);
      }
      for (const column of columns) {
        const field = String(column.name);
        if (values.has(field) || column === rowid) continue;
        const n = ++serial;
        const type = String(column.type).toUpperCase();
        values.set(field, type === "INTEGER" ? n : type === "REAL" ? n + 0.5 : type === "BLOB" ? new Uint8Array([n % 256]) : JSON.stringify({ t: `${name}.${field}`, n }));
      }
      const fields = [...values.keys()];
      await client.execute({
        sql: `INSERT INTO "${name}" (${fields.map((f) => `"${f}"`).join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
        args: fields.map((f) => values.get(f)!),
      });
    }
  }
  if (ordinary.includes("search_docs")) {
    await client.execute("INSERT INTO search_index (rowid, subject, body) SELECT id, 'subject ' || id, 'body ' || id FROM search_docs WHERE id NOT IN (SELECT rowid FROM search_index)");
  }
}

/** The rows each table lost since `before`, by table; tables a step added aren't compared. */
function lost(before: Map<string, number>, after: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, count] of before) {
    const now = after.get(name) ?? 0;
    if (now !== count) out[name] = count - now;
  }
  return out;
}

/** A store taken through the first `upTo` migrations one at a time, checked after each, then filled once more. */
async function filledStore(upTo = Number.POSITIVE_INFINITY): Promise<{ client: Client; all: Migration[] }> {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute('CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
  const all = await migrations();
  for (const migration of all.slice(0, upTo)) {
    await fill(client);
    const before = await counts(client);
    await apply(client, [migration]);
    assert.deepEqual(lost(before, await counts(client)), {}, `${migration.tag} loses no row of any table`);
    assert.deepEqual((await client.execute("PRAGMA foreign_key_check")).rows, [], `${migration.tag} breaks no foreign key`);
  }
  // Rows in the tables the last step added too, for the next migration (and the rebuild below).
  await fill(client);
  return { client, all };
}

describe("every migration replayed as a Durable Object runs it", () => {
  test("each, in its own transaction with foreign keys on, keeps every row of a store filled in every table", async () => {
    const { client, all } = await filledStore();
    try {
      assert.ok(all.length >= 19);
      const final = await counts(client);
      for (const [name, count] of final) assert.ok(count >= ROWS, `${name} holds rows`);
      assert.ok((final.get("messages") ?? 0) > 0 && (final.get("search_index") ?? 0) > 0, "children and the full-text index included");
      assert.equal(String((await client.execute("PRAGMA integrity_check")).rows[0]![0]), "ok");
      const applied = Number((await client.execute('SELECT count(*) FROM "__drizzle_migrations"')).rows[0]![0]);
      assert.equal(applied, all.length);
    } finally {
      client.close();
    }
  });

  test("a store's pending files in one transaction, as the migrator runs them; a later file's failure undoes them all", async () => {
    // A store from before sent messages were remembered (0009): ten files pending, as after a long gap between deploys.
    const { client, all } = await filledStore(9);
    try {
      const schema = async () => (await client.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")).rows.map((row) => [row.type, row.name, row.sql]);
      const journal = async () => Number((await client.execute('SELECT count(*) FROM "__drizzle_migrations"')).rows[0]![0]);
      const pending = all.slice(9);
      const before = await counts(client);
      const tables = await schema();
      const broken: Migration = { tag: "made-up broken file", when: Date.now(), statements: ["CREATE TABLE `made_up` (`id` text)", "INSERT INTO `no_such_table` VALUES (1)"] };
      await assert.rejects(apply(client, [...pending, broken]), /no such table/);
      assert.deepEqual(await schema(), tables, "no file of the run stays applied");
      assert.deepEqual(await counts(client), before);
      assert.equal(await journal(), 9);

      await apply(client, pending);
      assert.deepEqual(lost(before, await counts(client)), {}, "the pending files together lose no row");
      assert.deepEqual((await client.execute("PRAGMA foreign_key_check")).rows, []);
      assert.equal(await journal(), all.length);
    } finally {
      client.close();
    }
  });

  test("catches a drizzle-kit rebuild of a parent table, which libSQL's own migrate would let through", async () => {
    const { client } = await filledStore();
    try {
      // A rebuild as drizzle-kit writes one (`__new_<table>`, copy, drop, rename), of threads, which others reference
      // with ON DELETE CASCADE. Its PRAGMA lines do nothing inside a transaction, as on a Durable Object.
      const create = String((await client.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'threads'")).rows[0]![0]);
      const indexes = (await client.execute("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'threads' AND sql IS NOT NULL")).rows.map((row) => String(row.sql));
      const columns = (await client.execute('PRAGMA table_info("threads")')).rows.map((row) => `"${String(row.name)}"`).join(", ");
      const rebuild: Migration = {
        tag: "made-up rebuild of threads",
        when: Date.now(),
        statements: [
          "PRAGMA foreign_keys=OFF",
          create.replace(/^CREATE TABLE [`"]?threads[`"]?/, 'CREATE TABLE "__new_threads"'),
          `INSERT INTO "__new_threads" (${columns}) SELECT ${columns} FROM "threads"`,
          'DROP TABLE "threads"',
          'ALTER TABLE "__new_threads" RENAME TO "threads"',
          ...indexes,
          "PRAGMA foreign_keys=ON",
        ],
      };
      const before = await counts(client);
      await apply(client, [rebuild]);
      const gone = lost(before, await counts(client));
      assert.ok(gone.messages === before.get("messages") && gone.search_docs === before.get("search_docs"), "every message and search document of the rebuilt threads went");
      assert.ok(gone.attachments && gone.search_people, "and their children");
      assert.equal(gone.threads, undefined, "the rebuilt table itself keeps its rows");

      // libSQL's migrate turns foreign keys off around its transaction: the same rebuild loses nothing there.
      const node = (await filledStore()).client;
      try {
        const kept = await counts(node);
        await node.migrate(rebuild.statements.map((sql) => ({ sql, args: [] })));
        assert.deepEqual(lost(kept, await counts(node)), {});
      } finally {
        node.close();
      }
    } finally {
      client.close();
    }
  });
});
