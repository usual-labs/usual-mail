// The front Worker and the Worker's variables, in workerd: USUAL_MAIL_TIME_ZONE wins over the first pairing's zone and
// USUAL_MAIL_SYNC_DAYS over a person's setting; an object that throws or is reset gets core's error shape with no
// internals; every answer gets the security headers where the server set none, and keeps its own (the dashboard's, the
// Google page's, an event stream's).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BASE, startServer, until, type TestServer } from "./harness.ts";

let server: TestServer;
let token = "";

before(async () => {
  server = await startServer({ bindings: { USUAL_MAIL_TIME_ZONE: "Asia/Tokyo", USUAL_MAIL_SYNC_DAYS: "45" } });
});

after(async () => {
  if (server) await server.stop();
});

async function kv(key: string): Promise<unknown> {
  const entries = (await server.call("GET", "/__test/kv")).body as Array<[string, unknown]>;
  return entries.find(([name]) => name === key)?.[1];
}

test("USUAL_MAIL_TIME_ZONE wins over the first pairing's zone, which is still kept; USUAL_MAIL_SYNC_DAYS wins too", async () => {
  assert.equal((await server.call("GET", "/v1/info")).status, 200);
  assert.equal(server.logged(/^The server's time zone is Asia\/Tokyo \(USUAL_MAIL_TIME_ZONE\)\.$/).length, 1);
  assert.equal(server.logged(/^A new inbox's first sync takes the last 45 days of mail \(USUAL_MAIL_SYNC_DAYS, which wins over the saved setting\)\.$/).length, 1);
  const [row] = await server.sql<{ code: string }>("SELECT code FROM owner_pairing_code");
  const paired = await server.mf.dispatchFetch(`${BASE}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.40" },
    body: JSON.stringify({ code: row!.code, name: "Front test" }),
    cf: { timezone: "Europe/Berlin" },
  });
  assert.equal(paired.status, 200);
  token = ((await paired.json()) as { token: string }).token;
  await until("the zone line", () => server.logged(/^Kept Europe\/Berlin, where the first person's device paired, as the server's time zone; USUAL_MAIL_TIME_ZONE \(Asia\/Tokyo\) overrides it\.$/).length === 1);
  assert.equal(await kv("usual-mail-time-zone"), "Europe/Berlin");
  const window = await server.call("GET", "/v1/first-sync", undefined, token);
  assert.deepEqual(window.body, { days: 45, setBy: "environment", changeable: false });
});

test("an object that throws or is reset gets core's error shape, with no internals", async () => {
  const thrown = await server.call("POST", "/__test/throw");
  assert.equal(thrown.status, 500);
  assert.deepEqual(thrown.body, { error: { code: "internal", message: "Something went wrong on the server" } });
  assert.equal(thrown.headers.get("cache-control"), "no-store");
  assert.equal(server.logged(/^The server's Durable Object didn't answer POST \/__test\/throw: /).length, 1);

  const reset = await server.call("POST", "/__test/evict");
  assert.ok(reset.status === 500 || reset.status === 503, `status ${reset.status}`);
  assert.equal(reset.body.error.code, "internal");
  assert.doesNotMatch(JSON.stringify(reset.body), /Reset by a test|abort/i);
  for (const answer of [thrown, reset]) assert.doesNotMatch(JSON.stringify(answer.body), /test-internal-detail|Error:|at /);
  assert.equal((await server.call("GET", "/v1/info")).status, 200, "the next request starts a new object");
});

test("adds the security headers where the server set none, and keeps the server's own", async () => {
  const info = await server.call("GET", "/v1/info");
  assert.equal(info.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(info.headers.get("x-content-type-options"), "nosniff");
  assert.equal(info.headers.get("x-frame-options"), "DENY");
  assert.equal(info.headers.get("referrer-policy"), "no-referrer");
  assert.equal(info.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(info.headers.get("cache-control"), "no-store");

  const plain = await server.call("GET", "http://mail.example/v1/info");
  assert.equal(plain.status, 403);
  assert.equal(plain.headers.get("x-content-type-options"), "nosniff");

  // The dashboard's own policy (forms post to itself, so its referrer stays same-origin) is left as it is.
  const dashboard = await server.call("GET", "/sign-in");
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get("content-security-policy") ?? "", /form-action 'self'/);
  assert.equal(dashboard.headers.get("referrer-policy"), "same-origin");
  assert.equal(dashboard.headers.get("strict-transport-security"), "max-age=31536000");

  const callback = await server.call("GET", "/v1/google/callback?state=unknown");
  assert.equal(callback.status, 400);
  assert.match(callback.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(callback.headers.get("x-frame-options"), "DENY");

  // An event stream passes through as a stream, with the headers added.
  const stream = await server.mf.dispatchFetch(`${BASE}/v1/events`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(stream.headers.get("strict-transport-security"), "max-age=31536000");
  const reader = stream.body!.getReader();
  let received = "";
  try {
    await until("the stream to open", async () => {
      const { value } = await reader.read();
      received += new TextDecoder().decode(value);
      return received.includes(": connected");
    });
  } finally {
    await reader.cancel().catch(() => undefined);
  }
});

/**
 * A body sent without Content-Length (chunked): its first few bytes, then nothing more until `release`, as a client could
 * hold one open. (Kept small: a body still being written when workerd answers early and closes the connection makes
 * the client's write fail with EPIPE before it reads the answer, which is the test's transport, not the Worker.)
 */
function heldBody() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(new TextEncoder().encode("{"));
        return;
      }
      await held;
      controller.close();
    },
  });
  return { stream, release };
}

const late = (ms: number) => new Promise<"late">((resolve) => setTimeout(() => resolve("late"), ms));

test("a body without Content-Length is refused with 411 on REST and in a dashboard form, before anything reads it", async () => {
  for (const [path, headers] of [["/v1/pairing-codes", { authorization: `Bearer ${token}` }], ["/v1/no-such-route", {}], ["/v1/pair", {}], ["/v1/%70air", {}], ["/sign-in", {}]] as Array<[string, Record<string, string>]>) {
    const body = heldBody();
    try {
      const answer = await Promise.race([server.mf.dispatchFetch(`${BASE}${path}`, { method: "POST", body: body.stream as never, duplex: "half", headers } as never), late(5_000)]);
      assert.notEqual(answer, "late", `${path} was answered only after its body (it was read)`);
      if (answer === "late") return;
      assert.equal(answer.status, 411, path);
      assert.equal(answer.headers.get("strict-transport-security"), "max-age=31536000");
      const text = await answer.text();
      if (path.startsWith("/v1/")) assert.equal(JSON.parse(text).error.code, "invalid");
    } finally {
      body.release();
    }
  }
  // The same with its length reaches the object, as every app and browser sends it.
  assert.equal((await server.call("POST", "/v1/pairing-codes", { kind: "person" }, token)).status, 200);
});

test("REST without a token is refused by the Worker, before the object wakes, but for the routes that take none", async () => {
  await server.evict();
  const from = server.logs.length;
  const starts = () => server.logged(/started in its Durable Object/, from).length;
  const refused: Array<[string, string, Record<string, string>]> = [
    ["GET", "/v1/me", {}],
    ["GET", "/v1/counts", { authorization: "Bearer someone-elses" }],
    ["GET", "/v1/me", { authorization: `Basic ${btoa("a:b")}` }],
    ["POST", "/v1/no-such-route", {}],
    ["GET", "/v1", {}],
    ["GET", "/v1/messages/m/pictures/p", {}],
  ];
  for (const [method, path, headers] of refused) {
    const answer = await server.call(method, path, method === "POST" ? {} : undefined, undefined, headers);
    assert.equal(answer.status, 401, `${method} ${path}`);
    assert.deepEqual(answer.body, { error: { code: "unauthorized", message: "Sign in with Authorization: Bearer <token> (from POST /v1/pair)" } });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(starts(), 0, "none of them woke the object");
  // The routes that take no token reach it: the server's info (and HEAD), pairing (at any path Hono routes there), the
  // Google callback.
  assert.equal((await server.call("GET", "/v1/info")).status, 200);
  assert.equal(starts(), 1);
  assert.equal((await server.mf.dispatchFetch(`${BASE}/v1/info`, { method: "HEAD" })).status, 200);
  for (const path of ["/v1/pair", "/v1/%70air"]) {
    const wrong = await server.call("POST", path, { code: "ZZZZ-ZZZZ", name: "Front test" });
    assert.equal(wrong.status, 401, path);
    assert.doesNotMatch(wrong.body.error.message, /Bearer/, `${path}: the service's own answer to a wrong code`);
  }
  const callback = await server.call("GET", "/v1/google/callback?state=unknown&code=x");
  assert.notEqual(callback.status, 401);
  assert.match(String(callback.headers.get("content-type")), /text\/html/);
  // A token of the server's own shape reaches the object, which checks it.
  assert.equal((await server.call("GET", "/v1/me", undefined, "umt_not-a-real-token")).status, 401);
  assert.equal((await server.call("GET", "/v1/me", undefined, token)).status, 200);
});
