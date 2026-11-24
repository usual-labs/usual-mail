// A person's own paired device sets the host's Google client up (docs/contract-sync.md, "Connecting Gmail by signing in
// with Google"; the owner's decision of 2026-11-21): `GET /v1/google/setup` serves core's prompt and steps with the
// redirect address filled in, and `PUT /v1/google/client` saves the file Google downloads, as it is, through the Node
// host's seam into the data directory. Through REST, with the real Node pieces on a scratch directory. The secret is
// never in an answer, an event or a log line, also when the file is refused.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { GOOGLE_CLIENT_FILE_MAX_BYTES, GOOGLE_GMAIL_SCOPE, GOOGLE_SETUP_WORDS, googleSetupPrompt } from "@usualmail/core";
import type { GoogleOptions } from "../src/google/config.ts";
import { GOOGLE_CLIENT_FILE } from "../src/node/google.ts";
import { memoryFactory } from "../src/testing/index.ts";
import { startWorld, type Json, type World } from "./e2e/world.ts";
import { CLIENT_ID, downloaded, nodeGoogle as nodeGoogleOn, OTHER_SECRET, REDIRECT, SECRET } from "./google-client-fixtures.ts";

let dir: string;
let w: World;
let redirect: string | null;

/** The Node host's Google seam on this test's scratch data directory, as src/node/main.ts builds it. */
function nodeGoogle(env: { clientId: string; clientSecret: string } | null = null): GoogleOptions {
  return nodeGoogleOn(dir, { env: () => env, redirect: () => redirect });
}

async function world(google: GoogleOptions | null = nodeGoogle()): Promise<World> {
  return startWorld({ imap: memoryFactory(new Map()) }, google ? { google } : {});
}

const put = (text: string, query = "", token?: string | null) => w.call("PUT", `/v1/google/client${query}`, { text, ...(token !== undefined && { token }) });
const clientFile = () => join(dir, GOOGLE_CLIENT_FILE);
const exists = () => stat(clientFile()).then(() => true, () => false);

/** Nothing secret in what was answered or logged. */
function nowhere(...answers: unknown[]): void {
  for (const text of [...answers.map((answer) => JSON.stringify(answer)), ...w.infos, ...w.errors]) {
    assert.ok(!text.includes(SECRET) && !text.includes(OTHER_SECRET), text);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "usual-mail-google-client-"));
  redirect = REDIRECT;
  w = await world();
});
afterEach(async () => {
  await w.close();
  await rm(dir, { recursive: true, force: true });
});

describe("PUT /v1/google/client", () => {
  test("a person's device gives the server its client: kept as Google downloaded it, owner-only, used at once", async () => {
    assert.deepEqual((await w.ok("GET", "/v1/info", { token: null })).googleSignIn, { available: false, redirectUri: REDIRECT, missing: ["client"] });
    const file = downloaded();
    const saved = await w.ok("PUT", "/v1/google/client", { text: file });
    assert.deepEqual(saved, { clientId: CLIENT_ID, replaced: false, googleSignIn: { available: true, redirectUri: REDIRECT } });
    assert.equal(await readFile(clientFile(), "utf8"), file, "the file as it was sent");
    assert.equal((await stat(clientFile())).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), [GOOGLE_CLIENT_FILE], "no temporary file left behind");
    assert.deepEqual((await w.ok("GET", "/v1/info", { token: null })).googleSignIn, { available: true, redirectUri: REDIRECT });
    const started = await w.ok("POST", "/v1/google/sign-ins", { body: {} });
    assert.equal(new URL(started.url).searchParams.get("client_id"), CLIENT_ID, "a sign-in uses it without a restart");
    assert.ok(w.infos.some((line) => /a person's device gave the server its Google client/.test(line)));
    nowhere(saved, started);
  });

  test("only a person's device: an agent gets needs_person, no token unauthorized, and nothing is written", async () => {
    const inbox = await w.ok("POST", "/v1/inboxes", { body: { name: "Work", color: "#277A40", provider: "imap", credentials: { mailbox: "me@acme.example" } } });
    const agent = await w.agent([inbox.id]);
    const refused = await put(downloaded(), "", agent);
    assert.deepEqual([refused.status, refused.body.error.code], [403, "needs_person"]);
    const anonymous = await put(downloaded(), "", null);
    assert.deepEqual([anonymous.status, anonymous.body.error.code], [401, "unauthorized"]);
    const setup = await w.call("GET", "/v1/google/setup", { token: agent });
    assert.deepEqual([setup.status, setup.body.error.code], [403, "needs_person"]);
    assert.equal(await exists(), false);
    nowhere(refused.body, anonymous.body);
  });

  test("a Desktop app client, a file that isn't one, one too large or a bad flag is refused in words, never echoed", async () => {
    const cases: Array<[string, string, RegExp]> = [
      [JSON.stringify({ installed: JSON.parse(downloaded()).web }), "", /Desktop app client.*Web application/],
      [`not json ${SECRET}`, "", /isn't a Google OAuth client file.*Google Cloud's console downloads/],
      ["", "", /isn't a Google OAuth client file/],
      [JSON.stringify({ web: { client_id: CLIENT_ID } }), "", /needs web\.client_id and web\.client_secret/],
      [JSON.stringify([SECRET]), "", /isn't a Google OAuth client file/],
      [downloaded({ padding: "x".repeat(GOOGLE_CLIENT_FILE_MAX_BYTES) }), "", /too large to be a Google client file/],
      [downloaded(), "?replace=maybe", /replace must be true or false/],
    ];
    for (const [text, query, words] of cases) {
      const res = await put(text, query);
      assert.deepEqual([res.status, res.body.error.code], [400, "invalid"], text.slice(0, 40));
      assert.match(res.body.error.message, words);
      nowhere(res.body);
    }
    assert.equal(await exists(), false, "nothing written");
    assert.deepEqual(w.errors, []);
  });

  test("replacing a client needs replace=true, with words for another client and for the same one", async () => {
    await w.ok("PUT", "/v1/google/client", { text: downloaded() });
    const other = downloaded({ client_id: "5678-def.apps.googleusercontent.example", client_secret: OTHER_SECRET });
    const refused = await put(other);
    assert.deepEqual([refused.status, refused.body.error.code], [409, "conflict"]);
    assert.match(refused.body.error.message, /already has another Google client.*stops every inbox connected by signing in with Google.* Confirm to replace it\.$/);
    const same = await put(downloaded({ client_secret: OTHER_SECRET }));
    assert.deepEqual([same.status, same.body.error.code], [409, "conflict"]);
    assert.match(same.body.error.message, /already has this Google client.*keeps its inboxes working\. Confirm to replace it\.$/);
    // The apps show these words above their own "Replace it" button: no flag in them.
    for (const message of [refused.body.error.message, same.body.error.message]) assert.doesNotMatch(message, /replace=|\(replace/);
    assert.equal(await readFile(clientFile(), "utf8"), downloaded(), "the first client stays");
    const kept = await put(other, "?replace=false");
    assert.equal(kept.status, 409);

    const replaced = await w.ok("PUT", "/v1/google/client?replace=true", { text: other });
    assert.deepEqual(replaced, { clientId: "5678-def.apps.googleusercontent.example", replaced: true, googleSignIn: { available: true, redirectUri: REDIRECT } });
    assert.equal(await readFile(clientFile(), "utf8"), other);
    assert.ok(w.infos.some((line) => /replaced the server's Google client/.test(line)));
    nowhere(refused.body, same.body, replaced);
  });

  test("a file Google downloaded before the address changed is saved, with the redirect hint", async () => {
    const saved = await w.ok("PUT", "/v1/google/client", { text: downloaded({ redirect_uris: ["http://localhost:3000/oauth2callback"] }) });
    assert.equal(saved.googleSignIn.available, true);
    assert.match(saved.redirectHint, /^The client file doesn't list http:\/\/127\.0\.0\.1:8585\/v1\/google\/callback among the client's redirect addresses/);
    assert.match(saved.redirectHint, /If Google refuses a sign-in, check that address at Google/);
    // A client typed in by hand lists no addresses: nothing to hint.
    const typed = await w.ok("PUT", "/v1/google/client?replace=true", { text: JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: SECRET } }) });
    assert.equal(typed.redirectHint, undefined);
  });

  test("while the environment gives the client, nothing is saved and the set-up says why", async () => {
    await w.close();
    w = await world(nodeGoogle({ clientId: "env-client.apps.googleusercontent.example", clientSecret: SECRET }));
    const refused = await put(downloaded());
    assert.deepEqual([refused.status, refused.body.error.code], [409, "conflict"]);
    assert.match(refused.body.error.message, /USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET.*win over a saved one.* Nothing was saved\.$/);
    assert.equal(await exists(), false);
    const setup = await w.ok("GET", "/v1/google/setup");
    assert.deepEqual(setup.client, {
      source: "environment",
      clientId: "env-client.apps.googleusercontent.example",
      changeable: false,
      reason: refused.body.error.message.replace(/ Nothing was saved\.$/, ""),
    });
    nowhere(refused.body, setup);
  });

  test("a server that keeps no client (demo mode) refuses, before reading the file", async () => {
    await w.close();
    w = await world(null);
    const refused = await put("not even json");
    assert.deepEqual([refused.status, refused.body.error.code], [409, "conflict"]);
    assert.match(refused.body.error.message, /keeps no Google client: it runs in demo mode.* Nothing was saved\.$/);
    const setup = await w.ok("GET", "/v1/google/setup");
    assert.deepEqual(setup.client, { source: "none", changeable: false, reason: refused.body.error.message.replace(/ Nothing was saved\.$/, "") });
  });

  test("a save that fails says so in the server's words, logs no part of the file, and changes nothing", async () => {
    await w.close();
    w = await world({ ...nodeGoogle(), saveClient: () => Promise.reject(new Error(`Couldn't write ${join(dir, GOOGLE_CLIENT_FILE)} (EACCES)`)) });
    const res = await put(downloaded());
    assert.deepEqual([res.status, res.body.error.code], [500, "internal"]);
    assert.match(res.body.error.message, /couldn't save the Google client, so nothing changed/);
    assert.equal(w.errors.length, 1);
    assert.match(w.errors[0]!, /EACCES/);
    nowhere(res.body);
    w.errors.length = 0;
  });
});

describe("GET /v1/google/setup", () => {
  test("serves core's prompt with this server's redirect address, and the manual steps", async () => {
    const setup: Json = await w.ok("GET", "/v1/google/setup");
    assert.deepEqual(setup.googleSignIn, { available: false, redirectUri: REDIRECT, missing: ["client"] });
    assert.deepEqual(setup.client, { source: "none", changeable: true });
    assert.equal(setup.prompt, googleSetupPrompt(REDIRECT));
    assert.match(setup.prompt, new RegExp(`^- Redirect address: ${REDIRECT.replaceAll(".", "\\.")}$`, "m"));
    assert.equal(setup.prompt.match(/\[FILL IN: /g).length, 2, "the Gmail addresses and the user type stay for the person");
    assert.equal(setup.promptNote, GOOGLE_SETUP_WORDS.promptNote);
    assert.equal(setup.noAddress, undefined);
    assert.deepEqual(setup.steps.map((step: Json) => step.id), ["project", "gmail_api", "branding", "audience", "scope", "client", "download"]);
    for (const step of setup.steps) {
      assert.ok(step.title && step.lines.length >= 1 && step.lines.length <= 2, step.id);
      assert.match(step.url, /^https:\/\/console\.cloud\.google\.com\//);
    }
    const copied = setup.steps.flatMap((step: Json) => (step.copy ?? []).map((value: Json) => value.value));
    assert.ok(copied.includes(REDIRECT) && copied.includes(GOOGLE_GMAIL_SCOPE) && copied.includes("Usual Mail (mine)") && copied.includes("Usual Mail server"));
  });

  test("once a client is saved it names its id, never the secret", async () => {
    await w.ok("PUT", "/v1/google/client", { text: downloaded() });
    const setup = await w.ok("GET", "/v1/google/setup");
    assert.deepEqual(setup.client, { source: "saved", clientId: CLIENT_ID, changeable: true });
    assert.deepEqual(setup.googleSignIn, { available: true, redirectUri: REDIRECT });
    nowhere(setup);
  });

  test("a server that doesn't know its own address says so instead of a prompt with a hole in it", async () => {
    redirect = null;
    const setup = await w.ok("GET", "/v1/google/setup");
    assert.deepEqual(setup.googleSignIn, { available: false, missing: ["client", "address"] });
    // Core's sentence, then Node's own words for what its host does (no addressFix given).
    assert.equal(setup.noAddress, `${GOOGLE_SETUP_WORDS.noAddress} ${GOOGLE_SETUP_WORDS.addressFix}`);
    assert.match(setup.noAddress, /USUAL_MAIL_PUBLIC_URL \(or --public-url\).*restarts it; no app can set it\.$/);
    for (const field of ["prompt", "promptNote", "steps"]) assert.equal(setup[field], undefined, field);
    // The client can still be given; the address stays the host's to set.
    assert.equal(setup.client.changeable, true);
  });
});
