// Migration 0016 (2026-11-19): one column, a notification's event. It changes no row; a notification without an event
// needs one by rule (src/ai/work.ts), so the first start of a build with the rule asks for every one that isn't done,
// trashed or gone, and a build without it that applies the migration changes nothing. A made-up store at 0015, shaped
// like the owner's (about 155 notifications not done).

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createClient, type InStatement } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { work } from "../src/ai/work.ts";
import { schema, threads } from "../src/db/index.ts";

const made = [
  ...Array.from({ length: 155 }, () => ({ category: "notification", done: 0, trashed: 0 })),
  ...Array.from({ length: 20 }, () => ({ category: "notification", done: 1, trashed: 0 })),
  ...Array.from({ length: 3 }, () => ({ category: "notification", done: 0, trashed: 1 })),
  ...Array.from({ length: 30 }, () => ({ category: "newsletter", done: 0, trashed: 0 })),
];

test("adds the event column and changes no row; every notification not done then needs its event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-0016-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0015_payment_rules");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    await migrate(drizzle(client), { migrationsFolder: older });
    const rows: InStatement[] = made.flatMap((thread, index) => {
      const id = `thr_${String(index).padStart(4, "0")}`;
      return [
        { sql: `INSERT INTO threads (id, inbox_id, thread_key, subject, snippet, participants, last_message_at, message_count, unread, has_attachments,
            category, categorized_by, summary, done, trashed, removed, created_at) VALUES (?, 'inb_a', ?, 'Made-up', '', '[]', ?, 1, 0, 0, ?, 'ai', 'A made-up summary.', ?, ?, 0, 0)`,
          args: [id, id, 1_000 + index, thread.category, thread.done, thread.trashed] },
        { sql: `INSERT INTO messages (id, thread_id, inbox_id, ref, "references", from_address, to_addresses, cc_addresses, bcc_addresses, date, subject,
            text, unread, outgoing, automated, placement, seen, created_at) VALUES (?, ?, 'inb_a', ?, '[]', '{"email":"news@shop.example"}', '[]', '[]', '[]', ?, 'Made-up', 'Made-up mail.', 0, 0, 1, '{}', 1, 0)`,
          args: [`msg_${id}`, id, `ref_${id}`, 1_000 + index] },
      ];
    });
    await client.batch([
      { sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES ('inb_a', 'A', 'me@acme.example', '#000000', 'imap', 'suggest', 'ok', 0, 'x', 1, 1, '0', 'person', 0)", args: [] },
      ...rows,
    ], "write");
    const before = await client.execute("SELECT * FROM threads ORDER BY id");
    await migrate(drizzle(client), { migrationsFolder: source });
    const after = await client.execute("SELECT * FROM threads ORDER BY id");
    const asBefore = (row: Record<string, unknown>, was: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => key in was));
    assert.deepEqual(after.rows.map((row, i) => asBefore(row, before.rows[i]!)), before.rows.map((row) => ({ ...row })), "no thread changed");
    assert.ok(after.rows.every((row) => row.event === null));
    const db = drizzle(client, { schema });
    const due = await db.select({ id: threads.id }).from(threads).where(and(work(), eq(threads.category, "notification")));
    assert.equal(due.length, 155, "the 155 notifications not done or trashed: one request each");
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
