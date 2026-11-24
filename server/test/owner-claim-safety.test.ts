// The owner's password, after its security review (2026-11-24): a server once used can never be claimed again, even
// after every device is revoked; wrong passwords and codes are counted per client address (an IPv6 address by its /64)
// under a ceiling for everyone; a claim, or a sign-in to a server with no person's device, ends the owner's code; the
// Google claim's answer carries no owner email and its sign-ins are capped per address; and a device's name is one line.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { ServiceError } from "@usualmail/core";
import { sql } from "drizzle-orm";
import { createApp } from "../src/index.ts";
import { MAX_WAITING, MAX_WAITING_PER_ADDRESS } from "../src/google/owner-claim.ts";
import { PAIRING_GLOBAL_LIMIT, PAIRING_LIMIT } from "../src/service/attempts.ts";
import { check, line } from "../src/service/schemas.ts";
import { closeAll, code, googleFor, make, MINUTE, PASSWORD, type Fresh } from "./owner-helpers.ts";

afterEach(closeAll);

const message = (error: unknown) => (error as ServiceError).message;

/** Pairs with the owner's code waiting now. */
async function pairOwner(f: Fresh, name = "Old Mac") {
  return f.server.pair({ code: f.heard.at(-1)!.code!.code, name });
}

describe("a server once used can't be claimed again", () => {
  test("pair, then sign out: not claimable, a claim is refused, and the owner's code is the way back in", async () => {
    const f = await make();
    const paired = await pairOwner(f);
    const me = (await f.server.authenticate(paired.token))!;
    // The browser's "Sign out" and the apps' "Disconnect" revoke the device's own token.
    await f.server.revokeDevice(me, paired.device.id);
    assert.deepEqual((await f.server.info()).owner, { password: false, claimable: false });
    await assert.rejects(f.server.claimOwner({ password: PASSWORD, name: "Stranger" }), (e) => code(e) === "conflict");
    const waiting = f.heard.at(-1)!;
    assert.equal(waiting.kind, "owner");
    assert.ok(waiting.code, "a new owner's code waits where the host keeps it");
    assert.equal((await f.server.pair({ code: waiting.code.code, name: "Back again" })).device.kind, "person");
  });

  test("claimed, then signed out: still not claimable", async () => {
    const f = await make();
    const claimed = await f.server.claimOwner({ password: PASSWORD, name: "Browser" });
    await f.server.revokeDevice((await f.server.authenticate(claimed.token))!, claimed.device.id);
    assert.deepEqual((await f.server.info()).owner, { password: true, claimable: false });
    await assert.rejects(f.server.claimOwner({ password: PASSWORD, name: "Stranger" }), (e) => code(e) === "conflict");
  });

  test("an upgraded server whose devices are all revoked, or that holds an inbox, is not claimable", async () => {
    const f = await make();
    const now = Date.now();
    // As a v0.1.0 server left it: no owner row, one person's device, revoked (and an agent's, revoked too).
    await f.db.run(sql`INSERT INTO devices (id, name, kind, inbox_ids, token_hash, created_at, last_seen_at, revoked_at)
      VALUES ('dev_old', 'Old Mac', 'person', NULL, 'hash-1', ${now}, NULL, ${now}),
             ('dev_agent', 'Agent', 'agent', '[]', 'hash-2', ${now}, NULL, ${now})`);
    assert.deepEqual((await f.server.info()).owner, { password: false, claimable: false });
    await assert.rejects(f.server.claimOwner({ password: PASSWORD, name: "Stranger" }), (e) => code(e) === "conflict");

    const g = await make();
    await g.db.run(sql`INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials)
      VALUES ('inb_1', 'Work', 'me@work.example', '#112233', 'imap', 'normal', 'ok', ${now}, 'sealed')`);
    assert.deepEqual((await g.server.info()).owner, { password: false, claimable: false });
    await assert.rejects(g.server.claimOwner({ password: PASSWORD, name: "Stranger" }), (e) => code(e) === "conflict");
  });

  test("over REST: pair, DELETE the device itself, /v1/info says not claimable, a claim answers 409", async () => {
    const f = await make();
    const app = createApp(f.server, { scheduler: f.clock, log: { info: () => {}, error: () => {} } });
    const paired = await app.request("/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: f.heard.at(-1)!.code!.code, name: "Browser" }),
    });
    const { token, device } = (await paired.json()) as { token: string; device: { id: string } };
    assert.equal((await app.request(`/v1/devices/${device.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status, 204);
    assert.deepEqual(((await (await app.request("/v1/info")).json()) as { owner: unknown }).owner, { password: false, claimable: false });
    const claim = await app.request("/v1/owner/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD, name: "Stranger" }),
    });
    assert.equal(claim.status, 409);
  });
});

describe("wrong passwords and codes count per client address", () => {
  test("ten from one address lock that address only; another still signs in with the right password", async () => {
    const f = await make();
    await f.server.claimOwner({ password: PASSWORD, name: "My Mac" });
    f.client.address = "203.0.113.5";
    for (let i = 0; i < PAIRING_LIMIT / 2; i++) await assert.rejects(f.server.signInOwner({ password: `wrong password ${i}`, name: "x" }));
    for (let i = 0; i < PAIRING_LIMIT / 2; i++) await assert.rejects(f.server.pair({ code: "WRONG-CODE", name: "x" }));
    await assert.rejects(f.server.signInOwner({ password: PASSWORD, name: "x" }), (e) => code(e) === "rate_limited" && /from your address/.test(message(e)));
    await assert.rejects(f.server.pair({ code: "WRONG-CODE", name: "x" }), (e) => code(e) === "rate_limited");

    f.client.address = "198.51.100.20";
    assert.equal((await f.server.signInOwner({ password: PASSWORD, name: "Phone" })).device.kind, "person");
    f.client.address = "::ffff:203.0.113.5";
    await assert.rejects(f.server.signInOwner({ password: PASSWORD, name: "x" }), (e) => code(e) === "rate_limited", "an IPv4-mapped address is the same address");
  });

  test("an IPv6 address counts by its /64; one IPv4 address and one /64 together no longer lock everyone out", async () => {
    const f = await make();
    await f.server.claimOwner({ password: PASSWORD, name: "My Mac" });
    // The reviewer's way round Cloudflare's five per address: five from an IPv4 address, five from an IPv6 /64.
    f.client.address = "203.0.113.5";
    for (let i = 0; i < 5; i++) await assert.rejects(f.server.signInOwner({ password: "not the password", name: "x" }), (e) => code(e) === "unauthorized");
    for (const address of ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:ffff::9", "2001:db8:0001:0002::abc", "2001:db8:1:2:aaaa:bbbb:cccc:dddd"]) {
      f.client.address = address;
      await assert.rejects(f.server.signInOwner({ password: "not the password", name: "x" }), (e) => code(e) === "unauthorized");
    }
    f.client.address = "192.0.2.50";
    assert.equal((await f.server.signInOwner({ password: PASSWORD, name: "Owner" })).device.kind, "person", "the owner still signs in");

    // The same /64 reaches ten; another /64 doesn't share it.
    for (let i = 0; i < 5; i++) {
      f.client.address = `2001:db8:1:2::${i + 10}`;
      await assert.rejects(f.server.signInOwner({ password: "not the password", name: "x" }));
    }
    f.client.address = "2001:db8:1:2::99";
    await assert.rejects(f.server.signInOwner({ password: PASSWORD, name: "x" }), (e) => code(e) === "rate_limited");
    f.client.address = "2001:db8:1:3::1";
    assert.equal((await f.server.signInOwner({ password: PASSWORD, name: "Owner" })).device.kind, "person");
  });

  test("a hundred from everyone together lock everyone, for ten minutes", async () => {
    const f = await make();
    await f.server.claimOwner({ password: PASSWORD, name: "My Mac" });
    for (let n = 0; n < PAIRING_GLOBAL_LIMIT / PAIRING_LIMIT; n++) {
      f.client.address = `198.51.100.${n + 1}`;
      for (let i = 0; i < PAIRING_LIMIT; i++) await assert.rejects(f.server.pair({ code: "WRONG-CODE", name: "x" }), (e) => code(e) === "unauthorized");
    }
    f.client.address = "192.0.2.77";
    await assert.rejects(f.server.signInOwner({ password: PASSWORD, name: "x" }), (e) => {
      assert.equal(code(e), "rate_limited");
      assert.match(message(e), /from everyone together/);
      assert.ok((e as ServiceError).retryAfter! > 0);
      return true;
    });
    f.clock.advance(10 * MINUTE + 1000);
    assert.equal((await f.server.signInOwner({ password: PASSWORD, name: "x" })).device.kind, "person");
  });
});

describe("the owner's code ends when the server gets its first person's device another way", () => {
  test("after a claim, the owner's code that waited no longer pairs", async () => {
    const f = await make();
    const owners = f.heard.at(-1)!.code!;
    await f.server.claimOwner({ password: PASSWORD, name: "Claimer" });
    await assert.rejects(f.server.pair({ code: owners.code, name: "Late" }), (e) => code(e) === "unauthorized");
  });

  test("after signing in with the password while no person's device is paired, the waiting code no longer pairs", async () => {
    const f = await make();
    const claimed = await f.server.claimOwner({ password: PASSWORD, name: "Browser" });
    await f.server.revokeDevice((await f.server.authenticate(claimed.token))!, claimed.device.id);
    const owners = f.heard.at(-1)!;
    assert.equal(owners.kind, "owner");
    await f.server.signInOwner({ password: PASSWORD, name: "Browser again" });
    assert.deepEqual(f.heard.at(-1), { code: null, made: false, kind: "owner" }, "the host removes it");
    await assert.rejects(f.server.pair({ code: owners.code!.code, name: "Late" }), (e) => code(e) === "unauthorized");
  });

  test("a person's code made from a signed-in device still works after another device signs in", async () => {
    const f = await make();
    const claimed = await f.server.claimOwner({ password: PASSWORD, name: "Browser" });
    const made = await f.server.createPairingCode((await f.server.authenticate(claimed.token))!, { kind: "person" });
    await f.server.signInOwner({ password: PASSWORD, name: "Phone" });
    assert.equal((await f.server.pair({ code: made.code, name: "Tablet" })).device.kind, "person");
  });
});

describe("claiming with the owner email through Google", () => {
  test("the answer anyone can ask for doesn't hold the owner's email", async () => {
    const f = await make({ ownerEmail: "owner@example.org", googleFetch: googleFor("owner@example.org") });
    const start = await f.server.startOwnerClaim();
    const url = new URL(start.url);
    assert.equal(url.searchParams.get("login_hint"), null);
    assert.ok(!decodeURIComponent(start.url).toLowerCase().includes("owner@example.org"), start.url);
    assert.ok(!JSON.stringify(start).toLowerCase().includes("owner@example.org"));
  });

  test("waiting sign-ins are capped per address and for everyone, so one address can't block the claim", async () => {
    const f = await make({ ownerEmail: "owner@example.org", googleFetch: googleFor("owner@example.org") });
    f.client.address = "203.0.113.5";
    for (let i = 0; i < MAX_WAITING_PER_ADDRESS; i++) await f.server.startOwnerClaim();
    await assert.rejects(f.server.startOwnerClaim(), (e) => code(e) === "rate_limited" && /from your address/.test(message(e)));
    f.client.address = "2001:db8:1:2::1";
    await f.server.startOwnerClaim();
    f.client.address = "198.51.100.1";
    assert.ok((await f.server.startOwnerClaim()).url, "the owner, from elsewhere, still starts");

    // Everyone's cap is higher: reached only from many addresses.
    let started = MAX_WAITING_PER_ADDRESS + 2;
    for (let n = 2; started < MAX_WAITING; n++) {
      f.client.address = `198.51.100.${n}`;
      for (let i = 0; i < MAX_WAITING_PER_ADDRESS && started < MAX_WAITING; i++, started++) await f.server.startOwnerClaim();
    }
    f.client.address = "192.0.2.1";
    await assert.rejects(f.server.startOwnerClaim(), (e) => code(e) === "rate_limited" && /on this server/.test(message(e)));
    f.clock.advance(10 * MINUTE + 1000);
    assert.ok((await f.server.startOwnerClaim()).url, "they expire after ten minutes");
  });
});

describe("a device's name is one line", () => {
  test("control characters and line separators are refused; the name is quoted in the log", async () => {
    const f = await make();
    for (const name of ["Mac\nThis server now has an owner", "Mac\rx", "Mac\tx", "Mac\u0000x", "Mac\u007fx", "Mac\u0085x", "Mac x", "Mac x", "Mac\u001bx"]) {
      await assert.rejects(f.server.claimOwner({ password: PASSWORD, name }), (e) => code(e) === "invalid", JSON.stringify(name));
      await assert.rejects(f.server.pair({ code: f.heard.at(-1)!.code!.code, name }), (e) => code(e) === "invalid", JSON.stringify(name));
    }
    assert.equal((await f.server.info()).owner.claimable, true, "nothing was paired");
    const claimed = await f.server.claimOwner({ password: PASSWORD, name: '  My "Mac" é ✓ ' });
    assert.equal(claimed.device.name, 'My "Mac" é ✓');
    assert.ok(f.infos.includes('This server now has an owner, claimed from the device "My \\"Mac\\" é ✓".'), f.infos.join("\n"));
    await assert.rejects(f.server.signInOwner({ password: PASSWORD, name: "Phone\nx" }), (e) => code(e) === "invalid");
  });

  test("line() still takes ordinary text, trimmed, and refuses control characters wherever it is used", () => {
    assert.equal(check(line(100), "  Mail from Example (news@example.org) is a newsletter ", "Rule"), "Mail from Example (news@example.org) is a newsletter");
    assert.equal(check(line(100), "Ünïcødé — “quotes” 🙂", "Name"), "Ünïcødé — “quotes” 🙂");
    assert.throws(() => check(line(100), "two\nlines", "Rule"), (e) => code(e) === "invalid" && /control characters/.test(message(e)));
  });
});
