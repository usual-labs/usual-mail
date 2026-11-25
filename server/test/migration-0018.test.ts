// Migration 0018 (2026-11-20, search): two tables and an FTS5 index beside them, a trigger that deletes an index row
// with its search_docs row. It changes no row and fills nothing; the server's first start then builds the index from
// what is stored, by rule (no provider read, no AI request), and logs counts only. A made-up store at 0017.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createClient, type InStatement } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { schema } from "../src/db/index.ts";
import { aesGcmSecrets, FakeModels, MemoryEventBus, ProviderRegistry, webRandom, type Host } from "../src/index.ts";
import { SearchIndex } from "../src/search/indexer.ts";
import { searchLocal } from "../src/search/local.ts";
import { Ctx } from "../src/service/context.ts";
import { ManualClock } from "../src/testing/index.ts";

test("adds search's tables, index and trigger, changes no row; the first start builds the index and logs counts only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-0018-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0017_event_groups");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    await client.execute("PRAGMA foreign_keys = ON");
    await migrate(drizzle(client), { migrationsFolder: older });
    const rows: InStatement[] = Array.from({ length: 40 }, (_, index) => {
      const id = `thr_${String(index).padStart(4, "0")}`;
      return [
        { sql: `INSERT INTO threads (id, inbox_id, thread_key, subject, snippet, participants, last_message_at, message_count, unread, has_attachments,
            category, done, trashed, removed, created_at, sender) VALUES (?, 'inb_a', ?, ?, '', '[]', ?, 1, 0, 0, 'unknown', ?, 0, ?, 0, 'ola@studio.example')`,
          args: [id, id, `Made-up subject ${index}`, 1_000 + index, index % 2, index === 39 ? 1 : 0] },
        { sql: `INSERT INTO messages (id, thread_id, inbox_id, ref, "references", from_address, to_addresses, cc_addresses, bcc_addresses, date, subject,
            text, html, unread, outgoing, automated, placement, seen, created_at) VALUES (?, ?, 'inb_a', ?, '[]', '{"name":"Ola Nordmann","email":"ola@studio.example"}', '[]', '[]', '[]', ?, 'x', ?, ?, 0, 0, 0, '{}', 1, 0)`,
          args: [`msg_${id}`, id, `ref_${id}`, 1_000 + index, index % 3 ? `Made-up words, number ${index}.` : null, index % 3 ? null : `<p>Made-up <b>HTML</b> ${index}</p>`] },
      ];
    }).flat();
    await client.batch([
      { sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES ('inb_a', 'A', 'me@acme.example', '#000000', 'imap', 'suggest', 'ok', 0, 'x', 1, 1, '0', 'person', 0)", args: [] },
      ...rows,
    ], "write");
    const before = await client.execute("SELECT * FROM threads ORDER BY id");
    await migrate(drizzle(client), { migrationsFolder: source });
    // Columns later migrations add aren't this one's to judge.
    const after = (await client.execute("SELECT * FROM threads ORDER BY id")).rows;
    assert.deepEqual(after.map((row, i) => Object.fromEntries(Object.entries(row).filter(([key]) => key in before.rows[i]!))), before.rows.map((row) => ({ ...row })), "no thread changed");
    const made = await client.execute("SELECT type, name FROM sqlite_master WHERE name IN ('search_docs', 'search_people', 'search_index', 'search_docs_delete') ORDER BY name");
    assert.deepEqual(made.rows.map((row) => [row.type, row.name]), [["table", "search_docs"], ["trigger", "search_docs_delete"], ["table", "search_index"], ["table", "search_people"]]);
    assert.equal((await client.execute("SELECT count(*) AS n FROM search_index")).rows[0]!.n, 0, "nothing filled by the migration");

    const clock = new ManualClock("2026-11-20T09:00:00Z");
    const infos: string[] = [];
    const host: Host = {
      db: drizzle(client, { schema }),
      clock,
      scheduler: clock,
      random: webRandom,
      events: new MemoryEventBus(),
      secrets: await aesGcmSecrets(webRandom.bytes(32), webRandom),
      log: { info: (message) => infos.push(message), error: (message) => infos.push(`error: ${message}`) },
    };
    const models = new FakeModels();
    const ctx = new Ctx(host, new ProviderRegistry(), models, {});
    const index = new SearchIndex(ctx, () => {});
    await index.start();
    assert.equal(infos.length, 1);
    assert.match(infos[0]!, /^Search index: 39 threads \(39 messages\) indexed in \d+\.\d s$/, "the removed thread isn't indexed");
    assert.equal(models.requests.length, 0);
    const person = { actor: { kind: "person" as const, deviceId: "dev_1" } };
    assert.equal((await searchLocal(ctx, person, { q: "made-up" }, index)).items.length, 39);
    assert.equal((await searchLocal(ctx, person, { q: "html" }, index)).items.length, 13, "HTML read as text");
    assert.equal((await searchLocal(ctx, person, { q: "nordmann", kinds: ["done"] }, index)).items.length, 19, "done ones, the removed one left out");
    // Removing the inbox takes every entry along: the cascade, and the trigger for the index.
    await client.execute("DELETE FROM inboxes WHERE id = 'inb_a'");
    for (const table of ["search_docs", "search_people", "search_index"]) {
      assert.equal((await client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n, 0, table);
    }
    index.stop();
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
