// Migration 0009 (2026-11-18): the table of Message-IDs the server sent, and the one-off that forgets an inbox's own
// address where earlier builds let it in by themselves (a copy of mail to itself counted as the inbox writing to
// that address). Anyone can write the inbox's address as From, so a let-in own address let every such forgery past
// screening. A block of it stays. A made-up store at migration 0008, then every migration.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

test("forgets each inbox's own address where it was let in, keeps a block and everyone else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-0009-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0008_ai_cost_lookups");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    await migrate(drizzle(client), { migrationsFolder: older });

    const inbox = (id: string, address: string) => ({
      sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES (?, ?, ?, '#000000', 'imap', 'suggest', 'ok', 0, 'x', 1, 1, '0', 'person', ?)",
      args: [id, id, address, id === "inb_a" ? 0 : 1],
    });
    const sender = (inboxId: string, email: string, status: string) => ({
      sql: "INSERT INTO senders (inbox_id, email, status, updated_at, mark) VALUES (?, ?, ?, 0, 'm')",
      args: [inboxId, email, status],
    });
    await client.batch([
      inbox("inb_a", "Me@Acme.example"),
      inbox("inb_b", "other@acme.example"),
      sender("inb_a", "me@acme.example", "known"),
      sender("inb_a", "dana@lumen.example", "known"),
      sender("inb_a", "other@acme.example", "known"),
      sender("inb_b", "other@acme.example", "blocked"),
      sender("inb_b", "me@acme.example", "known"),
    ], "write");

    await migrate(drizzle(client), { migrationsFolder: source });
    const left = await client.execute("SELECT inbox_id, email, status FROM senders ORDER BY inbox_id, email");
    assert.deepEqual(left.rows.map((row) => `${row.inbox_id} ${row.email} ${row.status}`), [
      "inb_a dana@lumen.example known",
      "inb_a other@acme.example known",
      "inb_b me@acme.example known",
      "inb_b other@acme.example blocked",
    ]);
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sent_message_ids'");
    assert.equal(tables.rows.length, 1);
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
