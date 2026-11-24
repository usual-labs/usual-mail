// How search's index reads message bodies (src/search/indexer.ts, doc.ts): only what a thread's entry keeps, newest
// first, a bounded round at a time. Its entries stay exactly what reading every message whole made (the reference
// below is the loop the index ran before 2026-11-21), whatever the round's size; and a catch-up over long threads of
// large mail fits a 128 MB heap, which reading every message of a chunk whole didn't.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { asc, eq, sql } from "drizzle-orm";
import { readingText } from "../src/ai/text.ts";
import { messages, searchDocs } from "../src/db/index.ts";
import { BODY_PER_MESSAGE, BODY_PER_THREAD } from "../src/search/doc.ts";
import { SearchIndex } from "../src/search/indexer.ts";
import { Ctx } from "../src/service/context.ts";
import { at, HOUR, KNOWN, makeServer, type TestServer } from "./helpers.ts";
import type { DeliverInput } from "../src/testing/index.ts";

const ME = "me@bodies.example";
const word = (n: number) => `word${n} `;
const long = (chars: number, seed: number) => Array.from({ length: Math.ceil(chars / 8) }, (_, i) => word((seed * 7919 + i) % 1000)).join("").slice(0, chars);

/** Threads whose bodies take every path: long ones, stubs of HTML, HTML only, astral characters, HTML source as text, unclosed blocks, empty ones. */
function history(): DeliverInput[] {
  const out: DeliverInput[] = [];
  const add = (threadKey: string, count: number, make: (i: number) => Partial<DeliverInput>) => {
    for (let i = 0; i < count; i++) out.push({ from: KNOWN, subject: threadKey, threadKey, date: at(-200 * HOUR + out.length * 60_000), ...make(i) });
  };
  add("Long text", 12, (i) => ({ text: long(25_000 + i * 997, i) }));
  add("Stubs of HTML", 8, (i) => ({ text: "View this email online.", html: `<html><head><style>p{color:red}</style></head><body><p>${long(30_000, i + 50)}</p></body></html>` }));
  add("HTML only", 6, (i) => ({ html: `<div>${long(40_000, i + 90)}</div>&amp; &#x1F600; end` }));
  add("Astral", 9, (i) => ({ text: `${"😀 ".repeat(3_000)}${long(14_000, i + 120)}` }));
  add("HTML source as text", 3, (i) => ({ text: `<html><body><p>${long(22_000, i + 150)}</p></body></html>` }));
  add("Unclosed style", 4, (i) => ({ text: "Short.", html: `<p>${long(5_000, i + 170)}</p><style>${"x{} ".repeat(4_000)}<p>${long(30_000, i + 171)}</p>` }));
  add("Many small", 40, (i) => ({ text: `Small note ${i}: ${long(300, i + 200)}` }));
  add("Empty", 3, () => ({}));
  add("Links", 5, (i) => ({ text: `${"https://track.example/path?q=1#x ".repeat(500)}[read](https://site.example/a) ${long(20_000, i + 260)}` }));
  return out;
}

/** The body column as the index made it before 2026-11-21: every shown message read whole, newest first. */
async function referenceBody(t: TestServer, threadId: string): Promise<string> {
  const list = await t.host.db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(asc(messages.date));
  const shown = list.sort((a, b) => b.date - a.date || (a.id < b.id ? 1 : -1));
  let body = "";
  for (const message of shown) {
    if (body.length >= BODY_PER_THREAD) break;
    const text = readingText(message.text, message.html).slice(0, BODY_PER_MESSAGE);
    if (text) body = body ? `${body} · ${text}` : text;
  }
  return body.slice(0, BODY_PER_THREAD);
}

describe("what the index reads of a thread's bodies", () => {
  test("its entries are what reading every message whole made, whatever the size of a round of bodies", async () => {
    const t = await makeServer();
    try {
      await t.connect({ address: ME, history: history() });
      const threads = await t.host.db.all<{ id: string; subject: string }>(sql`SELECT id, subject FROM threads ORDER BY subject`);
      assert.equal(threads.length, 9);
      const expected = new Map<string, string>();
      for (const thread of threads) expected.set(thread.id, await referenceBody(t, thread.id));
      assert.ok([...expected.values()].some((body) => body.length === BODY_PER_THREAD), "a thread fills its body");
      for (const limits of [{}, { searchReadChars: 1 }, { searchReadChars: 50_000, searchChunk: 2 }, { searchReadChars: 1_000_000, searchChunk: 20, searchInBackground: true }]) {
        await t.host.db.delete(searchDocs);
        const ctx = new Ctx({ ...t.host, limits }, t.providers, t.models, {});
        const index = new SearchIndex(ctx, () => {});
        await index.start();
        await index.fresh();
        index.stop();
        const rows = await t.host.db.all<{ thread: string; body: string }>(sql`SELECT d.thread_id AS thread, i.body AS body FROM search_index i JOIN search_docs d ON d.id = i.rowid`);
        assert.equal(rows.length, threads.length, JSON.stringify(limits));
        for (const row of rows) {
          const subject = threads.find((thread) => thread.id === row.thread)!.subject;
          assert.equal(row.body, expected.get(row.thread), `${subject} with ${JSON.stringify(limits)}`);
        }
      }
    } finally {
      await t.close();
    }
  });

  test("a catch-up over 20 threads of 70 messages of about 81 KB of HTML fits a 128 MB heap", () => {
    const child = fileURLToPath(new URL("./search-memory.child.ts", import.meta.url));
    const run = spawnSync(process.execPath, ["--max-old-space-size=128", child], { encoding: "utf8", timeout: 120_000 });
    assert.equal(run.status, 0, `the catch-up ended with ${run.status ?? run.signal}:\n${run.stderr.slice(-2_000)}`);
    const result = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as { indexed: number; heapMiB: number };
    assert.equal(result.indexed, 21, "the 20 long threads and the first one");
  });
});
