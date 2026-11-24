// Migration 0019 (2026-11-23, how far a first sync has got): two columns on the inbox, the count the server last showed
// while its first sync runs. Null on every inbox after the upgrade, a first sync in progress included: its count comes
// with its next batch.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { schema } from "../src/db/index.ts";
import { toInbox } from "../src/service/rows.ts";

test("adds the first sync's count to inboxes, empty, and changes nothing else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-0019-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0018_search");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    await migrate(drizzle(client), { migrationsFolder: older });
    await client.batch([
      // One inbox whose first sync is under way, one whose first sync is done.
      { sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES ('inb_a', 'A', 'me@acme.example', '#000000', 'gmail', 'suggest', 'connecting', 0, 'x', 1, 0, 'gmail1.e30', 'person', 0)", args: [] },
      { sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES ('inb_b', 'B', 'me@bolt.example', '#000000', 'imap', 'suggest', 'ok', 0, 'x', 4, 1, 'imap1.e30', 'house', 1)", args: [] },
    ], "write");
    const before = await client.execute("SELECT * FROM inboxes ORDER BY id");
    await migrate(drizzle(client), { migrationsFolder: source });
    const after = await client.execute("SELECT * FROM inboxes ORDER BY id");
    for (const [i, row] of after.rows.entries()) {
      assert.deepEqual([row.first_sync_fetched, row.first_sync_total], [null, null]);
      const was = before.rows[i]!;
      assert.deepEqual(Object.fromEntries(Object.entries(row).filter(([key]) => key in was)), { ...was }, "nothing else changed");
    }
    const rows = await drizzle(client, { schema }).select().from(schema.inboxes).all();
    assert.deepEqual(rows.map((row) => toInbox(row).firstSync), [undefined, undefined], "no count until the next batch says one");
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
