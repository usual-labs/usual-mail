// Stopping the server while several inboxes' first syncs run (docs/deploy.md, "Time to stop"): every inbox is marked
// closing at once, so none starts another batch once the stop begins, each batch in hand is stored with its cursor,
// and the stop waits for the longest batch in hand, not for each inbox's in turn. A sync asked for once an inbox's
// close has finished, while the stop still waits for another inbox, doesn't run.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { sql } from "drizzle-orm";
import { makeServer, type TestServer } from "./helpers.ts";
import { connectNow, slow } from "./first-sync-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const LONG = "me@long.example";
const SHORT = "me@short.example";
/** Real milliseconds each batch takes: the stop below begins as one of the long mailbox's starts. */
const LONG_MS = 400;
const SHORT_MS = 150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const messageCount = async (s: TestServer, inboxId: string) => (await s.host.db.all<{ n: number }>(
  sql`SELECT count(*) AS n FROM messages WHERE inbox_id = ${inboxId}`,
))[0]!.n;

test("a stop closes every inbox at once: no batch starts once it begins, and it waits for the longest batch in hand", async () => {
  t = await makeServer({ limits: { syncBatch: 2 } });
  const s = t;
  const calls = new Map<string, number>();
  let stopping = false;
  const startedDuringStop: string[] = [];
  let longSecondBegan!: () => void;
  const longSecond = new Promise<void>((resolve) => (longSecondBegan = resolve));
  slow(s, async (_call, _options, address) => {
    if (stopping) startedDuringStop.push(address);
    const n = (calls.get(address) ?? 0) + 1;
    calls.set(address, n);
    if (address === LONG && n === 2) longSecondBegan();
    await sleep(address === LONG ? LONG_MS : SHORT_MS);
  });
  // 40 messages each in batches of 2, far more than the test lets either fetch. The long one is opened first, so a
  // stop closing them in turn would wait for its batch while the short one went on starting its own.
  const long = await connectNow(s, LONG, 40);
  const short = await connectNow(s, SHORT, 40);
  await longSecond;
  // The long mailbox's second batch has just begun; the short one is partway through one of its own.
  stopping = true;
  const began = performance.now();
  await s.server.stop();
  const took = performance.now() - began;

  assert.deepEqual(startedDuringStop, [], "no batch started once the stop began");
  assert.ok(took >= LONG_MS - 50, `the stop waited for the long batch in hand (${Math.round(took)} ms)`);
  assert.ok(took < LONG_MS + SHORT_MS / 2, `and not then for another of the short one's (${Math.round(took)} ms)`);
  // Every batch that started was stored, the batches in hand too.
  assert.equal(calls.get(LONG), 2);
  assert.equal(await messageCount(s, long.id), 4);
  assert.ok(calls.get(SHORT)! >= 2, "the short mailbox fetched several batches before the stop");
  assert.equal(await messageCount(s, short.id), calls.get(SHORT)! * 2);
  assert.deepEqual(s.errors, []);
});

test("a sync asked for after its inbox's close has finished doesn't run while the stop waits for another inbox", async () => {
  t = await makeServer({ limits: { syncBatch: 2 } });
  const s = t;
  let stopping = false;
  const startedDuringStop: string[] = [];
  let longCalls = 0;
  let longSecondBegan!: () => void;
  const longSecond = new Promise<void>((resolve) => (longSecondBegan = resolve));
  slow(s, async (_call, _options, address) => {
    if (stopping) startedDuringStop.push(address);
    if (address === LONG && ++longCalls === 2) longSecondBegan();
    await sleep(address === LONG ? LONG_MS : SHORT_MS);
  });
  await connectNow(s, LONG, 40);
  const short = await connectNow(s, SHORT, 40);
  await longSecond;
  stopping = true;
  const stop = s.server.stop();
  // The short mailbox's batch in hand is stored and its close done, while the long one's batch is still in hand. Then
  // something asks for the short one's sync: "sync now", its watch, a sent draft.
  await sleep(SHORT_MS + 50);
  await s.server.syncInbox(s.person, short.id);
  await stop;

  assert.deepEqual(startedDuringStop, [], "no batch started once the stop began");
  assert.deepEqual(s.errors, []);
});
