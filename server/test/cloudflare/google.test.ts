// Google sign-in on Cloudflare, in workerd: the server's address taken only from its own hosts (the workers.dev shape
// and USUAL_MAIL_PUBLIC_URL's origin), always https; the Google client given by a paired device, read back without its
// secret, kept sealed, replaced only when confirmed; a whole sign-in through a fake Google behind the outbound service;
// and the Worker secrets as the fallback that wins. Nothing reaches Google.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { GOOGLE_SETUP_WORDS } from "@usualmail/core";
import { FakeGoogle } from "../../../mail/src/testing/index.ts";
import { ADDRESS_FIX } from "../../src/cloudflare/address.ts";
import { clientWords } from "../../src/google/words.ts";
import { startServer, type TestServer } from "./harness.ts";

const OWN = "https://mail.example";
const WORKERS_DEV = "https://usual-mail.someone.workers.dev";
const CALLBACK = "/v1/google/callback";
const SECRET = "GOCSPX-cloudflare-test-secret-7Q9";
const OTHER_SECRET = "GOCSPX-cloudflare-other-secret-4R2";
const ENV_SECRET = "GOCSPX-cloudflare-env-secret-K3W";

interface Answer {
  status: number;
  headers: Headers;
  text: string;
  body: any;
}

/** Every answer's text, to check no secret is in any of them. */
const answers: string[] = [];

async function call(server: TestServer, method: string, url: string, o: { token?: string; body?: string; json?: unknown } = {}): Promise<Answer> {
  const body = o.json !== undefined ? JSON.stringify(o.json) : o.body;
  const response = await server.mf.dispatchFetch(url, {
    method,
    redirect: "manual",
    headers: { ...(o.token && { authorization: `Bearer ${o.token}` }), ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body }),
  });
  const text = await response.text();
  answers.push(text);
  const json = response.headers.get("content-type")?.includes("json") && text ? JSON.parse(text) : undefined;
  return { status: response.status, headers: response.headers as unknown as Headers, text, body: json };
}

function clientFile(clientId: string, clientSecret: string, redirects: string[]): string {
  return JSON.stringify({ web: { client_id: clientId, project_id: "usual-mail", client_secret: clientSecret, redirect_uris: redirects } });
}

/** Every row of every table in the object's SQLite, and its key-value storage, as text. */
async function everythingStored(server: TestServer): Promise<string> {
  const tables = await server.sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
  const rows: string[] = [];
  for (const { name } of tables) {
    const answer = await server.call("POST", "/__test/sql", { query: `SELECT * FROM "${name.replaceAll('"', '""')}"` });
    rows.push(name, JSON.stringify(answer.body));
  }
  const kv = await server.call("GET", "/__test/kv");
  return `${rows.join("\n")}\n${JSON.stringify(kv.body)}`;
}

describe("a server with USUAL_MAIL_PUBLIC_URL and a client given by a paired device", () => {
  const google = new FakeGoogle({ clientSecret: SECRET, redirectUris: [`${OWN}${CALLBACK}`, `${WORKERS_DEV}${CALLBACK}`] });
  google.addAccount("me@gmail.example");
  const other = { id: "other-client.apps.googleusercontent.example", secret: OTHER_SECRET };
  let server: TestServer;
  let token = "";

  before(async () => {
    server = await startServer({ bindings: { USUAL_MAIL_PUBLIC_URL: OWN }, google });
  });

  after(async () => {
    if (!server) return;
    try {
      for (const secret of [SECRET, OTHER_SECRET]) {
        assert.ok(!answers.some((text) => text.includes(secret)), "the client secret is in no answer");
        assert.ok(!server.logs.some((line) => line.includes(secret)), "the client secret is in no log line");
      }
    } finally {
      await server.stop();
    }
  });

  test("takes the server's address only from its own hosts, always https", async () => {
    const own = await call(server, "GET", `${OWN}/v1/info`);
    assert.deepEqual(own.body.googleSignIn, { available: false, redirectUri: `${OWN}${CALLBACK}`, missing: ["client"] });
    const dev = await call(server, "GET", `${WORKERS_DEV}/v1/info`);
    assert.equal(dev.body.googleSignIn.redirectUri, `${WORKERS_DEV}${CALLBACK}`, "the Worker's workers.dev host");
    for (const foreign of ["https://elsewhere.example", "https://mail.example:8443", "https://a.usual-mail.someone.workers.dev", "https://someone.workers.dev"]) {
      const answer = await call(server, "GET", `${foreign}/v1/info`);
      assert.deepEqual(answer.body.googleSignIn, { available: false, missing: ["client", "address"] }, foreign);
    }
    const plain = await call(server, "GET", "http://mail.example/v1/info");
    assert.equal(plain.status, 403, "http is refused before anything else");
    assert.equal(server.logged(/Google sign-in: no Google client yet .* for its workers\.dev address or https:\/\/mail\.example only\./).length, 1);
  });

  test("a paired device gives the client; it is read back without the secret and kept sealed", async () => {
    token = (await server.pair()).token;
    const file = clientFile(google.clientId, SECRET, [`${OWN}${CALLBACK}`]);
    assert.equal((await call(server, "PUT", `${OWN}/v1/google/client`, { body: file })).status, 401, "a token first");
    const saved = await call(server, "PUT", `${OWN}/v1/google/client`, { token, body: file });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.body, { clientId: google.clientId, replaced: false, googleSignIn: { available: true, redirectUri: `${OWN}${CALLBACK}` } });

    const setup = await call(server, "GET", `${OWN}/v1/google/setup`, { token });
    assert.deepEqual(setup.body.client, { source: "saved", clientId: google.clientId, changeable: true });
    assert.match(setup.body.prompt, /^- Redirect address: https:\/\/mail\.example\/v1\/google\/callback$/m);
    assert.equal((await call(server, "GET", `${WORKERS_DEV}/v1/info`)).body.googleSignIn.available, true);

    const stored = await everythingStored(server);
    assert.ok(!stored.includes(SECRET), "no table or stored value holds the secret in plain");
    assert.ok(!stored.includes(google.clientId), "nor the client file's text");
    const kv = (await server.call("GET", "/__test/kv")).body as Array<[string, unknown]>;
    const sealed = kv.find(([key]) => key === "usual-mail-google-client");
    assert.match(String(sealed?.[1]), /^v1\.[\w-]+\.[\w-]+$/, "sealed with the server's key");
    assert.equal(server.logged(/a person's device gave the server its Google client/).length, 1);
  });

  test("replaces the client only when the device confirms", async () => {
    const same = await call(server, "PUT", `${OWN}/v1/google/client`, { token, body: clientFile(google.clientId, SECRET, []) });
    assert.deepEqual([same.status, same.body.error.code, same.body.error.message], [409, "conflict", clientWords.sameClient]);
    const otherFile = clientFile(other.id, other.secret, [`${OWN}${CALLBACK}`]);
    const refused = await call(server, "PUT", `${OWN}/v1/google/client`, { token, body: otherFile });
    assert.deepEqual([refused.status, refused.body.error.message], [409, clientWords.otherClient]);
    for (const message of [same.body.error.message, refused.body.error.message]) {
      assert.match(message, /Confirm to replace it\.$/);
      assert.doesNotMatch(message, /replace=/);
    }
    const setup = await call(server, "GET", `${OWN}/v1/google/setup`, { token });
    assert.equal(setup.body.client.clientId, google.clientId, "nothing was saved");
  });

  test("a sign-in started at the server's own address comes back there and connects Gmail", async () => {
    const elsewhere = await call(server, "POST", "https://elsewhere.example/v1/google/sign-ins", { token, json: {} });
    assert.deepEqual([elsewhere.status, elsewhere.body.error.code], [409, "conflict"]);
    assert.match(elsewhere.body.error.message, /doesn't know its own address/);
    const dev = await call(server, "POST", `${WORKERS_DEV}/v1/google/sign-ins`, { token, json: {} });
    assert.equal(new URL(dev.body.url).searchParams.get("redirect_uri"), `${WORKERS_DEV}${CALLBACK}`);

    const started = await call(server, "POST", `${OWN}/v1/google/sign-ins`, { token, json: { name: "Mine" } });
    assert.equal(started.status, 200, started.text);
    const url = new URL(started.body.url);
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("redirect_uri"), `${OWN}${CALLBACK}`);
    assert.equal(url.searchParams.get("client_id"), google.clientId);

    // The person's browser at the fake Google, then back at the server.
    const consent = await google.fetch(url.href);
    assert.equal(consent.status, 302);
    const back = new URL(consent.headers.get("location")!);
    assert.equal(back.origin + back.pathname, `${OWN}${CALLBACK}`);
    const page = await call(server, "GET", back.href);
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /Gmail is connected: me@gmail\.example/);
    const exchange = google.tokenForms.find((form) => form.get("grant_type") === "authorization_code")!;
    assert.equal(exchange.get("redirect_uri"), `${OWN}${CALLBACK}`, "the code is exchanged with the same address");

    const outcome = await call(server, "GET", `${OWN}/v1/google/sign-ins/${started.body.id}`, { token });
    assert.equal(outcome.body.state, "connected");
    const inboxes = await call(server, "GET", `${OWN}/v1/inboxes`, { token });
    assert.deepEqual(inboxes.body.map((inbox: { address: string; connection: unknown }) => [inbox.address, inbox.connection]), [
      ["me@gmail.example", { kind: "gmail", clientId: google.clientId, signIn: "google" }],
    ]);
  });

  test("replacing the client with an inbox signed in under it says so, once confirmed", async () => {
    const replaced = await call(server, "PUT", `${OWN}/v1/google/client?replace=true`, { token, body: clientFile(other.id, other.secret, []) });
    assert.equal(replaced.status, 200, replaced.text);
    assert.equal(replaced.body.replaced, true);
    assert.equal(replaced.body.clientId, other.id);
    const setup = await call(server, "GET", `${OWN}/v1/google/setup`, { token });
    assert.equal(setup.body.client.clientId, other.id);
    assert.equal(setup.body.client.note, clientWords.strandedNote(1, [google.clientId]));
    const stored = await everythingStored(server);
    assert.ok(!stored.includes(OTHER_SECRET) && !stored.includes(SECRET), "neither secret is stored in plain");
  });
});

describe("a server whose Worker secrets give the client, with an http USUAL_MAIL_PUBLIC_URL", () => {
  const envClient = "env-client.apps.googleusercontent.example";
  let server: TestServer;

  before(async () => {
    server = await startServer({
      bindings: { USUAL_MAIL_GOOGLE_CLIENT_ID: envClient, USUAL_MAIL_GOOGLE_CLIENT_SECRET: ENV_SECRET, USUAL_MAIL_PUBLIC_URL: "http://mail.example" },
    });
  });

  after(async () => {
    if (!server) return;
    try {
      assert.ok(!answers.some((text) => text.includes(ENV_SECRET)), "the secret is in no answer");
      assert.ok(!server.logs.some((line) => line.includes(ENV_SECRET)), "the secret is in no log line");
    } finally {
      await server.stop();
    }
  });

  test("never takes an http address, and uses the secrets' client, which a device can't replace", async () => {
    assert.equal((await call(server, "GET", `${OWN}/v1/info`)).status, 200);
    assert.equal(server.logged(/^USUAL_MAIL_PUBLIC_URL isn't used: it must be the HTTPS address/).length, 1);
    assert.equal(server.logged(/Google sign-in: its Google client from USUAL_MAIL_GOOGLE_CLIENT_ID/).length, 1);
    const own = await call(server, "GET", `${OWN}/v1/info`);
    assert.deepEqual(own.body.googleSignIn, { available: false, missing: ["address"] }, "the client is given, the http address isn't taken");
    const dev = await call(server, "GET", `${WORKERS_DEV}/v1/info`);
    assert.deepEqual(dev.body.googleSignIn, { available: true, redirectUri: `${WORKERS_DEV}${CALLBACK}` });

    const { token } = await server.pair();
    const setup = await call(server, "GET", `${OWN}/v1/google/setup`, { token });
    assert.deepEqual(setup.body.client, { source: "environment", clientId: envClient, changeable: false, reason: clientWords.environment });
    assert.equal(setup.body.noAddress, `${GOOGLE_SETUP_WORDS.noAddress} ${ADDRESS_FIX}`, "the Cloudflare host's words");
    assert.doesNotMatch(setup.body.noAddress, /--public-url|restart/);
    for (const field of ["prompt", "promptNote", "steps"]) assert.equal(setup.body[field], undefined, field);
    const atDev = await call(server, "GET", `${WORKERS_DEV}/v1/google/setup`, { token });
    assert.match(atDev.body.prompt, /^- Redirect address: https:\/\/usual-mail\.someone\.workers\.dev\/v1\/google\/callback$/m);

    const refused = await call(server, "PUT", `${WORKERS_DEV}/v1/google/client`, { token, body: clientFile("x.apps.googleusercontent.example", "GOCSPX-x", []) });
    assert.deepEqual([refused.status, refused.body.error.message], [409, `${clientWords.environment} ${clientWords.notSavedYet}`]);
    const kv = (await server.call("GET", "/__test/kv")).body as Array<[string, unknown]>;
    assert.ok(!kv.some(([key]) => key === "usual-mail-google-client"), "nothing was saved");
    assert.ok(!(await everythingStored(server)).includes(ENV_SECRET));
  });
});
