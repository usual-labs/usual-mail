// Migration 0015 (2026-11-19): one column, the marker of the once-only pass of payment rules over stored details
// (src/ai/payment-store.ts). It changes no row: a build without the pass that applies it changes nothing. A made-up
// store at migration 0014 with a receipt's details on it.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

test("adds the pass's marker and changes no row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-0015-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0014_payment_again");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    await migrate(drizzle(client), { migrationsFolder: older });
    await client.batch([
      { sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES ('inb_a', 'A', 'me@acme.example', '#000000', 'imap', 'suggest', 'ok', 0, 'x', 1, 1, '0', 'person', 0)", args: [] },
      {
        sql: `INSERT INTO threads (id, inbox_id, thread_key, subject, snippet, participants, last_message_at, message_count, unread, has_attachments,
          category, categorized_by, done, trashed, removed, created_at, payment) VALUES ('thr_1', 'inb_a', 'k', 'Made-up', '', '[]', 1, 1, 0, 0, 'invoice', 'ai', 0, 0, 0, 0, ?)`,
        args: [JSON.stringify({ party: "Shop | Invoice", amount: null, refund: false, dueDate: "2026-07-11", what: null })],
      },
      { sql: "INSERT OR IGNORE INTO server_state (id) VALUES (1)", args: [] },
    ], "write");
    const before = await client.execute("SELECT * FROM threads");
    await migrate(drizzle(client), { migrationsFolder: source });
    const after = await client.execute("SELECT * FROM threads");
    const asBefore = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => key in before.rows[0]!));
    assert.deepEqual(after.rows.map(asBefore), before.rows.map((row) => ({ ...row })), "no thread changed");
    assert.equal((await client.execute("SELECT payment_rules_applied FROM server_state")).rows[0]!.payment_rules_applied, null);
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
