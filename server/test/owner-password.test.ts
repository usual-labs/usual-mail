// The owner's password (docs/contract.md, "The owner's password"): claiming an unclaimed server, signing in with the
// password, the limit it shares with pairing codes, setting it from a signed-in device, recovery codes kept where the
// owner's code is, and claiming with Google's proof of the host's owner email. Through the service and through REST.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { ServiceError } from "@usualmail/core";
import { createApp, webRandom } from "../src/index.ts";
import { verifiedEmail } from "../src/google/oauth.ts";
import { hashPassword, passwordMatches } from "../src/service/password.ts";
import { ownerEmailSetting } from "../src/service/owner.ts";
import { START } from "./helpers.ts";
import { CLIENT, closeAll, code, googleFor, make, MINUTE, PASSWORD, type Fresh } from "./owner-helpers.ts";

afterEach(closeAll);

describe("claiming an unclaimed server", () => {
  test("the first to claim it owns it, its device is a person's, and the owner's code is done with", async () => {
    const f = await make();
    assert.deepEqual((await f.server.info()).owner, { password: false, claimable: true, claim: "password" });
    assert.equal(f.heard.at(-1)?.code !== null, true, "an owner's code waits");

    await assert.rejects(f.server.claimOwner({ password: "short", name: "My Mac" }), (e) => code(e) === "invalid");
    const claimed = await f.server.claimOwner({ password: PASSWORD, name: "My Mac", email: "Me@Example.org " });
    assert.equal(claimed.device.kind, "person");
    const caller = (await f.server.authenticate(claimed.token))!;
    assert.deepEqual(await f.server.owner(caller), { email: "me@example.org", password: true, passwordSetAt: START });
    assert.deepEqual((await f.server.info()).owner, { password: true, claimable: false });
    assert.deepEqual(f.heard.at(-1), { code: null, made: false, kind: "owner" }, "the host drops the owner's code");
    assert.ok(f.infos.some((line) => line.includes("now has an owner") && line.includes("My Mac")), "the claim is logged");

    await assert.rejects(f.server.claimOwner({ password: PASSWORD, name: "Someone else" }), (e) => code(e) === "conflict");
  });

  test("a server paired before the password existed can't be claimed; a signed-in device sets the password", async () => {
    const f = await make();
    const owners = f.heard.at(-1)!.code!;
    const paired = await f.server.pair({ code: owners.code, name: "Old Mac" });
    assert.deepEqual((await f.server.info()).owner, { password: false, claimable: false });
    await assert.rejects(f.server.claimOwner({ password: PASSWORD, name: "Stranger" }), (e) => code(e) === "conflict");
    await assert.rejects(f.server.signInOwner({ password: PASSWORD, name: "Phone" }), (e) => code(e) === "conflict");

    const person = (await f.server.authenticate(paired.token))!;
    const owner = await f.server.setOwnerPassword(person, { password: PASSWORD });
    assert.deepEqual(owner, { email: null, password: true, passwordSetAt: START });
    assert.equal((await f.server.signInOwner({ password: PASSWORD, name: "Phone" })).device.kind, "person");
  });
});

describe("signing in with the password", () => {
  test("the right password pairs a person's device; a wrong one is unauthorized; a new password replaces the old", async () => {
    const f = await make();
    const claimed = await f.server.claimOwner({ password: PASSWORD, name: "My Mac" });
    const phone = await f.server.signInOwner({ password: PASSWORD, name: "Phone" });
    assert.equal(phone.device.kind, "person");
    assert.equal(phone.device.name, "Phone");
    await assert.rejects(f.server.signInOwner({ password: "not the password", name: "Phone" }), (e) => code(e) === "unauthorized");

    const person = (await f.server.authenticate(claimed.token))!;
    f.clock.advance(MINUTE);
    const changed = await f.server.setOwnerPassword(person, { password: "a whole new passphrase" });
    assert.equal(changed.passwordSetAt, new Date(Date.parse(START) + MINUTE).toISOString().replace(".000Z", "Z"));
    await assert.rejects(f.server.signInOwner({ password: PASSWORD, name: "Tablet" }), (e) => code(e) === "unauthorized");
    assert.equal((await f.server.signInOwner({ password: "a whole new passphrase", name: "Tablet" })).device.kind, "person");
  });

  test("wrong passwords and wrong pairing codes count together: after ten, even the right password waits", async () => {
    const f = await make();
    await f.server.claimOwner({ password: PASSWORD, name: "My Mac" });
    for (let i = 0; i < 5; i++) await assert.rejects(f.server.signInOwner({ password: `wrong password ${i}`, name: "x" }));
    for (let i = 0; i < 5; i++) await assert.rejects(f.server.pair({ code: "WRONG-CODE", name: "x" }));
    await assert.rejects(f.server.signInOwner({ password: PASSWORD, name: "x" }), (e) => {
      assert.equal(code(e), "rate_limited");
      assert.ok((e as ServiceError).retryAfter! > 0);
      return true;
    });
    f.clock.advance(10 * MINUTE + 1000);
    assert.equal((await f.server.signInOwner({ password: PASSWORD, name: "x" })).device.kind, "person");
  });

  test("an agent can't see or set the owner's password", async () => {
    const f = await make();
    const claimed = await f.server.claimOwner({ password: PASSWORD, name: "My Mac" });
    const person = (await f.server.authenticate(claimed.token))!;
    // An agent needs an inbox; any agent caller is refused before that matters.
    const agent = { actor: { kind: "agent" as const, agentId: "dev_agent", name: "Agent" }, inboxIds: [] };
    await assert.rejects(f.server.owner(agent), (e) => code(e) === "needs_person");
    await assert.rejects(f.server.setOwnerPassword(agent, { password: "the agent's own password" }), (e) => code(e) === "needs_person");
    assert.equal((await f.server.owner(person)).password, true);
  });
});

describe("recovery codes", () => {
  test("made where the owner's code goes, never answered; used once; one at a time; dropped when it expires", async () => {
    const f = await make();
    const claimed = await f.server.claimOwner({ password: PASSWORD, name: "My Mac" });
    const before = f.heard.length;

    const asked = await f.server.requestRecoveryCode();
    assert.equal(asked.kind, "recovery");
    assert.ok(!JSON.stringify(asked).match(/[0-9A-Z]{4}-[0-9A-Z]{4}/), "the answer holds no code");
    const recovery = f.heard.at(-1)!;
    assert.equal(recovery.kind, "recovery");
    assert.equal(recovery.made, true);
    assert.equal(recovery.code!.expiresAt, asked.expiresAt);
    assert.equal(Date.parse(asked.expiresAt) - Date.parse(START), 30 * MINUTE);

    assert.deepEqual(await f.server.requestRecoveryCode(), asked, "a second request gives the same waiting code");
    assert.equal(f.heard.length, before + 1, "and makes no other");

    // Another person's code used meanwhile leaves the recovery code waiting.
    const person = (await f.server.authenticate(claimed.token))!;
    const other = await f.server.createPairingCode(person, { kind: "person" });
    await f.server.pair({ code: other.code, name: "Tablet" });
    assert.equal(f.heard.length, before + 1);

    const recovered = await f.server.pair({ code: recovery.code!.code, name: "Browser" });
    assert.equal(recovered.device.kind, "person");
    assert.deepEqual(f.heard.at(-1), { code: null, made: false, kind: "recovery" }, "used: the host removes it");

    await f.server.requestRecoveryCode();
    f.clock.advance(30 * MINUTE + 1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.heard.at(-1), { code: null, made: false, kind: "recovery" }, "expired: the host removes it");
  });

  test("while no person's device is paired, the owner's code is the way in and no other is made", async () => {
    const f = await make();
    const waiting = f.heard.at(-1)!;
    const asked = await f.server.requestRecoveryCode();
    assert.deepEqual(asked, { kind: "owner", expiresAt: waiting.code!.expiresAt });
    assert.equal(f.heard.at(-1), waiting);
  });
});

describe("claiming with the host's owner email", () => {
  async function signIn(f: Fresh): Promise<{ status: number; redirect?: string; message: string }> {
    const start = await f.server.startOwnerClaim();
    const url = new URL(start.url);
    assert.equal(url.searchParams.get("scope"), "openid email");
    assert.equal(url.searchParams.get("login_hint"), null, "the owner's email isn't in an answer anyone can ask for");
    assert.equal(url.searchParams.get("access_type"), null, "no offline access");
    const page = await f.server.finishGoogleSignIn(new URLSearchParams({ state: url.searchParams.get("state")!, code: "google-code" }));
    return page;
  }

  test("only Google's verified proof of that address claims it; a typed email or another account can't", async () => {
    let email = "someone@example.org";
    const f = await make({ ownerEmail: " Owner@Example.org", googleFetch: (input, init) => googleFor(email)(input, init) });
    assert.deepEqual((await f.server.info()).owner, { password: false, claimable: true, claim: "google" });
    await assert.rejects(f.server.claimOwner({ password: PASSWORD, name: "Mac", email: "owner@example.org" }), (e) => code(e) === "forbidden");

    const refused = await signIn(f);
    assert.equal(refused.status, 400);
    assert.equal(refused.redirect, undefined);

    email = "owner@example.org";
    const proven = await signIn(f);
    assert.equal(proven.status, 303);
    const proof = new URL(proven.redirect!, "http://x").searchParams.get("proof")!;
    assert.match(proven.redirect!, /^\/claim\?proof=/);

    await assert.rejects(f.server.claimOwner({ password: "short", name: "Mac", proof }), (e) => code(e) === "invalid");
    await assert.rejects(f.server.claimOwner({ password: PASSWORD, name: "Mac", proof: "made-up" }), (e) => code(e) === "unauthorized");
    const claimed = await f.server.claimOwner({ password: PASSWORD, name: "Mac", proof, email: "typed@example.org" });
    const person = (await f.server.authenticate(claimed.token))!;
    assert.equal((await f.server.owner(person)).email, "owner@example.org", "Google's address, not the typed one");
    await assert.rejects(f.server.startOwnerClaim(), (e) => code(e) === "conflict");
  });

  test("a proof expires after ten minutes; an unverified email proves nothing; without Google sign-in it can't start", async () => {
    const f = await make({ ownerEmail: "owner@example.org", googleFetch: googleFor("owner@example.org") });
    const proven = await signIn(f);
    const proof = new URL(proven.redirect!, "http://x").searchParams.get("proof")!;
    f.clock.advance(10 * MINUTE + 1000);
    await assert.rejects(f.server.claimOwner({ password: PASSWORD, name: "Mac", proof }), (e) => code(e) === "unauthorized");

    const unverified = await make({ ownerEmail: "owner@example.org", googleFetch: googleFor("owner@example.org", false) });
    assert.equal((await signIn(unverified)).status, 400);

    const noGoogle = await make({ ownerEmail: "owner@example.org" });
    await assert.rejects(noGoogle.server.startOwnerClaim(), (e) => code(e) === "conflict");
  });
});

describe("the pieces", () => {
  test("a password is kept as PBKDF2, compared after NFKC normalisation", async () => {
    const stored = await hashPassword("ﬁve fine passwords", webRandom);
    assert.match(stored, /^pbkdf2-sha256\$100000\$[\w-]{22}\$[\w-]{43}$/);
    assert.ok(await passwordMatches("five fine passwords", stored), "the ligature normalises to its letters");
    assert.ok(!(await passwordMatches("five fine password", stored)));
    assert.ok(!(await passwordMatches("five fine passwords", "plain$text")));
  });

  test("an ID token proves an email only from Google, for this client, unexpired and verified", () => {
    const now = Date.parse(START);
    const token = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
    const good = { iss: "https://accounts.google.com", aud: CLIENT.clientId, exp: now / 1000 + 60, email: "Me@Example.org", email_verified: true };
    assert.equal(verifiedEmail(token(good), CLIENT.clientId, now), "me@example.org");
    assert.equal(verifiedEmail(token({ ...good, iss: "https://evil.example" }), CLIENT.clientId, now), null);
    assert.equal(verifiedEmail(token({ ...good, aud: "another-client" }), CLIENT.clientId, now), null);
    assert.equal(verifiedEmail(token({ ...good, exp: now / 1000 - 1 }), CLIENT.clientId, now), null);
    assert.equal(verifiedEmail(token({ ...good, email_verified: false }), CLIENT.clientId, now), null);
    assert.equal(verifiedEmail("not-a-token", CLIENT.clientId, now), null);
  });

  test("the owner email setting: lower case, blank is none, one that isn't an address is invalid", () => {
    assert.deepEqual(ownerEmailSetting(" Me@Example.org "), { email: "me@example.org", invalid: false });
    assert.deepEqual(ownerEmailSetting("  "), { email: null, invalid: false });
    assert.deepEqual(ownerEmailSetting(undefined), { email: null, invalid: false });
    assert.equal(ownerEmailSetting("me").invalid, true);
  });
});

describe("through REST", () => {
  test("info says it can be claimed; claim, sign in and set the password over HTTP; the account needs a person", async () => {
    const f = await make();
    const app = createApp(f.server, { scheduler: f.clock, log: { info: () => {}, error: () => {} } });
    const post = (path: string, body: unknown, token?: string, method = "POST") =>
      app.request(path, { method, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });

    const info = (await (await app.request("/v1/info")).json()) as { owner: unknown };
    assert.deepEqual(info.owner, { password: false, claimable: true, claim: "password" });
    const claimed = await post("/v1/owner/claim", { password: PASSWORD, name: "Browser" });
    assert.equal(claimed.status, 200);
    const { token } = (await claimed.json()) as { token: string };
    assert.equal((await post("/v1/owner/claim", { password: PASSWORD, name: "Again" })).status, 409);

    assert.equal((await post("/v1/owner/sign-in", { password: "wrong password!", name: "Phone" })).status, 401);
    assert.equal((await post("/v1/owner/sign-in", { password: PASSWORD, name: "Phone" })).status, 200);

    assert.equal((await app.request("/v1/owner")).status, 401);
    const account = await app.request("/v1/owner", { headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual(await account.json(), { email: null, password: true, passwordSetAt: START });
    assert.equal((await post("/v1/owner/password", { password: "another long passphrase" }, token, "PUT")).status, 200);
    assert.equal((await post("/v1/owner/recovery-code", {})).status, 200);
    assert.equal((await post("/v1/owner/claim/google", {})).status, 409, "no owner email, and claimed already");
  });
});
