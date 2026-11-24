// Connecting Gmail by signing in with Google (docs/contract-sync.md), end to end through REST: the real server and
// the real Gmail provider against mail's fake of Google's sign-in and Gmail's API. The client and the redirect
// address are the owner's shape: a web application client whose one redirect address is the loopback callback.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { GOOGLE_GMAIL_SCOPE } from "@usualmail/core";
import { createGmailProvider } from "@usualmail/mail";
import { FakeGoogle } from "@usualmail/mail/testing";
import { inboxes } from "../src/db/index.ts";
import type { GoogleClient } from "../src/google/config.ts";
import { rawMail } from "./e2e/imap-server.ts";
import { startWorld, type Json, type World } from "./e2e/world.ts";

const REDIRECT = "http://127.0.0.1:8585/v1/google/callback";
const CLIENT: GoogleClient = { clientId: "owner-client.apps.googleusercontent.example", clientSecret: "GOCSPX-owner-client-secret" };
const ANA = "ana@gmail.example";
const BO = "bo@gmail.example";

let google: FakeGoogle;
let client: GoogleClient | null;
let w: World;

async function world(withGoogle = true): Promise<World> {
  return startWorld(
    { gmail: (credentials, options) => createGmailProvider(credentials, { ...options, fetch: google.fetch, quotaPerSecond: 1_000_000 }) },
    withGoogle ? { google: { client: async () => client, redirectUri: () => REDIRECT, fetch: google.fetch } } : {},
  );
}

beforeEach(async () => {
  google = new FakeGoogle({ ...CLIENT, redirectUris: [REDIRECT] });
  google.addAccount(ANA);
  google.addAccount(BO);
  client = { ...CLIENT };
  w = await world();
});
afterEach(async () => {
  await w.close();
  assert.deepEqual(w.errors, [], "nothing went wrong in the background");
});

/** The syncs a test made fail on purpose were logged, without anything secret; nothing else went wrong. */
function expectSyncFailures(): void {
  assert.ok(w.errors.length > 0);
  for (const line of w.errors) {
    assert.match(line, /^Syncing inb_\S+ failed/);
    assert.ok(!line.includes(CLIENT.clientSecret));
  }
  w.errors.length = 0;
}

/** A page's text, with the apostrophes the page escapes read back. */
const text = (body: unknown) => (body instanceof Uint8Array ? new TextDecoder().decode(body) : JSON.stringify(body)).replaceAll("&#39;", "'");

/** What the person's browser does: opens Google's address, and follows Google's redirect back to the server. */
async function browse(url: string): Promise<{ status: number; page: string; headers: Headers; callback: string }> {
  const answer = await google.fetch(url, { method: "GET" });
  assert.equal(answer.status, 302, "Google sends the browser back");
  const back = new URL(answer.headers.get("location")!);
  assert.equal(back.origin + back.pathname, REDIRECT);
  const callback = back.pathname + back.search;
  const res = await w.call("GET", callback, { token: null });
  return { status: res.status, page: text(res.body), headers: res.headers, callback };
}

async function start(body: Json = {}, token?: string): Promise<Json> {
  return w.ok("POST", "/v1/google/sign-ins", { body, token });
}

async function signIn(body: Json = {}): Promise<{ started: Json; outcome: Json; page: string; status: number; callback: string }> {
  const started = await start(body);
  const { status, page, callback } = await browse(started.url);
  await w.idle();
  return { started, outcome: await w.ok("GET", `/v1/google/sign-ins/${started.id}`), page, status, callback };
}

async function connectAna(body: Json = { name: "Ana", color: "#277A40" }): Promise<Json> {
  const { outcome } = await signIn(body);
  assert.equal(outcome.state, "connected", JSON.stringify(outcome));
  return (await w.ok("GET", "/v1/inboxes")).find((inbox: Json) => inbox.id === outcome.inboxId);
}

async function stored(inboxId: string): Promise<{ sealed: string; plain: Json }> {
  const row = (await w.host.db.select().from(inboxes)).find((r) => r.id === inboxId)!;
  return { sealed: row.credentials, plain: JSON.parse(await w.host.secrets.open(row.credentials, inboxId)) };
}

describe("Google sign-in: what the server says and asks for", () => {
  test("info says whether Google sign-in is available, and what the host still has to give", async () => {
    await w.close();
    w = await world(false);
    assert.deepEqual((await w.ok("GET", "/v1/info", { token: null })).googleSignIn, { available: false, missing: ["client", "address"] });
    await w.close();
    client = null;
    w = await world();
    assert.deepEqual((await w.ok("GET", "/v1/info", { token: null })).googleSignIn, { available: false, redirectUri: REDIRECT, missing: ["client"] });
    client = { ...CLIENT };
    assert.deepEqual((await w.ok("GET", "/v1/info", { token: null })).googleSignIn, { available: true, redirectUri: REDIRECT });
  });

  test("starting is a person's, only once set up, and asks Google for exactly what the server needs", async () => {
    client = null;
    const off = await w.call("POST", "/v1/google/sign-ins", { body: {} });
    assert.deepEqual([off.status, off.body.error.code], [409, "conflict"]);
    assert.match(off.body.error.message, /Google sign-in isn't set up/);
    client = { ...CLIENT };

    const pasted = await w.ok("POST", "/v1/inboxes", {
      body: { name: "Bo", color: "#277A40", provider: "gmail", credentials: { ...CLIENT, refreshToken: google.account(BO).refreshToken } },
    });
    const agent = await w.agent([pasted.id]);
    const refused = await w.call("POST", "/v1/google/sign-ins", { body: {}, token: agent });
    assert.deepEqual([refused.status, refused.body.error.code], [403, "needs_person"]);

    const before = w.clock.now();
    const started = await start({ name: "Ana" });
    assert.equal(Date.parse(started.expiresAt), Math.floor(before / 1000) * 1000 + 10 * 60_000);
    const url = new URL(started.url);
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    assert.deepEqual(
      [q.get("client_id"), q.get("redirect_uri"), q.get("response_type"), q.get("scope"), q.get("code_challenge_method"), q.get("access_type"), q.get("prompt")],
      [CLIENT.clientId, REDIRECT, "code", GOOGLE_GMAIL_SCOPE, "S256", "offline", "consent select_account"],
    );
    assert.ok(q.get("state")!.length >= 43, "the state is at least 256 random bits");
    assert.match(q.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(q.get("login_hint"), null);
    assert.equal(q.get("include_granted_scopes"), null);
    const again = new URL((await start()).url).searchParams;
    assert.notEqual(again.get("state"), q.get("state"));
    assert.notEqual(again.get("code_challenge"), q.get("code_challenge"));
    // The outcome waits until the person comes back.
    assert.deepEqual(await w.ok("GET", `/v1/google/sign-ins/${started.id}`), { id: started.id, state: "waiting", expiresAt: started.expiresAt });

    for (const body of [{ color: "green" }, { icon: "tree" }, { name: "" }, { extra: 1 }, { inboxId: "inb_missing", name: "X" }]) {
      const bad = await w.call("POST", "/v1/google/sign-ins", { body });
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
    assert.equal((await w.call("POST", "/v1/google/sign-ins", { body: { inboxId: "inb_missing" } })).status, 404);
    // Any of core's icons, the eight added on 2026-11-20 too.
    assert.equal((await w.call("POST", "/v1/google/sign-ins", { body: { name: "Trips", icon: "plane" } })).status, 200);
  });
});

describe("Google sign-in: connecting and reconnecting", () => {
  test("a new inbox: the page says it worked, the inbox syncs against Gmail, the AI processes it, the outcome says so", async () => {
    await w.ok("PATCH", "/v1/ai", { body: { credentials: { kind: "gateway", gateway: "vercel", apiKey: "made-up-key-for-tests" } } });
    await google.account(ANA).deliver(rawMail({ from: "Dana <dana@lumen.example>", to: ANA, subject: "Hello Ana", messageId: "hello-1@e2e.example" }), ["INBOX"]);
    const listening = await w.listen(w.personToken);

    const { started, outcome, page, status } = await signIn({ name: "Ana", color: "#277A40", icon: "house" });
    assert.equal(status, 200);
    assert.match(page, /Gmail is connected/);
    assert.match(page, /ana@gmail\.example/);
    assert.match(page, /Go back to Usual Mail/);
    assert.deepEqual(Object.keys(outcome).sort(), ["expiresAt", "id", "inboxId", "message", "reconnected", "state"]);
    assert.deepEqual([outcome.id, outcome.state, outcome.reconnected], [started.id, "connected", false]);

    const inbox = (await w.ok("GET", "/v1/inboxes"))[0];
    assert.equal(inbox.id, outcome.inboxId);
    assert.deepEqual(
      [inbox.name, inbox.address, inbox.color, inbox.icon, inbox.provider, inbox.trust, inbox.status],
      ["Ana", ANA, "#277A40", "house", "gmail", "suggest", "ok"],
    );
    // With a key set, every inbox's mail goes to the AI, this one's from its first sync.
    assert.ok(w.models.requests.some((request) => request.request.data.includes("Hello Ana")), "its mail was processed");
    assert.deepEqual(inbox.connection, { kind: "gmail", clientId: CLIENT.clientId, signIn: "google" });
    assert.equal((await w.thread("Hello Ana")).inboxId, inbox.id);
    assert.ok(listening.events.some((event) => event.type === "inbox.changed" && event.inbox.id === inbox.id));
    listening.stop();

    // The code was exchanged with the verifier whose challenge went to Google, at the registered address.
    const exchange = google.tokenForms.find((form) => form.get("grant_type") === "authorization_code")!;
    assert.deepEqual([exchange.get("redirect_uri"), exchange.get("client_id"), exchange.get("client_secret")], [REDIRECT, CLIENT.clientId, CLIENT.clientSecret]);
    assert.ok(exchange.get("code_verifier")!.length >= 43);
    // Only the token and the client's id are kept, sealed; the host's secret stays the host's.
    const { plain } = await stored(inbox.id);
    assert.deepEqual(Object.keys(plain).sort(), ["clientId", "refreshToken", "signIn"]);
    assert.equal(plain.signIn, "google");
    // The default name is the address.
    google.consent = { account: BO };
    const bo = await signIn({});
    assert.equal((await w.ok("GET", "/v1/inboxes")).find((i: Json) => i.id === bo.outcome.inboxId).name, BO);
  });

  test("the secret, the tokens and the code are in no response, event, log, page or unsealed store", async () => {
    const listening = await w.listen(w.personToken);
    const answers: string[] = [];
    const started = await start({ name: "Ana" });
    answers.push(JSON.stringify(started));
    const { page, callback } = await browse(started.url);
    await w.idle();
    answers.push(page, JSON.stringify(await w.ok("GET", `/v1/google/sign-ins/${started.id}`)), JSON.stringify(await w.ok("GET", "/v1/inboxes")));
    answers.push(JSON.stringify(await w.ok("GET", "/v1/info", { token: null })));
    const code = new URLSearchParams(callback.split("?")[1]).get("code")!;
    const issued = google.tokenForms.find((form) => form.get("grant_type") === "authorization_code")!;
    const refresh = [...google.account(ANA).grantedRefreshTokens][0]!;
    const secrets = [CLIENT.clientSecret, refresh, code, issued.get("code_verifier")!];
    const rows = JSON.stringify(await w.host.db.select().from(inboxes));
    const everything = [...answers, JSON.stringify(listening.events), ...w.infos, ...w.errors, rows].join("\n");
    for (const secret of secrets) assert.ok(!everything.includes(secret), `${secret.slice(0, 6)}… shows nowhere`);
    // The state appears only in Google's address, which the device that started it needs.
    assert.ok(!page.includes(new URL(started.url).searchParams.get("state")!));
    listening.stop();
  });

  test("reconnecting in place keeps rules, history and settings; a token Google refuses later asks to sign in again", async () => {
    await google.account(ANA).deliver(rawMail({ from: "Dana <dana@lumen.example>", to: ANA, subject: "Kept", messageId: "kept-1@e2e.example" }), ["INBOX"]);
    const inbox = await connectAna();
    await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { trust: "act_with_undo", guide: "Be kind." } });
    const rule = await w.ok("POST", `/v1/inboxes/${inbox.id}/rules`, { body: { text: "Shop receipts", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }] } });

    // Revoked at Google (or seven days in Testing, or a new password): the inbox needs attention, nothing else changes.
    google.account(ANA).revokeGrant();
    await w.sync(inbox.id);
    const broken = (await w.ok("GET", "/v1/inboxes"))[0];
    assert.equal(broken.status, "needs_attention");
    assert.match(broken.statusDetail, /Sign in with Google again/);
    assert.ok(!broken.statusDetail.includes("invalid_grant"), "the person's words, not Google's code");
    expectSyncFailures();
    assert.equal((await w.thread("Kept")).inboxId, inbox.id);

    const started = await start({ inboxId: inbox.id });
    const q = new URL(started.url).searchParams;
    assert.deepEqual([q.get("login_hint"), q.get("prompt")], [ANA, "consent"]);
    const { page } = await browse(started.url);
    await w.idle();
    assert.match(page, /reconnected/i);
    const outcome = await w.ok("GET", `/v1/google/sign-ins/${started.id}`);
    assert.deepEqual([outcome.state, outcome.inboxId, outcome.reconnected], ["connected", inbox.id, true]);
    const after = await w.ok("GET", "/v1/inboxes");
    assert.equal(after.length, 1);
    assert.deepEqual([after[0].id, after[0].status, after[0].trust, after[0].guide, after[0].name], [inbox.id, "ok", "act_with_undo", "Be kind.", "Ana"]);
    assert.deepEqual((await w.ok("GET", `/v1/inboxes/${inbox.id}/rules`)).map((r: Json) => r.id), [rule.id]);
    assert.equal((await w.thread("Kept")).inboxId, inbox.id);
  });

  test("a sign-in for a new inbox whose address is already connected reconnects that inbox in place", async () => {
    const inbox = await connectAna();
    const { outcome } = await signIn({ name: "Another name", color: "#B53031" });
    assert.deepEqual([outcome.state, outcome.inboxId, outcome.reconnected], ["connected", inbox.id, true]);
    const all = await w.ok("GET", "/v1/inboxes");
    assert.deepEqual(all.map((i: Json) => [i.id, i.name, i.color]), [[inbox.id, "Ana", "#277A40"]]);
  });

  test("an inbox connected by hand can be reconnected by signing in", async () => {
    const pasted = await w.ok("POST", "/v1/inboxes", {
      body: { name: "Ana", color: "#277A40", provider: "gmail", credentials: { ...CLIENT, refreshToken: google.account(ANA).refreshToken } },
    });
    assert.deepEqual(pasted.connection, { kind: "gmail", clientId: CLIENT.clientId });
    const { outcome } = await signIn({ inboxId: pasted.id });
    assert.deepEqual([outcome.state, outcome.reconnected], ["connected", true]);
    assert.deepEqual((await w.ok("GET", "/v1/inboxes"))[0].connection, { kind: "gmail", clientId: CLIENT.clientId, signIn: "google" });
  });

  test("another account than the inbox's is refused when reconnecting, and nothing changes", async () => {
    const inbox = await connectAna();
    const before = await stored(inbox.id);
    google.consent = { account: BO };
    const { outcome, page, status } = await signIn({ inboxId: inbox.id });
    assert.equal(status, 400);
    assert.deepEqual([outcome.state, outcome.failure, outcome.inboxId], ["failed", "wrong_account", inbox.id]);
    assert.match(outcome.message, /bo@gmail\.example.*ana@gmail\.example/);
    assert.match(page, /bo@gmail\.example/);
    assert.equal((await stored(inbox.id)).sealed, before.sealed);
    assert.equal((await w.ok("GET", "/v1/inboxes")).length, 1);
  });

  test("declined, a scope left unticked, or no lasting access: words a person can act on, and nothing connected", async () => {
    const cases: Array<[FakeGoogle["consent"], string, RegExp]> = [
      [{ answer: "decline" }, "declined", /didn't allow/],
      [{ scopes: [] }, "scope_missing", /tick/],
      [{ refreshToken: false }, "no_refresh_token", /lasting access/],
    ];
    for (const [consent, failure, words] of cases) {
      google.consent = consent;
      const { outcome, page, status } = await signIn({ name: "Ana" });
      assert.equal(status, 400, failure);
      assert.deepEqual([outcome.state, outcome.failure], ["failed", failure]);
      assert.match(outcome.message, words);
      assert.match(page, words);
      assert.match(page, /Start again/);
    }
    assert.deepEqual(await w.ok("GET", "/v1/inboxes"), []);
  });
});

describe("Google sign-in: the state and the page", () => {
  test("a state can't be used after it expires, used twice, made up, or read by another device", async () => {
    // Expired: the outcome says so without a callback, and a late callback gets the same words.
    const late = await start({ name: "Ana" });
    w.clock.advance(10 * 60_000 + 1000);
    assert.deepEqual(
      [(await w.ok("GET", `/v1/google/sign-ins/${late.id}`)).state, (await w.ok("GET", `/v1/google/sign-ins/${late.id}`)).failure],
      ["failed", "expired"],
    );
    const lateVisit = await browse(late.url);
    assert.equal(lateVisit.status, 400);
    assert.match(lateVisit.page, /expired/);
    assert.deepEqual(await w.ok("GET", "/v1/inboxes"), []);

    // Used twice: the second visit changes nothing.
    const { callback, outcome } = await signIn({ name: "Ana" });
    const again = await w.call("GET", callback, { token: null });
    assert.equal(again.status, 400);
    assert.match(text(again.body), /already/);
    assert.equal((await w.ok("GET", "/v1/inboxes")).length, 1);
    assert.equal((await w.ok("GET", `/v1/google/sign-ins/${outcome.id}`)).state, "connected");

    // Made up, or missing.
    for (const path of ["/v1/google/callback?state=made-up-state&code=4/made-up", "/v1/google/callback?code=4/no-state", "/v1/google/callback"]) {
      const res = await w.call("GET", path, { token: null });
      assert.equal(res.status, 400, path);
      assert.match(text(res.body), /isn't one this server is waiting for/);
    }
    assert.equal(google.tokenForms.filter((form) => form.get("grant_type") === "authorization_code").length, 1, "nothing made up reached Google");

    // Another device: another person's device can't read it; an agent can't either.
    const pending = await start({ name: "Bo" });
    const code = await w.ok("POST", "/v1/pairing-codes", { body: { kind: "person" } });
    const other = (await w.ok("POST", "/v1/pair", { token: null, body: { code: code.code, name: "Other Mac" } })).token;
    assert.equal((await w.call("GET", `/v1/google/sign-ins/${pending.id}`, { token: other })).status, 404);
    const agent = await w.agent([outcome.inboxId]);
    assert.equal((await w.call("GET", `/v1/google/sign-ins/${pending.id}`, { token: agent })).status, 403);

    // The device that started it was removed before the person came back: nothing is connected.
    const byOther = await start({ name: "Bo" }, other);
    const otherDevice = await w.ok("GET", "/v1/me", { token: other });
    await w.ok("DELETE", `/v1/devices/${otherDevice.id}`);
    google.consent = { account: BO };
    const cancelled = await browse(byOther.url);
    assert.equal(cancelled.status, 400);
    assert.match(cancelled.page, /removed/);
    assert.equal((await w.ok("GET", "/v1/inboxes")).length, 1);
  });

  test("the page is plain, strict and shows nothing Google or the address bar sent", async () => {
    const started = await start({ name: "Ana" });
    const state = new URL(started.url).searchParams.get("state")!;
    const hostile = encodeURIComponent('<script>alert(1)</script>"><img src=x>');
    const res = await w.call("GET", `/v1/google/callback?state=${encodeURIComponent(state)}&error=${hostile}&error_description=${hostile}`, { token: null });
    const page = text(res.body);
    assert.equal(res.status, 400);
    assert.ok(!page.includes("<script") && !page.includes("<img") && !page.includes("alert(1)"), page);
    assert.match(page, /Google didn't finish the sign-in/);
    const csp = res.headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual((await w.ok("GET", `/v1/google/sign-ins/${started.id}`)).failure, "google_error");

    // A known refusal gets its own words; the address it names is escaped.
    const second = await start({ name: "Ana" });
    const admin = await w.call("GET", `/v1/google/callback?state=${encodeURIComponent(new URL(second.url).searchParams.get("state")!)}&error=admin_policy_enforced`, { token: null });
    assert.match(text(admin.body), /administrator/);
  });
});

describe("Google sign-in: tokens over time", () => {
  test("removing an inbox connected by signing in revokes its token; a failed revocation doesn't stop it; a pasted one isn't revoked", async () => {
    const inbox = await connectAna();
    const { plain } = await stored(inbox.id);
    await w.ok("DELETE", `/v1/inboxes/${inbox.id}`);
    await w.idle();
    assert.deepEqual(google.revoked, [plain.refreshToken]);

    const again = await connectAna();
    google.failNextRevoke(1, 503);
    await w.ok("DELETE", `/v1/inboxes/${again.id}`);
    await w.idle();
    assert.deepEqual(await w.ok("GET", "/v1/inboxes"), []);
    assert.ok(w.infos.some((line) => /Couldn't revoke/.test(line)), "a failed revocation is noted");

    const pasted = await w.ok("POST", "/v1/inboxes", {
      body: { name: "Bo", color: "#277A40", provider: "gmail", credentials: { ...CLIENT, refreshToken: google.account(BO).refreshToken } },
    });
    await w.ok("DELETE", `/v1/inboxes/${pasted.id}`);
    await w.idle();
    assert.equal(google.revoked.length, 1, "a token given by hand is the person's own, and stays");
  });

  test("the host's client going away or changing puts a signed-in inbox in needs attention, with what to do", async () => {
    const inbox = await connectAna();
    client = null;
    await w.sync(inbox.id);
    assert.match((await w.ok("GET", "/v1/inboxes"))[0].statusDetail, /Google sign-in isn't set up on this server/);
    client = { clientId: "another-client.apps.googleusercontent.example", clientSecret: "another" };
    await w.sync(inbox.id);
    assert.match((await w.ok("GET", "/v1/inboxes"))[0].statusDetail, /another Google client.*Sign in with Google again/);
    expectSyncFailures();
    client = { ...CLIENT };
    await w.sync(inbox.id);
    assert.equal((await w.ok("GET", "/v1/inboxes"))[0].status, "ok");
  });

  test("credentials given by hand can't claim to come from a sign-in", async () => {
    const res = await w.call("POST", "/v1/inboxes", {
      body: { name: "Ana", color: "#277A40", provider: "gmail", credentials: { ...CLIENT, refreshToken: google.account(ANA).refreshToken, signIn: "google" } },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Sign in with Google/);
  });
});
