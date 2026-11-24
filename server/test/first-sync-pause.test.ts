// Pausing or removing an inbox while its first sync runs (docs/contract-sync.md, "How far a first sync has got"): the
// pause or removal answers at once, while the batch in hand is still being fetched; the sync stops once that batch is
// stored (a removed inbox's is dropped), in the background, which waiting for the server's work waits for. The count
// stays where it was shown and no other is sent while it is paused; the first sync isn't done, so resuming goes on from
// the stored cursor, never from 0, its first count again after two seconds, and its mail is still history. A removed
// inbox is gone from lists and events at once, and its address can be added again before its close is done.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Inbox } from "@usualmail/core";
import { sql } from "drizzle-orm";
import { listen, makeServer, type TestServer } from "./helpers.ts";
import { connectNow, said, settlesWithin, slow, stored, syncedProviders } from "./first-sync-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const ADDRESS = "me@pausing.example";

const onlyInbox = async (s: TestServer) => (await s.host.db.all<{ id: string; done: number; cursor: string | null }>(
  sql`SELECT id, history_done AS done, sync_cursor AS cursor FROM inboxes`,
))[0];

const messageCount = async (s: TestServer, inboxId?: string) => (await s.host.db.all<{ n: number }>(
  inboxId === undefined ? sql`SELECT count(*) AS n FROM messages` : sql`SELECT count(*) AS n FROM messages WHERE inbox_id = ${inboxId}`,
))[0]!.n;

test("pausing answers while the batch in hand is fetched; the sync stops once it is stored, keeps its count, and resuming goes on from there", async () => {
  t = await makeServer({ limits: { syncBatch: 2 } });
  const s = t;
  // 20 messages in batches of 2, each batch taking two and a half seconds: ten calls for the whole first sync.
  let calls = 0;
  let answered: boolean | undefined;
  let storedWhenAnswered: number | undefined;
  slow(s, async (call) => {
    calls = call;
    s.clock.advance(2_500);
    if (call !== 2) return;
    // The person pauses it while the second batch is being fetched: the answer doesn't wait for that batch.
    const pausing = s.server.updateInbox(s.person, (await onlyInbox(s))!.id, { paused: true });
    answered = await settlesWithin(pausing, 1_000);
    storedWhenAnswered = await messageCount(s);
  });
  const opened = syncedProviders(s);
  const heard = listen(s);
  const inbox = await connectNow(s, ADDRESS, 20);
  // The sync stops and the provider closes in the background; waiting for the server's work waits for that too.
  await s.server.whenIdle();
  heard.stop();
  assert.equal(answered, true, "the pause answered while the batch in hand was being fetched");
  assert.equal(storedWhenAnswered, 2, "only the first batch was stored when it answered");
  assert.equal(calls, 2, "nothing more was fetched");
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.provider.closed, true, "its provider was closed once the batch in hand was stored");
  // 2 of 20 shown after the first batch; then the pause, which keeps it; then nothing.
  assert.deepEqual(said(heard.events), [
    [1, "connecting", null],
    [2, "connecting", { fetched: 2, total: 20 }],
    [3, "paused", { fetched: 2, total: 20 }],
  ]);
  const row = (await onlyInbox(s))!;
  assert.equal(row.done, 0, "the first sync isn't done");
  assert.ok(row.cursor, "its place is stored");
  assert.deepEqual(await stored(s), { fetched: 2, total: 20 });
  assert.equal(await messageCount(s), 4, "the batch in hand was stored");
  // Time passes while it is paused: nothing is fetched or shown.
  const quiet = listen(s);
  await s.tick(5 * 60_000);
  quiet.stop();
  assert.equal(calls, 2);
  assert.deepEqual(said(quiet.events), []);

  // Resumed: on from the stored cursor (6 of 20 is the first count, never 0), to the end, all of it history.
  const resumed = listen(s);
  await s.server.updateInbox(s.person, inbox.id, { paused: false });
  await s.server.whenIdle();
  resumed.stop();
  assert.equal(calls, 10, "the eight batches left");
  const events = said(resumed.events);
  assert.deepEqual(events[0], [4, "connecting", { fetched: 2, total: 20 }]);
  assert.deepEqual(events.slice(1, -1).map(([, status, count]) => [status, (count as { fetched: number }).fetched]),
    [6, 8, 10, 12, 14, 16, 18].map((fetched) => ["connecting", fetched]));
  assert.deepEqual(events.at(-1)!.slice(1), ["ok", null]);
  assert.equal((await onlyInbox(s))!.done, 1);
  assert.deepEqual(await stored(s), { fetched: null, total: null });
  const threads = await s.host.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM threads WHERE screened = 0`);
  assert.equal(threads[0]!.n, 20, "all of it, as history");
  assert.deepEqual(s.errors, []);
});

test("after resuming, the first count waits two seconds again, as a first sync's first count does", async () => {
  t = await makeServer({ limits: { syncBatch: 2 } });
  const s = t;
  // Each batch takes a second; the person pauses during the third.
  slow(s, async (call) => {
    s.clock.advance(1_000);
    if (call === 3) await settlesWithin(s.server.updateInbox(s.person, (await onlyInbox(s))!.id, { paused: true }), 1_000);
  });
  const heard = listen(s);
  const inbox = await connectNow(s, ADDRESS, 20);
  await s.server.whenIdle();
  heard.stop();
  // 2 of 20 at one second waits; 4 of 20 at two is shown; the third batch is stored, its count not shown.
  assert.deepEqual(said(heard.events), [
    [1, "connecting", null],
    [2, "connecting", { fetched: 4, total: 20 }],
    [3, "paused", { fetched: 4, total: 20 }],
  ]);
  await s.tick(60_000);

  // Resumed a minute later: 8 of 20, one second in, waits; 10 of 20, two seconds in, is the first count shown.
  const resumed = listen(s);
  await s.server.updateInbox(s.person, inbox.id, { paused: false });
  await s.server.whenIdle();
  resumed.stop();
  const events = said(resumed.events);
  assert.deepEqual(events.slice(0, 2), [
    [4, "connecting", { fetched: 4, total: 20 }],
    [5, "connecting", { fetched: 10, total: 20 }],
  ]);
  assert.deepEqual(events.at(-1)!.slice(1), ["ok", null]);
  assert.deepEqual(s.errors, []);
});

test("a pause and a quick resume take effect in order: the inbox opens again once the pause's close is done", async () => {
  t = await makeServer({ limits: { syncBatch: 2 } });
  const s = t;
  let answered: boolean[] = [];
  slow(s, async (call) => {
    s.clock.advance(2_500);
    if (call !== 2) return;
    // Paused while the second batch is fetched, and resumed as soon as that answers.
    const id = (await onlyInbox(s))!.id;
    answered = [
      await settlesWithin(s.server.updateInbox(s.person, id, { paused: true }), 1_000),
      await settlesWithin(s.server.updateInbox(s.person, id, { paused: false }), 1_000),
    ];
  });
  // The pause's close takes a while to stop watching, as an IMAP connection's logout may.
  for (const kind of ["imap", "gmail"] as const) {
    const factory = s.providers.get(kind)!;
    s.providers.register(kind, (credentials, options) => {
      const provider = factory(credentials, options);
      const watch = provider.watch?.bind(provider);
      if (watch) {
        provider.watch = async (onChange) => {
          const stop = await watch(onChange);
          return async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            await stop();
          };
        };
      }
      return provider;
    });
  }
  const opened = syncedProviders(s);
  await connectNow(s, ADDRESS, 20, { watch: true });
  await s.server.whenIdle();
  assert.deepEqual(answered, [true, true]);
  // Opened again only after the pause's close: the first sync went on from the cursor to the end at once, with a
  // provider that close didn't drop.
  assert.equal((await onlyInbox(s))!.done, 1);
  assert.equal(opened.length, 2);
  assert.deepEqual(opened.map((o) => o.cursors.length), [2, 8]);
  assert.deepEqual(opened.map((o) => o.provider.closed), [true, false]);
  assert.deepEqual(s.errors, []);
});

test("removing an inbox during its first sync answers at once: gone from lists and events, the batch in hand dropped, and the address can be added again meanwhile", async () => {
  t = await makeServer({ limits: { syncBatch: 2 } });
  const s = t;
  let removed: string | undefined;
  let answered: boolean | undefined;
  let listedWhenAnswered: Inbox[] | undefined;
  let heardWhenAnswered = false;
  let readded: Inbox | undefined;
  const heard = listen(s);
  slow(s, async (call) => {
    s.clock.advance(2_500);
    if (call !== 2) return;
    removed = (await onlyInbox(s))!.id;
    answered = await settlesWithin(s.server.removeInbox(s.person, removed), 1_000);
    if (!answered) return;
    listedWhenAnswered = await s.server.listInboxes(s.person);
    heardWhenAnswered = heard.events.some((event) => event.type === "inbox.removed" && event.inboxId === removed);
    // Added again while the old close still waits for this batch: a new inbox, no conflict.
    readded = await s.server.connectInbox(s.person, {
      name: ADDRESS, color: "#2F6FED", provider: s.mailboxes.get(ADDRESS)!.kind, credentials: { mailbox: ADDRESS }, trust: "act_with_undo",
    });
    // The batch in hand then fails, as Gmail's does once a removed inbox's sign-in is revoked: nothing to report.
    throw new Error("Token has been expired or revoked.");
  });
  const opened = syncedProviders(s);
  await connectNow(s, ADDRESS, 20);
  await s.server.whenIdle();
  heard.stop();
  assert.equal(answered, true, "the removal answered while the batch in hand was being fetched");
  assert.deepEqual(listedWhenAnswered, [], "and was no longer listed");
  assert.ok(heardWhenAnswered, "and inbox.removed had gone out");
  const at = heard.events.findIndex((event) => event.type === "inbox.removed");
  assert.deepEqual(heard.events.slice(at + 1).filter((event) => "inbox" in event && event.inbox.id === removed), [], "nothing more said of it");
  assert.ok(readded && readded.id !== removed, "the address was added again as a new inbox");
  const [old, fresh] = opened;
  assert.equal(opened.length, 2);
  assert.equal(old!.cursors.length, 2, "the removed inbox's sync stopped with the batch in hand");
  assert.equal(old!.provider.closed, true, "and its provider was closed");
  assert.equal(fresh!.cursors[0], null, "the new inbox's first sync starts from the beginning");
  assert.equal(await messageCount(s, removed), 0, "nothing of the removed inbox kept, the batch in hand included");
  assert.equal(await messageCount(s, readded.id), 20);
  assert.equal(await messageCount(s), 20);
  const rows = await s.host.db.all<{ id: string; done: number }>(sql`SELECT id, history_done AS done FROM inboxes`);
  assert.deepEqual(rows, [{ id: readded.id, done: 1 }]);
  assert.deepEqual(s.errors, []);
});
