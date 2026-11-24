// Migration 0013 (sender pictures, 2026-11-19) only adds: a table for each domain's site icon, two nullable columns on
// messages (what the provider's checker proved) and one on threads (the picture served). A made-up store at 0012 keeps
// every row as it was; the new columns are empty and the table has no row, so a build without the code that applies
// it changes nothing, and nothing is fetched until the server wants a picture.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

test("adds the sender pictures' table and columns, changing no row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-0013-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    assert.ok(journal.entries.some((entry) => entry.tag === "0013_avatars"), "0013 is in the journal");
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0012_payment");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    await migrate(drizzle(client), { migrationsFolder: older });
    await client.batch([
      {
        sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES ('inb_a', 'A', 'me@acme.example', '#000000', 'gmail', 'suggest', 'ok', 0, 'x', 1, 1, '0', 'person', 0)",
        args: [],
      },
      {
        sql: `INSERT INTO threads (id, inbox_id, thread_key, subject, snippet, participants, last_message_at, message_count, unread, has_attachments,
          category, categorized_by, done, trashed, removed, created_at, sender) VALUES ('thr_1', 'inb_a', 'k', 'Made-up', '', '[]', 1, 1, 0, 0, 'newsletter', 'ai', 0, 0, 0, 0, 'news@shop.example')`,
        args: [],
      },
      {
        sql: `INSERT INTO messages (id, thread_id, inbox_id, ref, "references", from_address, to_addresses, cc_addresses, bcc_addresses, date, subject,
          text, unread, outgoing, automated, placement, seen, created_at) VALUES ('msg_1', 'thr_1', 'inb_a', 'ref_1', '[]', '{"email":"news@shop.example"}', '[]', '[]', '[]', 1, 'Made-up', 'Made-up mail.', 0, 0, 1, '{}', 1, 0)`,
        args: [],
      },
    ], "write");
    const threadsBefore = await client.execute("SELECT * FROM threads");
    const messagesBefore = await client.execute("SELECT * FROM messages");

    await migrate(drizzle(client), { migrationsFolder: source });
    const threadsAfter = await client.execute("SELECT * FROM threads");
    const messagesAfter = await client.execute("SELECT * FROM messages");
    // Only the columns the store had: this one's new columns are checked below, and later migrations add their own.
    const asBefore = (row: Record<string, unknown>, before: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => key in before));
    assert.deepEqual(threadsAfter.rows.map((row, i) => asBefore(row, threadsBefore.rows[i]!)), threadsBefore.rows.map((row) => ({ ...row })), "no thread changed");
    assert.deepEqual(messagesAfter.rows.map((row, i) => asBefore(row, messagesBefore.rows[i]!)), messagesBefore.rows.map((row) => ({ ...row })), "no message changed");
    assert.equal(threadsAfter.rows[0]!.avatar, null);
    assert.deepEqual([messagesAfter.rows[0]!.from_check, messagesAfter.rows[0]!.from_verified], [null, null]);
    assert.equal((await client.execute("SELECT count(*) AS n FROM avatar_sites")).rows[0]!.n, 0);
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
