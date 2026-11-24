// Migration 0011 (2026-11-19) and the asking-again it makes room for (src/ai/ask-again.ts). The migration only adds
// columns, so a build without the code that applies it changes nothing; the marking is done by the server at a start.
// A made-up store at migration 0010 (32 receipts, 5 invoices, 169 notifications and 16 conversations the AI filed and
// nobody has done, 11 of the conversations with nothing the mailbox sent), then every migration, then this build's
// marking on a store that had the first one.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createClient, type InStatement } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { ASK_AGAIN, askAgainOnce } from "../src/ai/ask-again.ts";
import { schema } from "../src/db/index.ts";
import { aesGcmSecrets, FakeModels, MemoryEventBus, ProviderRegistry, webRandom, type Host } from "../src/index.ts";
import { Ctx } from "../src/service/context.ts";
import { ManualClock } from "../src/testing/index.ts";

interface Made {
  category: string;
  by: string | null;
  done?: boolean;
  trashed?: boolean;
  removed?: boolean;
  /** The newest incoming message's text part; the HTML is always a long page. */
  text?: string;
  /** Only the mailbox's own mail, or only a blocked sender's. */
  noIncoming?: "own" | "blocked";
  /** A second message from the inbox's own address: one the mailbox sent, or a forged one with no evidence. */
  wrote?: "sent" | "forged";
}

const PAGE = `<h1>This week</h1><p>${"Three made-up things worth reading this week. ".repeat(20)}</p>`;
const FULL = "Three made-up things worth reading this week, written out in full in the text part as well. ".repeat(5);
const STUB = "View this email online: https://news.example/v/8c1f9e";

function many(count: number, made: Made): Made[] {
  return Array.from({ length: count }, () => made);
}

/** What should be asked again, and what must not be. */
const ASKED: Made[] = [
  ...many(32, { category: "receipt", by: "ai" }),
  ...many(169, { category: "notification", by: "ai" }),
  ...many(10, { category: "conversation", by: "ai" }),
  { category: "conversation", by: "ai", wrote: "forged" },
];
const LEFT: Made[] = [
  ...many(5, { category: "conversation", by: "ai", wrote: "sent" }),
  ...many(5, { category: "invoice", by: "ai" }),
  ...many(2, { category: "newsletter", by: "ai", text: STUB }),
  ...many(120, { category: "newsletter", by: "ai", text: FULL }),
  ...many(3, { category: "newsletter", by: "ai", text: "" }),
  ...many(4, { category: "otp", by: "ai" }),
  ...many(6, { category: "receipt", by: "ai", done: true }),
  ...many(2, { category: "notification", by: "ai", trashed: true }),
  ...many(1, { category: "invoice", by: "ai", removed: true }),
  { category: "receipt", by: "ai", noIncoming: "own" },
  { category: "notification", by: "ai", noIncoming: "blocked" },
  ...many(3, { category: "receipt", by: "person" }),
  ...many(3, { category: "notification", by: "rule" }),
  ...many(2, { category: "invoice", by: "agent" }),
  ...many(4, { category: "receipt", by: "mailbox" }),
  ...many(5, { category: "unknown", by: null }),
];

function rows(made: Made[], offset: number): InStatement[] {
  return made.flatMap((thread, index): InStatement[] => {
    const id = `thr_${String(offset + index).padStart(4, "0")}`;
    const from = thread.noIncoming === "own" ? "me@acme.example" : thread.noIncoming === "blocked" ? "blocked@spam.example" : "news@shop.example";
    const own: InStatement[] = thread.wrote ? [{
      sql: `INSERT INTO messages (id, thread_id, inbox_id, ref, "references", from_address, to_addresses, cc_addresses, bcc_addresses, date, subject,
        text, unread, outgoing, automated, placement, seen, created_at) VALUES (?, ?, 'inb_a', ?, '[]', '{"email":"me@acme.example"}', '[]', '[]', '[]', ?, 'Re: Made-up', 'Made-up reply.', 0, ?, 0, '{}', 1, 0)`,
      args: [`own_${id}`, id, `own_ref_${id}`, 2_000 + index, thread.wrote === "sent" ? 1 : 0],
    }] : [];
    return [
      {
        sql: `INSERT INTO threads (id, inbox_id, thread_key, subject, snippet, participants, last_message_at, message_count, unread, has_attachments,
          category, categorized_by, done, trashed, removed, created_at) VALUES (?, 'inb_a', ?, 'Made-up', '', '[]', ?, 1, 0, 0, ?, ?, ?, ?, ?, 0)`,
        args: [id, id, 1_000 + index, thread.category, thread.by, thread.done ? 1 : 0, thread.trashed ? 1 : 0, thread.removed ? 1 : 0],
      },
      {
        sql: `INSERT INTO messages (id, thread_id, inbox_id, ref, "references", from_address, to_addresses, cc_addresses, bcc_addresses, date, subject,
          text, html, unread, outgoing, automated, placement, seen, created_at) VALUES (?, ?, 'inb_a', ?, '[]', ?, '[]', '[]', '[]', ?, 'Made-up', ?, ?, 0, ?, 1, '{}', 1, 0)`,
        args: [`msg_${id}`, id, `ref_${id}`, JSON.stringify({ email: from }), 1_000 + index, thread.text ?? "Made-up mail.", thread.text === undefined ? null : PAGE, thread.noIncoming === "own" ? 1 : 0],
      },
      ...own,
    ];
  });
}

test("adds two columns and changes nothing; this build's first start then marks the AI's own filings in scope, once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-0011-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0010_held_copies");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    await migrate(drizzle(client), { migrationsFolder: older });
    await client.batch([
      {
        sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor, icon, position) VALUES ('inb_a', 'A', 'me@acme.example', '#000000', 'imap', 'suggest', 'ok', 0, 'x', 1, 1, '0', 'person', 0)",
        args: [],
      },
      { sql: "INSERT INTO senders (inbox_id, email, status, updated_at, mark) VALUES ('inb_a', 'blocked@spam.example', 'blocked', 0, 'm')", args: [] },
      { sql: "INSERT OR IGNORE INTO server_state (id) VALUES (1)", args: [] },
      ...rows(ASKED, 0),
      ...rows(LEFT, ASKED.length),
    ], "write");
    const before = await client.execute("SELECT id, category, categorized_by, category_due, summary_due, done, version FROM threads ORDER BY id");

    await migrate(drizzle(client), { migrationsFolder: source });
    const after = await client.execute("SELECT id, category, categorized_by, category_due, summary_due, done, version, category_ask_again FROM threads ORDER BY id");
    assert.deepEqual(after.rows.map((row) => ({ ...row, category_ask_again: undefined })), before.rows.map((row) => ({ ...row, category_ask_again: undefined })), "no thread changed");
    assert.ok(after.rows.every((row) => row.category_ask_again === 0));
    assert.equal((await client.execute("SELECT categories_asked_again FROM server_state")).rows[0]!.categories_asked_again, null);

    const clock = new ManualClock("2026-11-19T09:00:00Z");
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
    // As on a real store of the time: the first asking-again of 2026-11-19 is done.
    await client.execute("UPDATE server_state SET categories_asked_again = '2026-11-19 sorting words'");
    assert.equal(await askAgainOnce(ctx), 212, "32 receipts + 169 notifications + the 11 conversations nothing the mailbox sent is in");
    const marked = await client.execute("SELECT id FROM threads WHERE category_ask_again = 1 AND category_due = 1 ORDER BY id");
    const expected = ASKED.map((_, index) => `thr_${String(index).padStart(4, "0")}`);
    assert.deepEqual(marked.rows.map((row) => row.id), expected,
      "exactly those: a forged From: me isn't the mailbox writing; nothing the mailbox sent in, nothing a person, a rule, an agent or the mailbox decided");
    assert.equal((await client.execute("SELECT count(*) AS n FROM threads WHERE category_ask_again = 1")).rows[0]!.n, 212);
    assert.equal((await client.execute("SELECT categories_asked_again FROM server_state")).rows[0]!.categories_asked_again, ASK_AGAIN.id);
    assert.deepEqual(infos, ["The AI is asked again about the category of 212 threads it filed"], "a count, nothing of the mail");
    assert.equal(await askAgainOnce(ctx), 0, "once");
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
