// Migration 0017 (2026-11-19, notification groups): one column, the server-only key that joins a notification to
// others about the same thing, and its index. It changes no row and marks nothing; the server's first start then asks
// every notification that isn't done, trashed or gone for its reference, once (`askEventsAgainOnce`). A made-up store
// at 0016 (165 notifications not done, with the audit's asking-again had).

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createClient, type InStatement } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { askDetailsAgainOnce, askEventsAgainOnce, EVENT_AGAIN } from "../src/ai/ask-again.ts";
import { schema } from "../src/db/index.ts";
import { aesGcmSecrets, FakeModels, MemoryEventBus, ProviderRegistry, webRandom, type Host } from "../src/index.ts";
import { Ctx } from "../src/service/context.ts";
import { ManualClock } from "../src/testing/index.ts";

const EVENT = JSON.stringify({ status: "Out for delivery", about: "A parcel", when: { date: "2026-11-19", time: null, endTime: null } });
const made = [
  ...Array.from({ length: 165 }, () => ({ category: "notification", done: 0, trashed: 0 })),
  ...Array.from({ length: 20 }, () => ({ category: "notification", done: 1, trashed: 0 })),
  ...Array.from({ length: 3 }, () => ({ category: "notification", done: 0, trashed: 1 })),
  ...Array.from({ length: 30 }, () => ({ category: "newsletter", done: 0, trashed: 0 })),
];

test("adds the event key and changes no row; the first start asks every notification not done for its reference, once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-0017-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0016_events");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    await migrate(drizzle(client), { migrationsFolder: older });
    const rows: InStatement[] = made.flatMap((thread, index) => {
      const id = `thr_${String(index).padStart(4, "0")}`;
      return [
        { sql: `INSERT INTO threads (id, inbox_id, thread_key, subject, snippet, participants, last_message_at, message_count, unread, has_attachments,
            category, categorized_by, summary, event, done, trashed, removed, created_at) VALUES (?, 'inb_a', ?, 'Made-up', '', '[]', ?, 1, 0, 0, ?, 'ai', 'A made-up summary.', ?, ?, ?, 0, 0)`,
          args: [id, id, 1_000 + index, thread.category, thread.category === "notification" ? EVENT : null, thread.done, thread.trashed] },
        { sql: `INSERT INTO messages (id, thread_id, inbox_id, ref, "references", from_address, to_addresses, cc_addresses, bcc_addresses, date, subject,
            text, unread, outgoing, automated, placement, seen, created_at) VALUES (?, ?, 'inb_a', ?, '[]', '{"email":"updates@parcels.example"}', '[]', '[]', '[]', ?, 'Made-up', 'Made-up mail.', 0, 0, 1, '{}', 1, 0)`,
          args: [`msg_${id}`, id, `ref_${id}`, 1_000 + index] },
      ];
    });
    await client.batch([
      { sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES ('inb_a', 'A', 'me@acme.example', '#000000', 'imap', 'suggest', 'ok', 0, 'x', 1, 1, '0', 'person', 0)", args: [] },
      { sql: "UPDATE server_state SET details_asked_again = '2026-11-19 event audit'", args: [] },
      ...rows,
    ], "write");
    const before = await client.execute("SELECT * FROM threads ORDER BY id");
    await migrate(drizzle(client), { migrationsFolder: source });
    const after = await client.execute("SELECT * FROM threads ORDER BY id");
    const asBefore = (row: Record<string, unknown>, was: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => key in was));
    assert.deepEqual(after.rows.map((row, i) => asBefore(row, before.rows[i]!)), before.rows.map((row) => ({ ...row })), "no thread changed");
    assert.ok(after.rows.every((row) => row.event_key === null));
    const indexes = await client.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'threads'");
    assert.ok(indexes.rows.some((row) => row.name === "threads_event_key"));

    const clock = new ManualClock("2026-11-19T19:00:00Z");
    const infos: string[] = [];
    const host: Host = {
      db: drizzle(client, { schema }),
      clock,
      scheduler: clock,
      random: webRandom,
      events: new MemoryEventBus(),
      secrets: await aesGcmSecrets(webRandom.bytes(32), webRandom),
      log: { info: (message) => infos.push(message), error: () => {} },
    };
    const ctx = new Ctx(host, new ProviderRegistry(), new FakeModels(), {});
    assert.equal(await askDetailsAgainOnce(ctx), 0, "the payment state's asking-again was had before");
    assert.equal(await askEventsAgainOnce(ctx), 165, "the 165 notifications not done or trashed: one request each");
    const marked = await client.execute("SELECT count(*) AS n FROM threads WHERE payment_again = 1 AND summary_due = 1");
    assert.equal(marked.rows[0]!.n, 165);
    assert.equal((await client.execute("SELECT details_asked_again FROM server_state")).rows[0]!.details_asked_again, EVENT_AGAIN);
    assert.deepEqual(infos, ["The AI is asked again about the events of 165 notifications"], "a count, nothing of the mail");
    assert.equal(await askEventsAgainOnce(ctx), 0, "once");
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
