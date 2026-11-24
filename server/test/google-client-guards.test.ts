// What keeps `PUT /v1/google/client` from doing harm (the review of 2026-11-21): a saved client file the server refuses,
// and inboxes signed in under another client, count as a client to replace, so nothing is replaced without the
// device's confirmation and `replaced` says so; the token is checked before the body is read and at most 16 KiB of it
// is read, with or without Content-Length; the Node host's save never reuses a file or link at its temporary name and
// cleans up after itself; a request's Host header never changes the redirect address; the served words fit the address.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createGmailProvider } from "@usualmail/mail";
import { FakeGoogle } from "@usualmail/mail/testing";
import type { GoogleClient } from "../src/google/config.ts";
import { GOOGLE_CLIENT_FILE, saveGoogleClientFile } from "../src/node/google.ts";
import { memoryFactory } from "../src/testing/index.ts";
import { startWorld, type Json, type World } from "./e2e/world.ts";
import { downloaded, nodeGoogle, REDIRECT, SECRET } from "./google-client-fixtures.ts";

const OTHER_ID = "5678-def.apps.googleusercontent.example";
const ENV_CLIENT: GoogleClient = { clientId: "env-client.apps.googleusercontent.example", clientSecret: "GOCSPX-env-client-secret" };
const ANA = "ana@gmail.example";

let dir: string;
let w: World;
let env: GoogleClient | null;
let redirect: string | null;
let google: FakeGoogle;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "usual-mail-google-guards-"));
  env = null;
  redirect = REDIRECT;
  google = new FakeGoogle({ ...ENV_CLIENT, redirectUris: [REDIRECT] });
  google.addAccount(ANA);
  w = await startWorld(
    {
      imap: memoryFactory(new Map()),
      gmail: (credentials, options) => createGmailProvider(credentials, { ...options, fetch: google.fetch, quotaPerSecond: 1_000_000 }),
    },
    { google: nodeGoogle(dir, { env: () => env, redirect: () => redirect, fetch: google.fetch }) },
  );
});
afterEach(async () => {
  await w.close();
  await rm(dir, { recursive: true, force: true });
});

const put = (text: string, query = "") => w.call("PUT", `/v1/google/client${query}`, { text });
const clientFile = () => join(dir, GOOGLE_CLIENT_FILE);
const temporaries = async () => (await readdir(dir)).filter((name) => name.endsWith(".tmp"));

/** Ana's Gmail connected by signing in with Google, through the fake, with whatever client the server has now. */
async function signInAna(): Promise<string> {
  const started = await w.ok("POST", "/v1/google/sign-ins", { body: {} });
  const answer = await google.fetch(started.url, { method: "GET" });
  const back = new URL(answer.headers.get("location")!);
  await w.call("GET", back.pathname + back.search, { token: null });
  await w.idle();
  const outcome = await w.ok("GET", `/v1/google/sign-ins/${started.id}`);
  assert.equal(outcome.state, "connected", JSON.stringify(outcome));
  return outcome.inboxId;
}

describe("What counts as a client to replace", () => {
  test("a saved file the server refuses (others can read it) is replaced only once the device confirms", async () => {
    await writeFile(clientFile(), downloaded({ client_id: OTHER_ID }), { mode: 0o644 });
    await chmod(clientFile(), 0o644);
    assert.deepEqual((await w.ok("GET", "/v1/info", { token: null })).googleSignIn.missing, ["client"]);
    const setup = await w.ok("GET", "/v1/google/setup");
    assert.equal(setup.client.source, "none");
    assert.match(setup.client.note, /A Google client file is saved, but the server doesn't use it: other users can read it \(its host runs chmod 600 on google-client\.json/);

    const refused = await put(downloaded());
    assert.deepEqual([refused.status, refused.body.error.code], [409, "conflict"]);
    assert.match(refused.body.error.message, /already has a Google client file, so nothing was saved\. It doesn't use that file: other users can read it.*chmod 600.* Confirm to replace it\.$/);
    assert.doesNotMatch(refused.body.error.message, /replace=/);
    assert.ok(!refused.body.error.message.includes(SECRET));
    assert.equal(JSON.parse(await readFile(clientFile(), "utf8")).web.client_id, OTHER_ID, "the file is left as it was");

    const replaced = await w.ok("PUT", "/v1/google/client?replace=true", { text: downloaded() });
    assert.equal(replaced.replaced, true, "a file was overwritten");
    assert.equal(replaced.googleSignIn.available, true);
    assert.equal((await stat(clientFile())).mode & 0o777, 0o600);
    assert.equal(await readFile(clientFile(), "utf8"), downloaded());
  });

  test("a saved Desktop app client's file counts too", async () => {
    await writeFile(clientFile(), JSON.stringify({ installed: { client_id: OTHER_ID, client_secret: SECRET } }), { mode: 0o600 });
    const refused = await put(downloaded());
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /doesn't use that file: it holds a Desktop app client/);
    assert.match((await w.ok("GET", "/v1/google/setup")).client.note, /Desktop app client/);
    assert.equal((await w.ok("PUT", "/v1/google/client?replace=true", { text: downloaded() })).replaced, true);
  });

  test("inboxes signed in under another client count, after the host took the environment's client away", async () => {
    env = { ...ENV_CLIENT };
    const ana = await signInAna();
    env = null; // The host removed USUAL_MAIL_GOOGLE_CLIENT_ID and _SECRET and restarted: no client, no file.
    const setup = await w.ok("GET", "/v1/google/setup");
    assert.deepEqual([setup.client.source, setup.client.changeable], ["none", true]);
    assert.match(setup.client.note, /^1 inbox connected by signing in with Google uses a Google client this server doesn't have now \(env-client\.apps\.googleusercontent\.example\)/);

    const refused = await put(downloaded());
    assert.deepEqual([refused.status, refused.body.error.code], [409, "conflict"]);
    assert.match(refused.body.error.message, /^1 inbox connected by signing in with Google uses another Google client \(env-client\.apps\.googleusercontent\.example\), so nothing was saved: with this one it won't sync until it is signed in with Google again\. Confirm to save it anyway\.$/);
    await assert.rejects(stat(clientFile()), "nothing written");

    // The same client again strands nobody: saved without asking, nothing replaced.
    const same = await w.ok("PUT", "/v1/google/client", { text: downloaded({ client_id: ENV_CLIENT.clientId, client_secret: ENV_CLIENT.clientSecret }) });
    assert.deepEqual([same.clientId, same.replaced], [ENV_CLIENT.clientId, false]);
    assert.equal((await w.ok("GET", "/v1/google/setup")).client.note, undefined);
    await w.sync(ana);
    assert.equal((await w.ok("GET", "/v1/inboxes")).find((inbox: Json) => inbox.id === ana).status, "ok", "the inbox syncs with it");

    // Another client, confirmed: saved, and `replaced` says the inbox must sign in again.
    const other = await w.ok("PUT", "/v1/google/client?replace=true", { text: downloaded() });
    assert.equal(other.replaced, true);
    assert.match((await w.ok("GET", "/v1/google/setup")).client.note, /env-client\.apps\.googleusercontent\.example/);
  });
});

describe("Reading the body", () => {
  const big = "x".repeat(20_000);

  test("with Content-Length: the token first, then the size, before anything is read", async () => {
    const headers = { "content-type": "application/json", "content-length": String(big.length) };
    const anonymous = await w.fetch("/v1/google/client", { method: "PUT", headers, body: big });
    assert.equal(anonymous.status, 401);
    const person = await w.fetch("/v1/google/client", { method: "PUT", headers: { ...headers, authorization: `Bearer ${w.personToken}` }, body: big });
    assert.equal(person.status, 400);
    assert.match(((await person.json()) as Json).error.message, /too large to be a Google client file/);
  });

  test("without Content-Length: nothing read before the token, and no more than 16 KiB after it", async () => {
    const inbox = await w.ok("POST", "/v1/inboxes", { body: { name: "Work", color: "#277A40", provider: "imap", credentials: { mailbox: "me@acme.example" } } });
    const agent = await w.agent([inbox.id]);
    /** A body of 1 MiB in 1 KiB chunks that counts what was pulled from it. */
    const stream = () => {
      const counter = { pulled: 0 };
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (counter.pulled >= 1024 * 1024) return controller.close();
          counter.pulled += 1024;
          controller.enqueue(new Uint8Array(1024).fill(0x78));
        },
      });
      return { counter, body };
    };
    const send = async (token: string | null) => {
      const { counter, body } = stream();
      const headers: Record<string, string> = { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) };
      const res = await w.fetch("/v1/google/client", { method: "PUT", headers, body, duplex: "half" } as RequestInit);
      return { status: res.status, body: (await res.json()) as Json, pulled: counter.pulled };
    };
    const anonymous = await send(null);
    assert.equal(anonymous.status, 401);
    assert.ok(anonymous.pulled <= 2 * 1024, `read ${anonymous.pulled} bytes before the token was checked`);
    const agents = await send(agent);
    assert.equal(agents.status, 403);
    assert.ok(agents.pulled <= 2 * 1024, `read ${agents.pulled} bytes of an agent's body`);
    const person = await send(w.personToken);
    assert.equal(person.status, 400);
    assert.match(person.body.error.message, /too large to be a Google client file/);
    assert.ok(person.pulled <= 18 * 1024, `read ${person.pulled} bytes, not the general 2 MB`);
  });
});

describe("The Node host's save", () => {
  test("never writes through a file or link already at its temporary name, and leaves it there", async () => {
    const elsewhere = join(dir, "elsewhere.txt");
    await writeFile(elsewhere, "keep");
    await symlink(elsewhere, `${clientFile()}.fixed.tmp`);
    await assert.rejects(saveGoogleClientFile(dir, downloaded(), "fixed"), (error: Error) => {
      assert.match(error.message, /Couldn't write .*google-client\.json \(EEXIST\)/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
    assert.equal(await readFile(elsewhere, "utf8"), "keep");
    assert.deepEqual(await temporaries(), ["google-client.json.fixed.tmp"], "someone else's link is not removed");
    await assert.rejects(stat(clientFile()));
    // The name the save once used (the process id) can't be planted: it picks a new random name each time.
    await symlink(elsewhere, `${clientFile()}.${process.pid}.tmp`);
    await saveGoogleClientFile(dir, downloaded());
    assert.equal(await readFile(elsewhere, "utf8"), "keep");
    assert.equal(await readFile(clientFile(), "utf8"), downloaded());
    assert.equal((await stat(clientFile())).mode & 0o777, 0o600);
  });

  test("a save that fails removes its temporary file, through the route too", async () => {
    await mkdir(clientFile(), { mode: 0o700 }); // A directory where the file goes: the rename fails.
    await assert.rejects(saveGoogleClientFile(dir, downloaded()), /Couldn't write/);
    assert.deepEqual(await temporaries(), []);
    const res = await put(downloaded(), "?replace=true");
    assert.deepEqual([res.status, res.body.error.code], [500, "internal"]);
    assert.deepEqual(await temporaries(), []);
    assert.ok(w.errors.every((line) => !line.includes(SECRET)));
    w.errors.length = 0;
  });
});

describe("The redirect address and the words around it", () => {
  test("a request's Host header doesn't change the redirect address", async () => {
    const spoofed = { authorization: `Bearer ${w.personToken}`, host: "mail.attacker.example", "x-forwarded-host": "mail.attacker.example", "x-forwarded-proto": "https" };
    const setup = (await (await w.fetch("http://mail.attacker.example/v1/google/setup", { headers: spoofed })).json()) as Json;
    assert.equal(setup.googleSignIn.redirectUri, REDIRECT);
    assert.ok(setup.prompt.includes(`- Redirect address: ${REDIRECT}\n`));
    assert.ok(!JSON.stringify(setup).includes("attacker"));
    const saved = (await (await w.fetch("http://mail.attacker.example/v1/google/client", { method: "PUT", headers: spoofed, body: downloaded() })).json()) as Json;
    assert.equal(saved.googleSignIn.redirectUri, REDIRECT);
  });

  test("the client step fits the address: http on this machine, localhost named as written, https elsewhere", async () => {
    const step = async () => ((await w.ok("GET", "/v1/google/setup")).steps as Json[]).find((s) => s.id === "client");
    for (const address of [REDIRECT, "http://localhost:8484/v1/google/callback"]) {
      redirect = address;
      const words = (await step()).lines[1];
      assert.match(words, /http, not https/);
      assert.match(words, /the host exactly as written \(127\.0\.0\.1 and localhost are not the same to Google\)/);
      assert.doesNotMatch(words, /127\.0\.0\.1 is not localhost/);
    }
    redirect = "https://mail.example.org/v1/google/callback";
    const words = (await step()).lines[1];
    assert.equal(words, "It must match to the character: copy it as it is, with no slash at the end.");
    const prompt = (await w.ok("GET", "/v1/google/setup")).prompt;
    assert.doesNotMatch(prompt, /127\.0\.0\.1 stays 127\.0\.0\.1/);
    assert.match((await w.ok("GET", "/v1/google/setup")).steps.find((s: Json) => s.id === "audience").lines[1], /the weekly sign-in doesn't apply/);
  });
});

