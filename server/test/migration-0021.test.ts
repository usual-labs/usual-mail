// Migration 0021 (2026-11-25, when an inbox needs attention, for 0.1.2): the reason with `needs_attention`, when the last
// sync attempt finished, and the run of failures that may pass. Null and 0 on every inbox after the upgrade: an inbox
// that needed attention keeps its words without a reason until its next attempt.

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

test("adds the reason and the run of failures to inboxes, empty, and changes nothing else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-0021-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0020_owner");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    await migrate(drizzle(client), { migrationsFolder: older });
    await client.batch([
      // One inbox that needs attention from before 0.1.2, one that is fine.
      { sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, status_detail, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES ('inb_a', 'A', 'me@acme.example', '#000000', 'imap', 'suggest', 'needs_attention', 'Connection refused', 0, 'x', 3, 1, 'imap1.e30', 'person', 0)", args: [] },
      { sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES ('inb_b', 'B', 'me@bolt.example', '#000000', 'gmail', 'suggest', 'ok', 0, 'x', 4, 1, 'gmail1.e30', 'house', 1)", args: [] },
    ], "write");
    const before = await client.execute("SELECT * FROM inboxes ORDER BY id");
    await migrate(drizzle(client), { migrationsFolder: source });
    const after = await client.execute("SELECT * FROM inboxes ORDER BY id");
    for (const [i, row] of after.rows.entries()) {
      assert.deepEqual([row.status_reason, row.last_attempt_at, row.failing_since, row.failures], [null, null, null, 0]);
      const was = before.rows[i]!;
      assert.deepEqual(Object.fromEntries(Object.entries(row).filter(([key]) => key in was)), { ...was }, "nothing else changed");
    }
    const rows = await drizzle(client, { schema }).select().from(schema.inboxes).all();
    assert.deepEqual(
      rows.map((row) => [toInbox(row).status, toInbox(row).statusDetail, toInbox(row).statusReason]),
      [["needs_attention", "Connection refused", undefined], ["ok", undefined, undefined]],
    );
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
