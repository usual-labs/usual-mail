// Migration 0023 (2026-11-27, unsubscribing from a sender): the unsubscribes table, empty; each message's
// List-Unsubscribe-Post, null for mail stored before; and the browser agent's key and state on the server's own row,
// null, so no browser agent is set up. The AI's settings and everything else stay as they were.

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
import { readBrowserAgent } from "../src/unsubscribe/agent.ts";

test("adds the unsubscribes, empty, the Post header to messages and no browser agent, and changes nothing else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-0023-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0022_skipped_screening");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    await migrate(drizzle(client), { migrationsFolder: older });
    await client.batch([
      { sql: "UPDATE server_state SET ai_paused = 1, settings_version = 7 WHERE id = 1", args: [] },
    ], "write");
    const before = await client.execute("SELECT * FROM server_state");
    await migrate(drizzle(client), { migrationsFolder: source });
    const after = await client.execute("SELECT * FROM server_state");
    const was = before.rows[0]!;
    const row = after.rows[0]!;
    assert.deepEqual(Object.fromEntries(Object.entries(row).filter(([key]) => key in was)), { ...was }, "the AI's settings as they were");
    assert.deepEqual([row.browser_agent_credentials, row.browser_agent_state, row.browser_agent_detail], [null, null, null]);
    const columns = await client.execute("SELECT name FROM pragma_table_info('messages') WHERE name IN ('list_unsubscribe_post', 'signed_unsubscribe')");
    assert.equal(columns.rows.length, 2, "messages gained list_unsubscribe_post and signed_unsubscribe");
    const kept = await client.execute("SELECT name FROM pragma_table_info('unsubscribes') WHERE name IN ('tried', 'marker')");
    assert.equal(kept.rows.length, 2, "an unsubscribe keeps what it started and its run's marker");
    assert.equal((await client.execute("SELECT count(*) AS n FROM unsubscribes")).rows[0]!.n, 0);
    const state = await drizzle(client, { schema }).select().from(schema.serverState).get();
    assert.equal(readBrowserAgent(state!), undefined, "no browser agent is set up");
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
