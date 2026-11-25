// Migration 0022 (2026-11-25, mail that skips Screening): the recipient fields the sender's signature vouches for, on
// messages, and the kind that let a thread skip Screening while its sender isn't let in. Null everywhere after the
// upgrade, so no thread says it skipped Screening, a one-time code that did before included; nothing else changes.

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
import { toThread } from "../src/service/rows.ts";

test("adds the kind to threads and the signed recipients to messages, empty, and changes nothing else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-0022-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0021_sync_health");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    await migrate(drizzle(client), { migrationsFolder: older });
    await client.batch([
      { sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES ('inb_a', 'A', 'me@acme.example', '#000000', 'gmail', 'suggest', 'ok', 0, 'x', 1, 1, 'gmail1.e30', 'person', 0)", args: [] },
      // A stranger's code that skipped Screening before 0022, and a screened thread.
      { sql: "INSERT INTO threads (id, inbox_id, thread_key, subject, snippet, participants, last_message_at, message_count, unread, has_attachments, category, categorized_by, screened, done, trashed, removed, sender, created_at) VALUES ('thr_code', 'inb_a', 'k1', 'Your code', '', '[]', 1, 1, 1, 0, 'otp', 'ai', 0, 0, 0, 0, 'no-reply@quillpad.example', 1)", args: [] },
      { sql: "INSERT INTO threads (id, inbox_id, thread_key, subject, snippet, participants, last_message_at, message_count, unread, has_attachments, category, screened, done, trashed, removed, sender, created_at) VALUES ('thr_new', 'inb_a', 'k2', 'Hello', '', '[]', 2, 1, 1, 0, 'unknown', 1, 0, 0, 0, 'sam@stranger.example', 2)", args: [] },
    ], "write");
    const before = await client.execute("SELECT * FROM threads ORDER BY id");
    await migrate(drizzle(client), { migrationsFolder: source });
    const after = await client.execute("SELECT * FROM threads ORDER BY id");
    for (const [i, row] of after.rows.entries()) {
      assert.equal(row.skipped_screening, null);
      const was = before.rows[i]!;
      assert.deepEqual(Object.fromEntries(Object.entries(row).filter(([key]) => key in was)), { ...was }, "nothing else changed");
    }
    const columns = await client.execute("SELECT name FROM pragma_table_info('messages') WHERE name = 'signed_recipients'");
    assert.equal(columns.rows.length, 1, "messages gained signed_recipients");
    const rows = await drizzle(client, { schema }).select().from(schema.threads).all();
    assert.deepEqual(rows.map((row) => toThread(row).skippedScreening), [undefined, undefined]);
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
