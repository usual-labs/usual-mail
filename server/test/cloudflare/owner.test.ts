// The owner's password on Cloudflare, in workerd, after its security review (2026-11-24): a server once used can't be
// claimed again, even with every device revoked (also one whose only devices were revoked before the upgrade); a claim
// ends the owner's code in its table; one IPv4 address and one IPv6 /64 together no longer lock the owner out; ten /64s
// in one /48 are capped by the service's thirty for the /48, past the door's five per /64; it takes a thousand from
// everyone to lock everyone out; and, with an owner email, the Google claim's answer holds no email and its sign-ins are
// capped per CF-Connecting-IP.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BASE, startServer, until, type TestServer } from "./harness.ts";

const PASSWORD = "the owner's long password";

async function post(server: TestServer, path: string, body: unknown, address: string, token?: string) {
  const response = await server.mf.dispatchFetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": address, ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
}

async function ownerCode(server: TestServer): Promise<string> {
  const [row] = await until("an owner's code in its table", async () => {
    const rows = await server.sql<{ code: string }>("SELECT code FROM owner_pairing_code");
    return rows.length ? rows : undefined;
  });
  return row!.code;
}

async function claimable(server: TestServer): Promise<unknown> {
  return (await server.call("GET", "/v1/info")).body.owner;
}

describe("without an owner email", () => {
  let server: TestServer;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server?.stop();
  });

  test("a server whose only device was revoked before the upgrade can't be claimed", async () => {
    assert.deepEqual(await claimable(server), { password: false, claimable: true, claim: "password" });
    const now = Date.now();
    await server.sql("INSERT INTO devices (id, name, kind, inbox_ids, token_hash, created_at, last_seen_at, revoked_at) VALUES ('dev_old', 'Old Mac', 'person', NULL, 'hash-old', ?, NULL, ?)", now, now);
    assert.deepEqual(await claimable(server), { password: false, claimable: false });
    assert.equal((await post(server, "/v1/owner/claim", { password: PASSWORD, name: "Stranger" }, "203.0.113.1")).status, 409);
    // Taken out again (as through Data Studio), the server is new, for the tests below.
    await server.sql("DELETE FROM devices WHERE id = 'dev_old'");
    assert.equal(((await claimable(server)) as { claimable: boolean }).claimable, true);
  });

  test("a claim ends the owner's code that waited", async () => {
    const waiting = await ownerCode(server);
    const claimed = await post(server, "/v1/owner/claim", { password: PASSWORD, name: "Browser" }, "203.0.113.2");
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    await until("the owner's code's row to go", async () => (await server.sql("SELECT code FROM owner_pairing_code")).length === 0);
    const late = await post(server, "/v1/pair", { code: waiting, name: "Late" }, "198.51.100.3");
    assert.equal(late.status, 401, JSON.stringify(late.body));

    // Signing the claiming browser out leaves a password and nothing to claim.
    const me = await server.call("GET", "/v1/me", undefined, claimed.body.token);
    assert.equal((await server.call("DELETE", `/v1/devices/${me.body.id}`, undefined, claimed.body.token)).status, 204);
    assert.deepEqual(await claimable(server), { password: true, claimable: false });
  });

  test("pair, then disconnect: /v1/info says not claimable and a claim answers 409; the owner's code is the way back", async () => {
    const code = await ownerCode(server);
    const paired = await post(server, "/v1/pair", { code, name: "Phone" }, "198.51.100.4");
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    assert.equal((await server.call("DELETE", `/v1/devices/${paired.body.device.id}`, undefined, paired.body.token)).status, 204);
    assert.equal(((await claimable(server)) as { claimable: boolean }).claimable, false);
    assert.equal((await post(server, "/v1/owner/claim", { password: "a stranger's password", name: "Stranger" }, "192.0.2.99")).status, 409);
    assert.notEqual(await ownerCode(server), code, "a new owner's code waits in its table");
  });

  test("five wrong passwords from an IPv4 address and five from an IPv6 /64 don't lock the owner out", async () => {
    const wrong = { password: "not the owner's password", name: "Guess" };
    for (let i = 0; i < 5; i++) assert.equal((await post(server, "/v1/owner/sign-in", wrong, "203.0.113.50")).status, 401);
    assert.equal((await post(server, "/v1/owner/sign-in", wrong, "203.0.113.50")).status, 429, "the door's five per address");
    for (let i = 0; i < 5; i++) assert.equal((await post(server, "/v1/owner/sign-in", wrong, `2001:db8:5:6::${i + 1}`)).status, 401);
    assert.equal((await post(server, "/v1/owner/sign-in", wrong, "2001:db8:5:6::99")).status, 429);
    const owner = await post(server, "/v1/owner/sign-in", { password: PASSWORD, name: "Owner" }, "198.51.100.60");
    assert.equal(owner.status, 200, `the owner signs in from elsewhere: ${JSON.stringify(owner.body)}`);
  });

  test("ten /64s in one /48, three each, meet the service's thirty for the /48; the owner from elsewhere still signs in", async () => {
    for (let n = 0; n < 10; n++) {
      for (let i = 0; i < 3; i++) assert.equal((await post(server, "/v1/pair", { code: "WRONG-CODE", name: "Guess" }, `2001:db8:99:${n}::${i + 1}`)).status, 401);
    }
    const capped = await post(server, "/v1/owner/sign-in", { password: PASSWORD, name: "Owner" }, "2001:db8:99:ff::1");
    assert.equal(capped.status, 429, JSON.stringify(capped.body));
    assert.match(capped.body.error.message, /from your network/);
    for (const address of ["2001:db8:9a::1", "198.51.100.61"]) {
      const owner = await post(server, "/v1/owner/sign-in", { password: PASSWORD, name: "Owner" }, address);
      assert.equal(owner.status, 200, `${address}: ${JSON.stringify(owner.body)}`);
    }
  });
});

describe("the ceiling for everyone", () => {
  let server: TestServer;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server?.stop();
  });

  test("a hundred from twenty addresses no longer lock everyone; a thousand do", async () => {
    assert.equal((await post(server, "/v1/owner/claim", { password: PASSWORD, name: "Browser" }, "192.0.2.1")).status, 200);
    const fail = async (n: number) => {
      const address = `198.${18 + Math.floor(n / 250)}.${n % 250}.1`;
      for (let i = 0; i < 5; i++) assert.equal((await post(server, "/v1/pair", { code: "WRONG-CODE", name: "Guess" }, address)).status, 401, address);
    };
    // The door's five per address, from twenty addresses: the old ceiling of a hundred.
    for (let n = 0; n < 20; n++) await fail(n);
    assert.equal((await post(server, "/v1/owner/sign-in", { password: PASSWORD, name: "Owner" }, "192.0.2.2")).status, 200);
    for (let n = 20; n < 200; n++) await fail(n);
    const locked = await post(server, "/v1/owner/sign-in", { password: PASSWORD, name: "Owner" }, "192.0.2.3");
    assert.equal(locked.status, 429, JSON.stringify(locked.body));
    assert.match(locked.body.error.message, /from everyone together/);
  });
});

describe("with an owner email and a Google client", () => {
  let server: TestServer;
  before(async () => {
    server = await startServer({
      bindings: {
        USUAL_MAIL_PUBLIC_URL: BASE,
        USUAL_MAIL_OWNER_EMAIL: "owner@example.org",
        USUAL_MAIL_GOOGLE_CLIENT_ID: "owner-claim.apps.googleusercontent.example",
        USUAL_MAIL_GOOGLE_CLIENT_SECRET: "GOCSPX-owner-claim-test-secret",
      },
    });
  });
  after(async () => {
    await server?.stop();
  });

  test("the claim's start holds no owner email, and is capped per address while others still start", async () => {
    assert.deepEqual(await claimable(server), { password: false, claimable: true, claim: "google" });
    const first = await post(server, "/v1/owner/claim/google", {}, "203.0.113.70");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const url = new URL(first.body.url);
    assert.equal(url.searchParams.get("login_hint"), null);
    assert.ok(!decodeURIComponent(first.body.url).includes("owner@example.org"), first.body.url);

    for (let i = 0; i < 2; i++) assert.equal((await post(server, "/v1/owner/claim/google", {}, "203.0.113.70")).status, 200);
    const capped = await post(server, "/v1/owner/claim/google", {}, "203.0.113.70");
    assert.equal(capped.status, 429);
    assert.match(capped.body.error.message, /from your address/);
    // A client's own forwarding headers can't move it elsewhere: only CF-Connecting-IP counts.
    const claims = await server.mf.dispatchFetch(`${BASE}/v1/owner/claim/google`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.70", "x-forwarded-for": "192.0.2.1", "x-usual-mail-client-address": "192.0.2.2" },
      body: "{}",
    });
    assert.equal(claims.status, 429);
    assert.equal((await post(server, "/v1/owner/claim/google", {}, "2001:db8:7:8::1")).status, 200, "another address still starts");
  });
});
