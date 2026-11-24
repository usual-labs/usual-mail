// Evictions in workerd: before pairing the object has no alarm, and the owner's code it showed survives a reset (read
// back from owner_pairing_code and kept, not made again); once an inbox is connected the alarm stays armed, and after a
// reset the alarm alone brings the server back, which syncs again without any request.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { plainMessage } from "../../../mail/src/testing/index.ts";
import { ADDRESS, connectGmail, startServer, until, type TestServer } from "./harness.ts";

/** The test entry's backstop (worker/entry.ts): the alarm is kept at most this far ahead. */
const BACKSTOP_MS = 1500;

let server: TestServer;
let code = "";
let token = "";

before(async () => {
  server = await startServer();
});

after(async () => {
  if (server) {
    if (code) assert.ok(!server.logs.some((line) => line.includes(code)), "the owner's code is in no log line");
    await server.stop();
  }
});

const starts = () => server.logged(/started in its Durable Object/).length;
const alarm = async () => (await server.call("GET", "/__test/alarm")).body as { alarm: number | null; now: number };

test("keeps the owner's code across a reset before pairing, and pairs with the first code", async () => {
  assert.equal((await server.call("GET", "/v1/info")).status, 200);
  const [first] = await server.sql<{ code: string; expires_at: string }>("SELECT code, expires_at FROM owner_pairing_code");
  code = first!.code;
  await until("the first start's lines", () => server.logged(/An owner's pairing code is waiting/).length === 1);
  assert.equal((await alarm()).alarm, null, "no alarm while no inbox is connected");

  await server.evict();
  const from = server.logs.length;
  assert.equal((await server.call("GET", "/v1/info")).status, 200, "a request makes a new object");
  await until("the second start", () => starts() === 2);
  await until("the kept code's lines", () => server.logged(/made at an earlier start is still waiting/, from).length === 1);
  assert.equal(server.logged(/An owner's pairing code is waiting/, from).length, 0, "no new code was made");
  const rows = await server.sql<{ code: string; expires_at: string }>("SELECT code, expires_at FROM owner_pairing_code");
  assert.deepEqual(rows, [first], "the same code waits, with the same expiry");

  const paired = await server.call("POST", "/v1/pair", { code, name: "After a reset" });
  assert.equal(paired.status, 200, JSON.stringify(paired.body));
  token = paired.body.token;
  await until("the code's row to go", async () => (await server.sql("SELECT * FROM owner_pairing_code")).length === 0);
});

test("with an inbox, the alarm restarts a reset object, which syncs again by itself", async () => {
  await server.fake.deliver(plainMessage({ from: "Ann <ann@people.example>", to: ADDRESS, subject: "Before the reset" }).raw);
  const inbox = await connectGmail(server, token);
  await until("the first sync", async () => (await server.call("GET", "/v1/inboxes", undefined, token)).body[0]?.status === "ok");
  const armed = await until("the alarm", async () => {
    const { alarm: at, now } = await alarm();
    return at !== null && at > now && at <= now + BACKSTOP_MS && at;
  });
  assert.ok(armed);

  // Mail arrives while the object is gone; only the alarm can bring the server back to fetch it.
  const before = starts();
  const from = server.logs.length;
  await server.evict();
  const resetAt = Date.now();
  await server.fake.deliver(plainMessage({ from: "Ann <ann@people.example>", to: ADDRESS, subject: "While it was away" }).raw);
  // No request until the alarm has restarted the server: its start line, then the fake hears from it.
  const tokens = server.fake.tokenRequests.length;
  await until("the alarm to restart the server", () => starts() === before + 1, 10_000);
  const restartedIn = Date.now() - resetAt;
  assert.equal(server.logged(/started by its alarm/, from).length, 1, `the alarm, not a request, made the new object: ${server.logs.slice(from).join("\n")}`);
  await until("the restarted server to reach Gmail", () => server.fake.tokenRequests.length > tokens, 10_000);
  await until("the mail that came while it was away", async () => {
    const search = await server.call("GET", "/v1/search?q=away", undefined, token);
    return search.body.items?.[0]?.subject === "While it was away";
  });
  assert.ok(restartedIn < BACKSTOP_MS + 5_000, `restarted ${restartedIn} ms after the reset`);
  const again = await until("the alarm armed again", async () => (await alarm()).alarm);
  assert.ok(again > resetAt);
  const inboxes = await server.call("GET", "/v1/inboxes", undefined, token);
  assert.equal(inboxes.body[0].id, inbox.id);
});
