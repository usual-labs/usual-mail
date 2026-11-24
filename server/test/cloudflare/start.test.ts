// A start that fails, or that the runtime cuts off, in workerd (start.ts): the requests waiting on it get 503, the object
// is reset and the next request starts again; starts cut off again and again wait longer each time instead of looping;
// and with an inbox, a start that fails in its alarm sets the alarm again, so the server comes back by itself. The test
// entry's migrations fail or are cut off on request (worker/hooks.ts); the deployed ones never are. Attempts are counted
// from the log: any request to a new instance starts it, so a test asks nothing while faults are set.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { plainMessage } from "../../../mail/src/testing/index.ts";
import { ADDRESS, connectGmail, startServer, until, type TestServer } from "./harness.ts";

/** The test entry's backstop (worker/entry.ts). */
const BACKSTOP_MS = 1500;

let server: TestServer;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server?.stop();
});

const setFaults = async (body: { fail?: number; cut?: number }) => {
  assert.equal((await server.call("POST", "/__test/start-faults", body)).status, 200);
};
const attempts = (from: number) => server.logged(/Test migration /, from).length;
const failedStarts = (from: number) => server.logged(/The server couldn't start; the object is reset/, from).length;
const starts = (from: number) => server.logged(/started in its Durable Object/, from).length;
const info = () => server.call("GET", "/v1/info");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a failed start answers 503, resets the object, and the next request starts it again", async () => {
  assert.equal((await info()).status, 200);
  await setFaults({ fail: 1 });
  await server.evict();
  const from = server.logs.length;

  const failed = await info();
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, "internal");
  assert.match(failed.body.error.message, /couldn't start; its log says why/);
  await until("the failure's log line", () => failedStarts(from) === 1);

  // Until the reset the failed instance answers at once, without starting again; then a new instance starts.
  await until("a good start after the reset", async () => (await info()).status === 200, 10_000);
  assert.equal(attempts(from), 2, `one failed start, then a good one:\n${server.logs.slice(from).join("\n")}`);
  assert.equal(starts(from), 1);
  const kv = (await server.call("GET", "/__test/kv")).body as Array<[string, unknown]>;
  assert.ok(!kv.some(([key]) => key === "usual-mail-start"), "a good start clears the record of failures");
});

test("a start cut off again and again waits longer each time, and never loops", async () => {
  await setFaults({ cut: 3 });
  await server.evict();
  const from = server.logs.length;

  // Each request reaches a new instance, whose start is cut off in its migrations, until two failures ask to wait.
  let tries = 0;
  let waiting = await info();
  while (!/tries again after/.test(waiting.body?.error?.message ?? "") && ++tries < 5) waiting = await info();
  assert.equal(waiting.status, 503);
  const cutBeforeWait = attempts(from);
  assert.ok(cutBeforeWait >= 2 && cutBeforeWait <= 3, `cut ${cutBeforeWait} times before waiting:\n${server.logs.slice(from).join("\n")}`);
  // A request while it waits is answered at once, without a try.
  const again = await info();
  assert.match(again.body.error.message, /tries again after/);
  assert.equal(attempts(from), cutBeforeWait, "no start was tried while it waits");
  assert.ok(server.logged(/start waits until .*failed \d+ times in a row \(the last time: it was cut off/, from).length >= 1);

  // Once the wait is over it tries again, and each wait after a further failure is longer.
  await until("a good start", async () => (await info()).status === 200, 20_000);
  assert.equal(attempts(from), 4, server.logs.slice(from).join("\n"));
  const waits = server.logged(/start waits until/, from).map((line) => Number(/failed (\d+) times/.exec(line)?.[1]));
  assert.ok(waits.includes(3), `waited after the third failure too: ${waits.join(", ")}`);
  const kv = (await server.call("GET", "/__test/kv")).body as Array<[string, unknown]>;
  assert.ok(!kv.some(([key]) => key === "usual-mail-start"));
});

test("with an inbox, a start that fails in its alarm sets the alarm again, and the server comes back by itself", async () => {
  const { token } = await server.pair();
  await server.fake.deliver(plainMessage({ from: "Ann <ann@people.example>", to: ADDRESS, subject: "Before the failures" }).raw);
  await connectGmail(server, token);
  await until("the first sync", async () => (await server.call("GET", "/v1/inboxes", undefined, token)).body[0]?.status === "ok");
  await until("the alarm", async () => (await server.call("GET", "/__test/alarm")).body.alarm);

  await setFaults({ fail: 2 });
  const from = server.logs.length;
  await server.evict();
  await server.fake.deliver(plainMessage({ from: "Ann <ann@people.example>", to: ADDRESS, subject: "While it was failing" }).raw);
  // No request until the server is back: only its alarm can bring it back, past two failed starts.
  await until("the server started by its alarm after two failed starts", () => starts(from) === 1, 20_000);
  assert.equal(failedStarts(from), 2, server.logs.slice(from).join("\n"));
  assert.equal(attempts(from), 3);
  assert.ok(server.logged(/started by its alarm/, from).length >= 3, "each try came from the alarm");
  await until("the mail that came meanwhile", async () => {
    const search = await server.call("GET", "/v1/search?q=failing", undefined, token);
    return search.body.items?.[0]?.subject === "While it was failing";
  });
  await until("the alarm armed again", async () => (await server.call("GET", "/__test/alarm")).body.alarm);
  await wait(BACKSTOP_MS);
});
