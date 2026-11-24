// How far a first sync has got, in workerd (docs/contract-sync.md, "How far a first sync has got"; the owner's decision
// of 2026-11-23): a Gmail first sync of 100 messages in batches of 25 (CLOUDFLARE_LIMITS.syncBatch), slowed so it
// takes seconds, shows its count on the inbox; the object is reset in the middle, as an eviction or a deploy does, and
// the count survives: the inbox's row still lists it, and the first sync goes on from the cursor's count, never from
// 0, until it is done and the count goes. A second inbox is paused while its first sync runs: the pause answers at once,
// without waiting for the batch in hand, which is stored in the background; nothing more is fetched while it is
// paused, and resuming goes on from the cursor.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { decodeGmailCursor } from "../../../mail/src/gmail/cursor.ts";
import { plainMessage } from "../../../mail/src/testing/index.ts";
import { ADDRESS, connectGmail, SECOND_ADDRESS, startServer, until, type TestServer } from "./harness.ts";

const MESSAGES = 100;

let server: TestServer;
let token = "";

before(async () => {
  server = await startServer();
  token = (await server.pair()).token;
});

after(async () => {
  await server?.stop();
});

interface Listed {
  id: string;
  status: string;
  firstSync?: { fetched: number; total: number };
}

const inbox = async (id: string): Promise<Listed | undefined> =>
  ((await server.call("GET", "/v1/inboxes", undefined, token)).body as Listed[]).find((listed) => listed.id === id);

test("a first sync's count is kept across a reset of the object, and goes on from the cursor's", async () => {
  const now = Date.now();
  for (let i = 0; i < MESSAGES; i++) {
    await server.fake.deliver(plainMessage({ from: "Bo <bo@people.example>", to: ADDRESS, subject: `Note ${i}`, body: `Note number ${i}.` }).raw, ["INBOX"], now - (MESSAGES - i) * 60_000);
  }
  // Each of Gmail's answers waits, so a batch of 25 (two requests a message, two at a time) takes over a second.
  server.fake.latencyMs = 100;
  const { id } = await connectGmail(server, token);

  // Past the first batch, and shown (two seconds in).
  const shown = await until("a count past the first batch", async () => {
    const listed = await inbox(id);
    return listed?.firstSync && listed.firstSync.fetched >= 25 && listed.firstSync;
  }, 60_000);
  assert.equal(shown.total, MESSAGES, "the window's 100 messages");
  const [row] = await server.sql<{ fetched: number; total: number; cursor: string; done: number }>(
    "SELECT first_sync_fetched AS fetched, first_sync_total AS total, sync_cursor AS cursor, history_done AS done FROM inboxes",
  );
  assert.equal(row!.done, 0);
  assert.equal(row!.total, MESSAGES, "kept on the inbox's row");
  const committed = decodeGmailCursor(row!.cursor).n ?? 0;
  assert.ok(committed >= 25 && committed < MESSAGES, `the stored cursor counts ${committed}`);

  await server.evict();
  const from = server.logs.length;
  // A request makes a new object; it lists the count the row holds before its own first sync shows another.
  const after = await inbox(id);
  assert.ok(after?.firstSync, `listed after the reset: ${JSON.stringify(after)}`);
  assert.equal(after.firstSync.total, MESSAGES);
  assert.ok(after.firstSync.fetched >= committed, `${after.firstSync.fetched}, not below the cursor's ${committed}`);
  await until("the new object's start", () => server.logged(/started in its Durable Object/, from).length > 0);

  // Watch it go on: every count from here is the cursor's or more, never back to 0, until the first sync is done.
  const seen: number[] = [];
  const done = await until("the first sync to finish", async () => {
    const listed = await inbox(id);
    if (listed?.firstSync) {
      seen.push(listed.firstSync.fetched);
      assert.equal(listed.firstSync.total, MESSAGES);
    }
    return listed?.status === "ok" && !listed.firstSync && listed;
  }, 120_000);
  assert.ok(done);
  assert.ok(seen.every((fetched) => fetched >= committed), `counts after the reset: ${seen.join(", ")}`);
  const [end] = await server.sql<{ fetched: number | null; total: number | null; done: number; messages: number; screened: number }>(
    "SELECT first_sync_fetched AS fetched, first_sync_total AS total, history_done AS done, (SELECT count(*) FROM messages) AS messages, (SELECT count(*) FROM threads WHERE screened = 1) AS screened FROM inboxes",
  );
  assert.deepEqual(end, { fetched: null, total: null, done: 1, messages: MESSAGES, screened: 0 }, "all of it, as history, and the count gone");
});

test("pausing answers at once and stops a first sync once the batch in hand is stored; resuming goes on from the cursor", async () => {
  const account = server.second;
  const now = Date.now();
  for (let i = 0; i < MESSAGES; i++) {
    await account.deliver(plainMessage({ from: "Cy <cy@people.example>", to: SECOND_ADDRESS, subject: `Memo ${i}`, body: `Memo number ${i}.` }).raw, ["INBOX"], now - (MESSAGES - i) * 60_000);
  }
  account.latencyMs = 100;
  const { id } = await connectGmail(server, token, account);
  const row = async () => (await server.sql<{ fetched: number | null; cursor: string | null; done: number }>(
    "SELECT first_sync_fetched AS fetched, sync_cursor AS cursor, history_done AS done FROM inboxes WHERE id = ?", id,
  ))[0]!;
  const asked = () => server.requestLog.filter((request) => request.account === account).length;

  // Paused once it says how far it has got (two seconds in), while a batch is being fetched. Gmail answers slowly
  // meanwhile, so the rest of the batch in hand takes seconds: the PATCH doesn't wait for it.
  await until("a count", async () => (await inbox(id))?.firstSync);
  account.latencyMs = 1_000;
  const began = Date.now();
  const paused = await server.call("PATCH", `/v1/inboxes/${id}`, { paused: true }, token);
  const took = Date.now() - began;
  account.latencyMs = 100;
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, "paused");
  assert.ok(took < 1_000, `answered in ${took} ms, without waiting for the batch in hand`);
  // The batch in hand is stored in the background, then nothing more is asked of Gmail.
  const atPause = await until("the batch in hand stored", async () => {
    const before = asked();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const now = await row();
    return asked() === before && now.cursor !== null && now;
  });
  assert.equal(atPause.done, 0, "the first sync isn't done");
  const committed = decodeGmailCursor(atPause.cursor!).n ?? 0;
  assert.ok(committed >= 25 && committed < MESSAGES, `the batch in hand was stored: the cursor counts ${committed}`);
  // A few seconds later nothing more was asked of Gmail, stored or shown.
  const before = asked();
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.equal(asked(), before, "nothing fetched while paused");
  assert.deepEqual(await row(), atPause);
  assert.equal((await inbox(id))?.status, "paused");

  const resumed = await server.call("PATCH", `/v1/inboxes/${id}`, { paused: false }, token);
  assert.equal(resumed.status, 200);
  const seen: number[] = [];
  await until("the first sync to finish", async () => {
    const listed = await inbox(id);
    if (listed?.firstSync) seen.push(listed.firstSync.fetched);
    return listed?.status === "ok" && !listed.firstSync && listed;
  }, 120_000);
  assert.ok(seen.every((fetched) => fetched >= Math.min(committed, atPause.fetched ?? 0)), `counts after resuming: ${seen.join(", ")}`);
  const [end] = await server.sql<{ done: number; messages: number; screened: number }>(
    "SELECT history_done AS done, (SELECT count(*) FROM messages WHERE inbox_id = ?) AS messages, (SELECT count(*) FROM threads WHERE inbox_id = ? AND screened = 1) AS screened FROM inboxes WHERE id = ?",
    id, id, id,
  );
  assert.deepEqual(end, { done: 1, messages: MESSAGES, screened: 0 }, "all of it, as history");
});
