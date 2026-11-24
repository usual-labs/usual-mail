// Pairing on Cloudflare, in workerd: the owner's code waits in its table (the dashboard's sign-in page says where); one
// that expired while the object was evicted is removed at start and refused in plain words, counted by nobody; wrong
// codes are counted per client address (CF-Connecting-IP as the front Worker passes it on, an IPv6 address by its /64)
// and the host answers 429 after five, while other addresses still pair and the service keeps its own global lock (a
// percent-encoded path to pairing counted as Hono routes it); and the request that pairs the first person's device
// gives the server its time zone.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BASE, startServer, until, type TestServer } from "./harness.ts";

let server: TestServer;
let token = "";
const codes: string[] = [];

before(async () => {
  server = await startServer();
});

after(async () => {
  if (!server) return;
  try {
    for (const code of codes) assert.ok(!server.logs.some((line) => line.includes(code)), "no owner's code is in a log line");
  } finally {
    await server.stop();
  }
});

const WRONG = "ZZZZ-ZZZZ";

async function ownerCode(): Promise<{ code: string; expires_at: string }> {
  const [row] = await server.sql<{ code: string; expires_at: string }>("SELECT code, expires_at FROM owner_pairing_code");
  assert.ok(row, "an owner's code waits in its table");
  if (!codes.includes(row.code)) codes.push(row.code);
  return row;
}

/** `POST /v1/pair` (or `path`, written another way) from `address`, as Cloudflare's edge would pass it on. */
async function pair(address: string, code: string, o: { headers?: Record<string, string>; timezone?: string; path?: string } = {}) {
  const response = await server.mf.dispatchFetch(`${BASE}${o.path ?? "/v1/pair"}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": address, ...o.headers },
    body: JSON.stringify({ code, name: "Pairing test" }),
    ...(o.timezone && { cf: { timezone: o.timezone } }),
  });
  return { status: response.status, headers: response.headers, body: (await response.json()) as any };
}

/** The dashboard's sign-in with `code`, its form token and cookie taken from the page first. */
async function signIn(address: string, code: string) {
  const form = await server.mf.dispatchFetch(`${BASE}/sign-in`, { headers: { "cf-connecting-ip": address } });
  const page = await form.text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1];
  const cookie = form.headers.getSetCookie().map((line) => line.split(";")[0]!).find((line) => line.includes("usual-mail-sign-in="));
  assert.ok(csrf && cookie, "the sign-in page gives its form token");
  const response = await server.mf.dispatchFetch(`${BASE}/sign-in`, {
    method: "POST",
    redirect: "manual",
    headers: { "cf-connecting-ip": address, origin: BASE, cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, code, name: "Pairing test" }).toString(),
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

async function kv(key: string): Promise<unknown> {
  const entries = (await server.call("GET", "/__test/kv")).body as Array<[string, unknown]>;
  return entries.find(([name]) => name === key)?.[1];
}

test("keeps the owner's code out of the log; the sign-in page says where it waits", async () => {
  assert.equal((await server.call("GET", "/v1/info")).status, 200);
  await ownerCode();
  const page = await server.call("GET", "/sign-in");
  assert.match(page.body, /the server makes an owner&#39;s code: it keeps it out of its log, in the Cloudflare dashboard: Durable Objects, this Worker&#39;s namespace for the class UsualMailServer, Data Studio, the object named &quot;server&quot;, the table owner_pairing_code\./);
  assert.doesNotMatch(page.body, /data folder/);
  assert.equal(server.logged(/^The server's time zone is UTC until the first person's device pairs/).length, 1);
});

test("an owner's code that expired while the object was evicted is removed at start and refused in plain words, uncounted", async () => {
  const old = await ownerCode();
  await server.sql("UPDATE owner_pairing_code SET expires_at = '2026-01-01T00:00:00.000Z'");
  await server.sql("UPDATE pairing_codes SET expires_at = 0 WHERE kind = 'person' AND used_at IS NULL");
  await server.evict();
  const from = server.logs.length;

  const refused = await pair("198.51.100.7", old.code);
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error.code, "unauthorized");
  assert.match(refused.body.error.message, /^That owner's pairing code expired at 2026-01-01T00:00:00\.000Z, so nothing was paired\. A new one is waiting\. Read it in the Cloudflare dashboard: .*owner_pairing_code\.$/);
  assert.equal(server.logged(/^The owner's pairing code in owner_pairing_code expired at 2026-01-01T00:00:00\.000Z while the server was stopped; it was removed, and a new one is made\.$/, from).length, 1);
  const fresh = await ownerCode();
  assert.notEqual(fresh.code, old.code, "a new code replaced it");
  assert.ok(Date.parse(fresh.expires_at) > Date.now());

  // Neither the host's count nor the service's: twelve more tries, then the new code from the same address pairs.
  for (let i = 0; i < 12; i++) assert.equal((await pair("198.51.100.7", old.code)).status, 401);
  const viaDashboard = await signIn("198.51.100.7", old.code);
  assert.equal(viaDashboard.status, 401);
  assert.match(viaDashboard.text, /That owner&#39;s pairing code expired at 2026-01-01T00:00:00\.000Z/);
  assert.match(viaDashboard.text, /<a href="\/sign-in">/);
});

test("five wrong codes from one address get the host's 429, whatever the client claims, while another address pairs", async () => {
  const x = "203.0.113.5";
  for (let i = 0; i < 3; i++) assert.equal((await pair(x, WRONG)).status, 401);
  for (let i = 0; i < 2; i++) assert.equal((await signIn(x, WRONG)).status, 401, "the dashboard's wrong codes count too");

  const limited = await pair(x, WRONG);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "rate_limited");
  assert.match(limited.body.error.message, /^Too many wrong pairing codes from this address\. Try again in \d+ seconds\.$/);
  const retry = Number(limited.headers.get("retry-after"));
  assert.ok(retry >= 1 && retry <= 600, `Retry-After ${retry}`);
  const page = await signIn(x, WRONG);
  assert.equal(page.status, 429);
  assert.match(page.text, /Too many wrong codes from this address\. Wait \d+ minutes, then try again\./);
  // What a client sends can't move it to another count: only CF-Connecting-IP, which Cloudflare's edge sets, counts.
  const claims = { "x-usual-mail-client-address": "192.0.2.200", "x-forwarded-for": "192.0.2.201", "true-client-ip": "192.0.2.202", "x-real-ip": "192.0.2.203" };
  assert.equal((await pair(x, WRONG, { headers: claims })).status, 429);
  const good = await ownerCode();
  assert.equal((await pair(x, good.code)).status, 429, "even a good code waits at that address");

  const paired = await pair("198.51.100.20", good.code, { timezone: "Europe/Berlin" });
  assert.equal(paired.status, 200, JSON.stringify(paired.body));
  token = paired.body.token;
});

test("the request that paired the first person's device gave the server its time zone, kept across a reset", async () => {
  await until("the time zone line", () => server.logged(/^The server's time zone is now Europe\/Berlin, taken from where the first person's device paired/).length === 1);
  assert.equal(await kv("usual-mail-time-zone"), "Europe/Berlin");
  // A later pairing from elsewhere changes nothing.
  const made = await server.call("POST", "/v1/pairing-codes", { kind: "person" }, token);
  assert.equal(made.status, 200);
  assert.equal((await pair("198.51.100.30", made.body.code, { timezone: "Asia/Tokyo" })).status, 200);
  assert.equal(await kv("usual-mail-time-zone"), "Europe/Berlin");
  await server.evict();
  const from = server.logs.length;
  assert.equal((await server.call("GET", "/v1/info")).status, 200);
  await until("the start's time zone line", () => server.logged(/^The server's time zone is Europe\/Berlin, taken from where the first person's device paired/, from).length === 1);
});

test("an IPv6 address is counted by its /64; another /64 reaches the service, which keeps its own global lock", async () => {
  // The reset above forgot both counts.
  for (const address of ["2001:db8:1:2::1", "2001:db8:1:2::1", "2001:db8:1:2::1", "2001:db8:1:2:ffff::9", "2001:db8:0001:0002:0:0:0:abc"]) {
    assert.equal((await pair(address, WRONG)).status, 401, address);
  }
  const sameRange = await pair("2001:db8:1:2:aaaa:bbbb:cccc:dddd", WRONG);
  assert.equal(sameRange.status, 429);
  assert.match(sameRange.body.error.message, /from this address/);
  // Another /64 is passed on: its wrong codes are the service's, up to its global ten.
  for (let i = 0; i < 5; i++) assert.equal((await pair("2001:db8:1:3::1", WRONG)).status, 401);
  const locked = await pair("192.0.2.50", WRONG);
  assert.equal(locked.status, 429);
  assert.match(locked.body.error.message, /^Too many wrong pairing codes\. Try again in \d+ seconds\.$/, "the service's own lock, unchanged");
});

test("pairing at a percent-encoded path is counted per address too, so one address can't reach the service's global lock", async () => {
  await server.evict(); // forgets both counts
  const x = "203.0.113.9";
  // Hono routes all of these to POST /v1/pair; the host counts them as it does.
  for (const path of ["/v1/%70air", "/v1/pai%72", "/v1/%70%61%69%72", "/v1/%70air", "/v1/pair"]) {
    assert.equal((await pair(x, WRONG, { path })).status, 401, path);
  }
  const limited = await pair(x, WRONG, { path: "/v1/%70air" });
  assert.equal(limited.status, 429);
  assert.match(limited.body.error.message, /^Too many wrong pairing codes from this address/, "the host's count, not the service's lock");
  // The service's own lock wasn't reached: another address still gets its answer to a wrong code.
  const other = await pair("198.51.100.77", WRONG);
  assert.equal(other.status, 401, JSON.stringify(other.body));
});

test("a person's first-sync window is kept in the object's storage, across a reset", async () => {
  const first = await server.call("GET", "/v1/first-sync", undefined, token);
  assert.deepEqual(first.body, { days: 30, setBy: "default", changeable: true });
  const changed = await server.call("PATCH", "/v1/first-sync", { days: 60 }, token);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(await kv("usual-mail-sync-days"), 60);
  await server.evict();
  const kept = await server.call("GET", "/v1/first-sync", undefined, token);
  assert.deepEqual(kept.body, { days: 60, setBy: "settings", changeable: true });
});
