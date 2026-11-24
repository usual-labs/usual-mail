/**
 * The fake of Google's sign-in that the server's tests and the live run use, held to what Google's documentation says
 * (OAuth 2.0 for web server applications and for installed apps, read 2026-11-17): the authorization endpoint's
 * redirect, the code exchange with PKCE, refresh tokens with `access_type=offline` and `prompt=consent`, revocation,
 * and Gmail's API reached with the tokens it issues.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createGmailProvider } from "../../src/index.ts";
import { FakeGoogle, GOOGLE_AUTH_URL, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, plainMessage } from "../../src/testing/index.ts";

const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const REDIRECT = "http://127.0.0.1:8484/v1/google/callback";
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

function google() {
  const fake = new FakeGoogle({ clientId: "client.apps.example", clientSecret: "client-secret", redirectUris: [REDIRECT] });
  fake.addAccount("ana@gmail.example");
  fake.addAccount("bo@gmail.example");
  return fake;
}

function authUrl(extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    client_id: "client.apps.example",
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    state: "the-state",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    ...extra,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

async function authorize(fake: FakeGoogle, extra: Record<string, string> = {}): Promise<URL> {
  const res = await fake.fetch(authUrl(extra), { method: "GET" });
  assert.equal(res.status, 302);
  return new URL(res.headers.get("location")!);
}

async function exchange(fake: FakeGoogle, code: string, extra: Record<string, string> = {}) {
  const body = new URLSearchParams({
    code,
    client_id: "client.apps.example",
    client_secret: "client-secret",
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
    code_verifier: VERIFIER,
    ...extra,
  });
  const res = await fake.fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

describe("The fake of Google's sign-in", () => {
  it("sends the browser back with a code, the state and the granted scope; the code gives a refresh token once", async () => {
    const fake = google();
    const back = await authorize(fake);
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get("state"), "the-state");
    assert.equal(back.searchParams.get("scope"), SCOPE);
    const code = back.searchParams.get("code")!;
    const answer = await exchange(fake, code);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.scope, SCOPE);
    assert.equal(answer.body.token_type, "Bearer");
    assert.ok(answer.body.access_token && answer.body.refresh_token);
    // Codes work once.
    assert.equal((await exchange(fake, code)).body.error, "invalid_grant");
    // The refresh token reaches the account's mailbox through the real provider.
    const provider = createGmailProvider({ clientId: "client.apps.example", clientSecret: "client-secret", refreshToken: answer.body.refresh_token! }, { fetch: fake.fetch });
    assert.deepEqual(await provider.verify(), { address: "ana@gmail.example" });
  });

  it("checks PKCE, the redirect address and the client", async () => {
    const fake = google();
    const code = (await authorize(fake)).searchParams.get("code")!;
    assert.deepEqual([(await exchange(fake, code, { code_verifier: "w".repeat(43) })).body.error], ["invalid_grant"]);
    const second = (await authorize(fake)).searchParams.get("code")!;
    assert.equal((await exchange(fake, second, { redirect_uri: "http://127.0.0.1:9/elsewhere" })).body.error, "redirect_uri_mismatch");
    const third = (await authorize(fake)).searchParams.get("code")!;
    assert.equal((await exchange(fake, third, { client_secret: "wrong" })).status, 401);
    // An address that isn't registered gets Google's error page, never a redirect.
    const res = await fake.fetch(authUrl({ redirect_uri: "http://127.0.0.1:9/elsewhere" }), { method: "GET" });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null);
    assert.match(await res.text(), /redirect_uri_mismatch/);
  });

  it("answers as the person did: declined, another account, a scope left unticked, no lasting access", async () => {
    const fake = google();
    fake.consent = { answer: "decline" };
    const declined = await authorize(fake);
    assert.deepEqual([declined.searchParams.get("error"), declined.searchParams.get("state"), declined.searchParams.get("code")], ["access_denied", "the-state", null]);

    fake.consent = { account: "bo@gmail.example" };
    const bo = await exchange(fake, (await authorize(fake)).searchParams.get("code")!);
    const provider = createGmailProvider({ clientId: "client.apps.example", clientSecret: "client-secret", refreshToken: bo.body.refresh_token! }, { fetch: fake.fetch });
    assert.deepEqual(await provider.verify(), { address: "bo@gmail.example" });

    fake.consent = { scopes: [] };
    const unticked = await authorize(fake);
    assert.equal(unticked.searchParams.get("scope"), "");
    assert.equal((await exchange(fake, unticked.searchParams.get("code")!)).body.scope, "");

    fake.consent = { refreshToken: false };
    assert.equal((await exchange(fake, (await authorize(fake)).searchParams.get("code")!)).body.refresh_token, undefined);
  });

  it("gives a refresh token again only with prompt=consent, and never without offline access", async () => {
    const fake = google();
    await exchange(fake, (await authorize(fake)).searchParams.get("code")!);
    const again = await exchange(fake, (await authorize(fake, { prompt: "select_account" })).searchParams.get("code")!);
    assert.equal(again.body.refresh_token, undefined);
    const online = await exchange(fake, (await authorize(fake, { access_type: "online" })).searchParams.get("code")!);
    assert.equal(online.body.refresh_token, undefined);
  });

  it("revokes the whole grant of an account: every refresh token of it stops working", async () => {
    const fake = google();
    const first = (await exchange(fake, (await authorize(fake)).searchParams.get("code")!)).body.refresh_token!;
    const second = (await exchange(fake, (await authorize(fake)).searchParams.get("code")!)).body.refresh_token!;
    const res = await fake.fetch(GOOGLE_REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${first}` });
    assert.equal(res.status, 200);
    assert.deepEqual(fake.revoked, [first]);
    for (const token of [first, second]) {
      const provider = createGmailProvider({ clientId: "client.apps.example", clientSecret: "client-secret", refreshToken: token }, { fetch: fake.fetch });
      await assert.rejects(provider.verify(), /invalid_grant/);
    }
    const unknown = await fake.fetch(GOOGLE_REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=nothing" });
    assert.equal(unknown.status, 400);
  });

  it("delivers mail to each account's own mailbox", async () => {
    const fake = google();
    await fake.account("bo@gmail.example").deliver(plainMessage({ from: "Cy <cy@people.example>", to: "bo@gmail.example", subject: "For Bo" }).raw);
    assert.equal(fake.account("bo@gmail.example").mailbox.messages.size, 1);
    assert.equal(fake.account("ana@gmail.example").mailbox.messages.size, 0);
  });
});
