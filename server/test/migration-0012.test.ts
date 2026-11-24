// Migration 0012 (2026-11-19): a receipt's or an invoice's payment details. One column; nothing is marked. A receipt or
// an invoice without details needs them by rule (src/ai/work.ts), so the first start of a build with the rule asks for
// every one that isn't done, trashed or gone, and a build without it that applies the migration changes nothing. A
// made-up store at migration 0011, shaped like the owner's (about 31 receipts and invoices not done).

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createClient, type InStatement } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { and, inArray } from "drizzle-orm";
import { work } from "../src/ai/work.ts";
import { schema, threads } from "../src/db/index.ts";

interface Made {
  category: string;
  done?: boolean;
  trashed?: boolean;
  removed?: boolean;
  summaryDue?: boolean;
}

const many = (count: number, made: Made): Made[] => Array.from({ length: count }, () => made);

/** Asked for their details at the first start. */
const ASKED: Made[] = [...many(25, { category: "receipt" }), ...many(6, { category: "invoice" })];
/** Not asked: done, trashed or gone, or not about money and with no summary due. */
const LEFT: Made[] = [
  ...many(10, { category: "receipt", done: true }),
  ...many(2, { category: "invoice", trashed: true }),
  { category: "receipt", removed: true },
  ...many(40, { category: "notification" }),
  ...many(30, { category: "newsletter" }),
  ...many(12, { category: "conversation" }),
  ...many(3, { category: "otp" }),
];

function rows(made: Made[], offset: number): InStatement[] {
  return made.flatMap((thread, index): InStatement[] => {
    const id = `thr_${String(offset + index).padStart(4, "0")}`;
    return [
      {
        sql: `INSERT INTO threads (id, inbox_id, thread_key, subject, snippet, participants, last_message_at, message_count, unread, has_attachments,
          category, categorized_by, summary, summary_due, done, trashed, removed, created_at) VALUES (?, 'inb_a', ?, 'Made-up', '', '[]', ?, 1, 0, 0, ?, 'ai', 'A made-up summary.', ?, ?, ?, ?, 0)`,
        args: [id, id, 1_000 + index, thread.category, thread.summaryDue ? 1 : 0, thread.done ? 1 : 0, thread.trashed ? 1 : 0, thread.removed ? 1 : 0],
      },
      {
        sql: `INSERT INTO messages (id, thread_id, inbox_id, ref, "references", from_address, to_addresses, cc_addresses, bcc_addresses, date, subject,
          text, unread, outgoing, automated, placement, seen, created_at) VALUES (?, ?, 'inb_a', ?, '[]', '{"email":"shop@shop.example"}', '[]', '[]', '[]', ?, 'Made-up', 'Paid 10.00 EUR.', 0, 0, 1, '{}', 1, 0)`,
        args: [`msg_${id}`, id, `ref_${id}`, 1_000 + index],
      },
    ];
  });
}

test("adds one column and changes nothing; every receipt and invoice not done then needs its details", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-0012-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0011_ask_again");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    await migrate(drizzle(client), { migrationsFolder: older });
    await client.batch([
      {
        sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES ('inb_a', 'A', 'me@acme.example', '#000000', 'imap', 'suggest', 'ok', 0, 'x', 1, 1, '0', 'person', 0)",
        args: [],
      },
      ...rows(ASKED, 0),
      ...rows(LEFT, ASKED.length),
    ], "write");
    const columns = "id, category, categorized_by, summary, summary_due, category_due, done, version";
    const before = await client.execute(`SELECT ${columns} FROM threads ORDER BY id`);

    await migrate(drizzle(client), { migrationsFolder: source });
    assert.deepEqual((await client.execute(`SELECT ${columns} FROM threads ORDER BY id`)).rows, before.rows, "no thread changed");
    assert.equal((await client.execute("SELECT count(*) AS n FROM threads WHERE payment IS NOT NULL")).rows[0]!.n, 0);

    const db = drizzle(client, { schema });
    // Receipts and invoices only: notifications have their own rule since 0016 (migration-0016).
    const due = await db.select({ id: threads.id }).from(threads).where(and(work(), inArray(threads.category, ["receipt", "invoice"]))).orderBy(threads.id);
    assert.deepEqual(due.map((row) => row.id), ASKED.map((_, index) => `thr_${String(index).padStart(4, "0")}`),
      "the 31 receipts and invoices not done, trashed or gone: one request each, nothing else");
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
