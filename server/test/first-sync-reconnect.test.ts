// New credentials while an inbox's first sync runs (docs/contract-sync.md, "A paused inbox"): the change answers at
// once, while the batch in hand is still being fetched; the sync stops once that batch is stored, the old provider is
// closed, and the inbox is opened again with the new credentials, its first sync going on from the stored cursor with
// the count never back to 0. A sync queued before the change never starts with the old provider, and the old
// provider's batch in hand failing leaves the inbox `connecting`, not needing attention.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { sql } from "drizzle-orm";
import { listen, makeServer, type TestServer } from "./helpers.ts";
import { connectNow, said, settlesWithin, slow, stored, syncedProviders } from "./first-sync-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const ADDRESS = "me@reconnecting.example";

const onlyInbox = async (s: TestServer) => (await s.host.db.all<{ id: string; done: number }>(sql`SELECT id, history_done AS done FROM inboxes`))[0]!;

test("new credentials during a first sync answer at once; the sync stops after its batch, the old provider is closed, and the new one goes on from the cursor", async () => {
  t = await makeServer({ limits: { syncBatch: 2 } });
  const s = t;
  let answered: boolean | undefined;
  // 20 messages in batches of 2, each taking two and a half seconds; new credentials while the second is fetched.
  slow(s, async (call) => {
    s.clock.advance(2_500);
    if (call !== 2) return;
    answered = await settlesWithin(s.server.updateInbox(s.person, (await onlyInbox(s)).id, { credentials: { mailbox: ADDRESS } }), 1_000);
  });
  const opened = syncedProviders(s);
  const heard = listen(s);
  await connectNow(s, ADDRESS, 20);
  await s.server.whenIdle();
  heard.stop();
  assert.equal(answered, true, "the change answered while the batch in hand was being fetched");
  assert.equal(opened.length, 2, "the old provider, then the new one");
  const [old, fresh] = opened;
  assert.deepEqual(old!.cursors, [null, "F2"], "the old one stopped after the batch in hand");
  assert.equal(old!.provider.closed, true, "and was closed");
  assert.deepEqual(fresh!.cursors, ["F4", "F6", "F8", "F10", "F12", "F14", "F16", "F18"], "the new one went on from the stored cursor");
  // 2 of 20 shown, kept through the change, then on from there: never back to 0, gone once the first sync is done.
  assert.deepEqual(said(heard.events), [
    [1, "connecting", null],
    [2, "connecting", { fetched: 2, total: 20 }],
    [3, "connecting", { fetched: 2, total: 20 }],
    ...[6, 8, 10, 12, 14, 16, 18].map((fetched, i) => [4 + i, "connecting", { fetched, total: 20 }]),
    [11, "ok", null],
  ]);
  assert.equal((await onlyInbox(s)).done, 1);
  assert.deepEqual(await stored(s), { fetched: null, total: null });
  const threads = await s.host.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM threads WHERE screened = 0`);
  assert.equal(threads[0]!.n, 20, "all of it once, as history");
  assert.deepEqual(s.errors, []);
});

test("a sync queued before new credentials doesn't start with the old provider", async () => {
  t = await makeServer({ limits: { syncBatch: 2 } });
  const s = t;
  let answered: boolean | undefined;
  slow(s, async (call) => {
    s.clock.advance(2_500);
    if (call !== 2) return;
    const id = (await onlyInbox(s)).id;
    // A sync asked for while the second batch is fetched waits behind it; then the credentials change. (A pause can't
    // show this: the queued sync finds the row paused. New credentials leave the row as it was, so only the close says
    // not to start.)
    await s.server.syncInbox(s.person, id);
    answered = await settlesWithin(s.server.updateInbox(s.person, id, { credentials: { mailbox: ADDRESS } }), 1_000);
  });
  const opened = syncedProviders(s);
  await connectNow(s, ADDRESS, 20);
  await s.server.whenIdle();
  assert.equal(answered, true);
  const [old, fresh] = opened;
  assert.deepEqual(old!.cursors, [null, "F2"], "the old provider was asked nothing more");
  assert.equal(old!.provider.closed, true);
  assert.equal(fresh!.cursors[0], "F4");
  assert.equal(opened.length, 2);
  assert.equal((await onlyInbox(s)).done, 1);
  assert.deepEqual(s.errors, []);
});

test("the old provider's batch in hand failing after new credentials leaves the inbox connecting, not needing attention", async () => {
  t = await makeServer({ limits: { syncBatch: 2 } });
  const s = t;
  let statusWhenReopened: string | undefined;
  slow(s, async (call) => {
    s.clock.advance(2_500);
    if (call === 3) statusWhenReopened = (await s.server.listInboxes(s.person))[0]!.status;
    if (call !== 2) return;
    await s.server.updateInbox(s.person, (await onlyInbox(s)).id, { credentials: { mailbox: ADDRESS } });
    // The old credentials stopped working (the reason for new ones): the batch in hand fails.
    throw new Error("Token has been expired or revoked.");
  });
  const opened = syncedProviders(s);
  const heard = listen(s);
  await connectNow(s, ADDRESS, 20);
  await s.server.whenIdle();
  heard.stop();
  const [old, fresh] = opened;
  assert.deepEqual(old!.cursors, [null, "F2"]);
  assert.equal(fresh!.cursors[0], "F2", "the new provider goes on from the last stored batch");
  assert.equal(statusWhenReopened, "connecting", "the change's status stands while the new provider syncs");
  assert.ok(!said(heard.events).some(([, status]) => status === "needs_attention"), "nothing said it needs attention");
  assert.deepEqual(said(heard.events).at(-1)!.slice(1), ["ok", null]);
  assert.equal((await onlyInbox(s)).done, 1);
  assert.deepEqual(s.errors, [], "the old batch's failure isn't an error of the inbox");
  assert.ok(s.infos.some((line) => line.includes("stopped as it was closed: Token has been expired or revoked.")), "only noted");
});
