// Run by search-bodies.test.ts in a Node process with a capped heap: the search index's catch-up over 20 long threads
// (70 messages each, about 81 KB of HTML apiece, 113 MB in all), with the Cloudflare host's index limits. Reading every
// message of a chunk whole, as the index did before 2026-11-21, ran this out of memory under a 128 MB heap. Prints one
// JSON line: the threads indexed and the heap used at the end.

import { sql } from "drizzle-orm";
import { SearchIndex } from "../src/search/indexer.ts";
import { Ctx } from "../src/service/context.ts";
import { makeServer } from "./helpers.ts";

const THREADS = 20;
const MESSAGES = 70;

const t = await makeServer();
await t.connect({ address: "me@limits.example", history: [{ from: { email: "ci@build.example" }, subject: "Template", text: "Template." }] });
const db = t.host.db;
const columns = async (table: string) => (await db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`))).map((column) => column.name);
const quoted = (names: string[]) => names.map((name) => `"${name}"`).join(", ");
const [template] = await db.all<{ id: string; thread_id: string }>(sql.raw("SELECT id, thread_id FROM messages LIMIT 1"));
const threadColumns = await columns("threads");
const messageColumns = await columns("messages");
// 3,000 times 27 characters: about 81 KB of HTML whose text is long, as a build report or a notification might be.
const html = "'<html><body><p>' || replace(hex(zeroblob(3000)), '00', 'Lorem ipsum dolor sit amet ') || '</p></body></html>'";
for (let i = 0; i < THREADS; i++) {
  const thread = threadColumns.map((c) => (c === "id" ? `'long-t${i}'` : c === "thread_key" ? `'long-key${i}'` : c === "message_count" ? String(MESSAGES) : `"${c}"`));
  await db.run(sql.raw(`INSERT INTO threads (${quoted(threadColumns)}) SELECT ${thread.join(", ")} FROM threads WHERE id = '${template!.thread_id}'`));
  const message = messageColumns.map((c) => (c === "id" ? `'long-m${i}-' || n.i` : c === "thread_id" ? `'long-t${i}'` : c === "ref" ? `'long-ref${i}-' || n.i`
    : c === "message_id" ? `'long-${i}-' || n.i || '@build.example'` : c === "date" ? `"date" + n.i` : c === "html" ? html
    : c === "text" ? `'Build report ' || n.i` : `messages."${c}"`));
  await db.run(sql.raw(`INSERT INTO messages (${quoted(messageColumns)}) WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${MESSAGES - 1}) SELECT ${message.join(", ")} FROM messages, n WHERE messages.id = '${template!.id}'`));
}
await db.run(sql`DELETE FROM search_people`);
await db.run(sql`DELETE FROM search_docs`);

const ctx = new Ctx({ ...t.host, limits: { searchChunk: 20, searchReadChars: 1_000_000, searchInBackground: false } }, t.providers, t.models, {});
const index = new SearchIndex(ctx, () => {});
await index.start();
const [{ indexed }] = (await db.all<{ indexed: number }>(sql`SELECT count(*) AS indexed FROM search_docs`)) as [{ indexed: number }];
console.log(JSON.stringify({ indexed, heapMiB: Math.round(process.memoryUsage().heapUsed / 2 ** 20) }));
index.stop();
await t.close();
