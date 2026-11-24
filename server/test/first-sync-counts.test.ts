// A first sync's count on its own (src/sync/progress.ts, src/service/rows.ts): its `inbox.changed` reaches the same
// receivers as any other, but doesn't make the server work out every count and the AI's status again, since a count
// alone changes neither (on Cloudflare that would read every thread every two seconds per syncing inbox:
// docs/agents/server-cloudflare-limits.md); a word that comes once the first sync is done, or while the inbox is paused,
// is never shown; and an inbox lists a count only while its first sync runs.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Inbox, MailEvent } from "@usualmail/core";
import { sql } from "drizzle-orm";
import { inboxes } from "../src/db/index.ts";
import { Ctx } from "../src/service/context.ts";
import { toInbox } from "../src/service/rows.ts";
import { FirstSyncCounts } from "../src/sync/progress.ts";
import { listen, makeServer, type TestServer } from "./helpers.ts";
import { history, stored } from "./first-sync-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A server with an inbox whose first sync is still running, and the counts kept on a context of the test's own. */
async function running(): Promise<{ s: TestServer; inbox: Inbox; ctx: Ctx; counts: FirstSyncCounts; settle: () => Promise<void>; touched: () => number }> {
  t = await makeServer();
  const s = t;
  const { inbox } = await s.connect({ address: "me@counts.example", agentAccess: true, history: history(3) });
  await s.host.db.run(sql`UPDATE inboxes SET history_done = 0 WHERE id = ${inbox.id}`);
  const ctx = new Ctx(s.host, s.providers, s.models, {});
  // What tells clients that counts or the AI's status changed: here only how often it was told.
  let touches = 0;
  ctx.changes = { touch: () => void touches++ };
  const work: Array<Promise<unknown>> = [];
  const counts = new FirstSyncCounts(ctx, (promise) => void work.push(promise));
  const settle = async () => {
    await Promise.all(work.splice(0));
  };
  return { s, inbox, ctx, counts, settle, touched: () => touches };
}

const changed = (events: MailEvent[]) => events.flatMap((e) => (e.type === "inbox.changed" ? [[e.inbox.version, e.inbox.firstSync ?? null]] : []));

test("a count alone reaches every receiver that may see the inbox, and nothing is worked out again for it", async () => {
  const { s, inbox, ctx, counts, settle, touched } = await running();
  const { inbox: other } = await s.connect({ address: "me@other.example", agentAccess: true });
  const allowed = await s.agent([inbox.id], "Allowed");
  const elsewhere = await s.agent([other.id], "Elsewhere");
  const person = listen(s);
  const agent = listen(s, allowed.caller);
  const outsider = listen(s, elsewhere.caller);
  counts.begin(inbox.id);
  s.clock.advance(2_000);
  counts.heard(inbox.id, { sent: 3, total: 10 });
  await settle();
  s.clock.advance(2_000);
  counts.heard(inbox.id, { sent: 5, total: 10 });
  await settle();
  for (const heard of [person, agent, outsider]) heard.stop();
  const version = (await s.server.listInboxes(s.person)).find((listed) => listed.id === inbox.id)!.version;
  const expected = [[version - 1, { fetched: 3, total: 10 }], [version, { fetched: 5, total: 10 }]];
  assert.deepEqual(changed(person.events), expected);
  assert.deepEqual(changed(agent.events), expected, "an agent given the inbox hears it as the person does");
  assert.deepEqual(changed(outsider.events), [], "an agent given another inbox doesn't");
  assert.equal(touched(), 0, "no counts or AI status worked out for a count alone");
  // Any other change of the inbox is still noticed.
  ctx.emit({ type: "inbox.changed", inbox: (await s.server.listInboxes(s.person)).find((listed) => listed.id === inbox.id)! });
  assert.equal(touched(), 1);
});

test("a word that comes once the first sync is done, or while the inbox is paused, is never shown", async () => {
  const { s, inbox, counts, settle } = await running();
  const heard = listen(s);
  counts.begin(inbox.id);
  const word = async (sent: number) => {
    s.clock.advance(2_000);
    counts.heard(inbox.id, { sent, total: 10 });
    await settle();
  };
  await s.host.db.run(sql`UPDATE inboxes SET paused = 1 WHERE id = ${inbox.id}`);
  await word(2);
  assert.deepEqual(await stored(s), { fetched: null, total: null }, "paused: kept as it was");
  await s.host.db.run(sql`UPDATE inboxes SET paused = 0, history_done = 1 WHERE id = ${inbox.id}`);
  await word(4);
  assert.deepEqual(await stored(s), { fetched: null, total: null }, "done: nothing more");
  await s.host.db.run(sql`UPDATE inboxes SET history_done = 0 WHERE id = ${inbox.id}`);
  await word(6);
  heard.stop();
  assert.deepEqual(await stored(s), { fetched: 6, total: 10 }, "running: shown");
  assert.deepEqual(changed(heard.events).map(([, count]) => count), [{ fetched: 6, total: 10 }]);
});

test("an inbox lists a count only while its first sync runs, never more fetched than its total, and keeps it while paused", async () => {
  t = await makeServer();
  await t.connect({ address: "me@rows.example" });
  const row = (await t.host.db.select().from(inboxes))[0]!;
  const listed = (change: Partial<typeof row>) => toInbox({ ...row, ...change });
  assert.equal(listed({ historyDone: true, firstSyncFetched: 4, firstSyncTotal: 7 }).firstSync, undefined, "done: a count left over isn't shown");
  assert.deepEqual(listed({ historyDone: false, firstSyncFetched: 4, firstSyncTotal: 7 }).firstSync, { fetched: 4, total: 7 });
  assert.deepEqual(listed({ historyDone: false, firstSyncFetched: 9, firstSyncTotal: 7 }).firstSync, { fetched: 9, total: 9 });
  assert.deepEqual(listed({ historyDone: false, firstSyncFetched: null, firstSyncTotal: 7 }).firstSync, { fetched: 0, total: 7 });
  assert.equal(listed({ historyDone: false, firstSyncFetched: null, firstSyncTotal: null }).firstSync, undefined, "no count yet");
  const paused = listed({ historyDone: false, paused: true, firstSyncFetched: 4, firstSyncTotal: 7 });
  assert.deepEqual([paused.status, paused.firstSync], ["paused", { fetched: 4, total: 7 }]);
});
