// How far a first sync has got (docs/contract-sync.md, "How far a first sync has got"; the owner's decision of
// 2026-11-23): the provider's count, from each batch and while a slow one runs, kept on the inbox as `firstSync` and
// sent as `inbox.changed` once the first sync has run two seconds, then at most every two seconds; kept while the inbox
// needs attention, gone once the first sync is done, also when one sync's rounds ran out before it was (its status
// already ok); each inbox its own. A first sync quicker than that never shows one. Pausing: first-sync-pause.test.ts.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { FIRST_SYNC_PROGRESS_EVERY_MS, type Inbox, type SyncProgress } from "@usualmail/core";
import { sql } from "drizzle-orm";
import { at, HOUR, KNOWN, listen, makeServer, type TestServer } from "./helpers.ts";
import { connectNow, history, said, slow, stored } from "./first-sync-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

test("a long first sync shows how far it has got, once it has run two seconds and then at most that often, and not once it is done", async () => {
  assert.equal(FIRST_SYNC_PROGRESS_EVERY_MS, 2_000);
  t = await makeServer({ limits: { syncBatch: 2 } });
  const s = t;
  // Each batch takes a second and a half.
  slow(s, () => s.clock.advance(1_500));
  const heard = listen(s);
  const { inbox } = await s.connect({ address: "me@progress.example", history: history(7) });
  heard.stop();
  // 2 of 7 at 1.5 s isn't shown yet; 4 of 7 at 3 s is; 6 of 7 at 4.5 s waits; 7 of 7 ends the first sync.
  assert.deepEqual(said(heard.events), [
    [1, "connecting", null],
    [2, "connecting", { fetched: 4, total: 7 }],
    [3, "ok", null],
  ]);
  const listed = (await s.server.listInboxes(s.person)).find((i) => i.id === inbox.id)!;
  assert.equal(listed.firstSync, undefined);
  assert.deepEqual(await stored(s), { fetched: null, total: null }, "nothing is kept once the first sync is done");
  // A later sync says nothing of it.
  s.mailboxes.get("me@progress.example")!.deliver({ from: KNOWN, subject: "New", text: "New mail.", date: at(HOUR) });
  const later = listen(s);
  await s.sync(inbox);
  later.stop();
  assert.deepEqual(said(later.events), []);
  assert.deepEqual(s.errors, []);
});

test("the count is kept on the inbox: listed, kept while it needs attention, and the first sync goes on from it", async () => {
  t = await makeServer({ limits: { syncBatch: 2 } });
  const s = t;
  let failFrom = 3;
  slow(s, (call) => {
    s.clock.advance(2_500);
    const mailbox = s.mailboxes.get("me@progress.example")!;
    // A refused login, so it needs attention at once rather than after the grace.
    mailbox.failSync = call >= failFrom ? "The mail server refused the password" : null;
    mailbox.signInRefused = true;
  });
  const { inbox } = await s.connect({ address: "me@progress.example", history: history(7) });
  // 2 of 7, then 4 of 7, each shown; from the third call on, the mailbox doesn't answer.
  let listed: Inbox = (await s.server.listInboxes(s.person)).find((i) => i.id === inbox.id)!;
  assert.deepEqual([listed.status, listed.firstSync], ["needs_attention", { fetched: 4, total: 7 }]);
  assert.deepEqual(await stored(s), { fetched: 4, total: 7 });
  failFrom = Number.POSITIVE_INFINITY;
  const heard = listen(s);
  await s.sync(inbox);
  heard.stop();
  listed = (await s.server.listInboxes(s.person)).find((i) => i.id === inbox.id)!;
  assert.deepEqual([listed.status, listed.firstSync], ["ok", undefined]);
  // From 4, not from the start: 6 of 7, then done.
  assert.deepEqual(said(heard.events).map(([, status, count]) => [status, count]), [["needs_attention", { fetched: 6, total: 7 }], ["ok", null]]);
  const threads = await s.host.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM threads WHERE screened = 0`);
  assert.equal(threads[0]!.n, 7, "all of it, as history");
});

test("a slow batch's word is shown while it runs, and the batch's own when it is due", async () => {
  t = await makeServer({ limits: { syncBatch: 3 } });
  const s = t;
  const words: SyncProgress[] = [{ sent: 0, total: 8 }, { sent: 1, total: 8 }, { sent: 2, total: 8 }];
  slow(s, async (call, options) => {
    if (call !== 1) return s.clock.advance(2_100);
    // The first batch, as Gmail's: the window listed, then one message at a time, each taking a second.
    for (const word of words) {
      options?.onProgress?.(word);
      s.clock.advance(1_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  const heard = listen(s);
  await s.connect({ address: "me@progress.example", history: history(8) });
  heard.stop();
  assert.deepEqual(said(heard.events), [
    [1, "connecting", null],
    // 0 of 8 at the start and 1 of 8 a second later: not yet. 2 of 8 at two seconds, while the batch runs.
    [2, "connecting", { fetched: 2, total: 8 }],
    // The first batch's own word (3 of 8) came a second later and waited; the second batch's (6 of 8), 2.1 s on, didn't.
    [3, "connecting", { fetched: 6, total: 8 }],
    // The third ended the first sync.
    [4, "ok", null],
  ]);
});

test("a first sync quicker than two seconds shows no count, and changes its inbox's version only from connecting to ok", async () => {
  t = await makeServer({ limits: { syncBatch: 2 } });
  const heard = listen(t);
  await t.connect({ address: "me@quick.example", history: history(7) });
  heard.stop();
  assert.deepEqual(said(heard.events), [[1, "connecting", null], [2, "ok", null]]);
  assert.deepEqual(await stored(t), { fetched: null, total: null });
});

test("a first sync longer than one sync's rounds says ok with its count, and dropping the count is still a change", async () => {
  // Two batches a sync: 9 messages in batches of 2 take three syncs.
  t = await makeServer({ limits: { syncBatch: 2 }, syncRounds: 2 });
  const s = t;
  slow(s, () => s.clock.advance(2_500));
  const heard = listen(s);
  await s.connect({ address: "me@rounds.example", history: history(9) });
  heard.stop();
  assert.deepEqual(said(heard.events), [
    [1, "connecting", null],
    [2, "connecting", { fetched: 2, total: 9 }],
    [3, "connecting", { fetched: 4, total: 9 }],
    // The first sync's rounds ran out: ok, still with its count (contract-sync.md).
    [4, "ok", { fetched: 4, total: 9 }],
    [5, "ok", { fetched: 6, total: 9 }],
    [6, "ok", { fetched: 8, total: 9 }],
    // Done while the status was already ok: the count going is a change of its own, with a version and an event.
    [7, "ok", null],
  ]);
  assert.deepEqual(await stored(s), { fetched: null, total: null });
  const listed = (await s.server.listInboxes(s.person))[0]!;
  assert.deepEqual([listed.version, listed.status, listed.firstSync], [7, "ok", undefined]);
  assert.deepEqual(s.errors, []);
});

test("several inboxes' first syncs at once: each shows its own count, on its own clock, and drops it when it is done", async () => {
  t = await makeServer({ limits: { syncBatch: 2 } });
  const s = t;
  // Each batch takes a second and a quarter, whichever inbox it is for; the clock is the server's, shared.
  slow(s, () => s.clock.advance(1_250));
  const heard = listen(s);
  const work = await connectNow(s, "me@work.example", 12);
  const home = await connectNow(s, "me@home.example", 7);
  await s.server.whenIdle();
  heard.stop();
  for (const [inbox, total] of [[work, 12], [home, 7]] as const) {
    const events = said(heard.events, inbox.id);
    const counts = events.flatMap(([, , count]) => (count ? [count as { fetched: number; total: number }] : []));
    assert.ok(counts.length >= 2, `${inbox.address} showed ${JSON.stringify(events)}`);
    assert.ok(counts.every((count) => count.total === total), `${inbox.address}: its own total`);
    assert.deepEqual(counts.map((count) => count.fetched), [...counts.map((count) => count.fetched)].sort((a, b) => a - b), "never back");
    assert.deepEqual(events.map(([version]) => version), events.map((_, i) => i + 1), "each change its own version");
    assert.deepEqual(events.at(-1)!.slice(1), ["ok", null]);
    assert.deepEqual(await stored(s, inbox.id), { fetched: null, total: null });
  }
  const threads = await s.host.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM threads WHERE screened = 0`);
  assert.equal(threads[0]!.n, 19, "all of both, as history");
  assert.deepEqual(s.errors, []);
});
