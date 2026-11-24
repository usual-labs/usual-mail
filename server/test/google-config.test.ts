// How the Node host gives the server Google sign-in: the client from the environment or from the file Google's console
// downloads (owner-only, never printed), the server's own address from its settings (never from a request), and the
// development-only switch that sends Google's addresses to a fake.

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readConfig } from "../src/node/config.ts";
import { fakeGoogleFetch, GOOGLE_CLIENT_FILE, googleClientSource, redirectUriFor } from "../src/node/google.ts";

const SECRET = "GOCSPX-a-secret-nobody-prints";
const DOWNLOADED = {
  web: {
    client_id: "1234-abc.apps.googleusercontent.com",
    project_id: "usual-mail-owner",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_secret: SECRET,
    redirect_uris: ["http://127.0.0.1:8585/v1/google/callback"],
  },
};

describe("The server's own address", () => {
  test("defaults to the loopback address it listens on, and is never guessed for another host", () => {
    const config = readConfig(["--port", "8585"], {});
    assert.equal(config.publicUrl, null);
    assert.equal(redirectUriFor(config, 8585), "http://127.0.0.1:8585/v1/google/callback");
    assert.equal(redirectUriFor(readConfig(["--host", "localhost"], {}), 8484), "http://localhost:8484/v1/google/callback");
    assert.equal(redirectUriFor(readConfig(["--host", "::1"], {}), 8484), "http://[::1]:8484/v1/google/callback");
    assert.equal(redirectUriFor(readConfig(["--host", "0.0.0.0"], {}), 8484), null, "a server on every address doesn't know its name");
  });

  test("comes from --public-url or USUAL_MAIL_PUBLIC_URL: an origin, HTTPS unless it is this machine", () => {
    const set = readConfig(["--host", "0.0.0.0", "--public-url", "https://mail.example.org/"], {});
    assert.equal(set.publicUrl, "https://mail.example.org");
    assert.equal(redirectUriFor(set, 8484), "https://mail.example.org/v1/google/callback");
    assert.equal(readConfig([], { USUAL_MAIL_PUBLIC_URL: "http://127.0.0.1:8585" }).publicUrl, "http://127.0.0.1:8585");
    for (const bad of ["http://mail.example.org", "https://mail.example.org/mail", "https://mail.example.org/?x=1", "https://user:pw@mail.example.org", "mail.example.org"]) {
      assert.throws(() => readConfig(["--public-url", bad], {}), /--public-url/, bad);
    }
  });
});

describe("The development switch for a fake Google", () => {
  test("is refused off this machine, in production, or pointing anywhere but this machine", () => {
    assert.equal(readConfig(["--dev-fake-google", "http://127.0.0.1:9999"], {}).devFakeGoogle, "http://127.0.0.1:9999");
    assert.throws(() => readConfig(["--dev-fake-google", "http://127.0.0.1:9999", "--host", "0.0.0.0"], {}), /dev-fake-google is for development on this machine only/);
    assert.throws(() => readConfig(["--dev-fake-google", "http://127.0.0.1:9999"], { NODE_ENV: "production" }), /NODE_ENV=production/);
    assert.throws(() => readConfig(["--dev-fake-google", "https://oauth2.googleapis.com"], {}), /on this machine/);
  });

  test("sends Google's token, revocation and Gmail addresses to the fake, and nothing else anywhere", async () => {
    const seen: string[] = [];
    const fetch = fakeGoogleFetch("http://127.0.0.1:9999", async (input) => {
      seen.push(String(input));
      return new Response("{}");
    });
    await fetch("https://oauth2.googleapis.com/token", { method: "POST" });
    await fetch("https://oauth2.googleapis.com/revoke", { method: "POST" });
    await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { method: "GET" });
    assert.deepEqual(seen, ["http://127.0.0.1:9999/token", "http://127.0.0.1:9999/revoke", "http://127.0.0.1:9999/gmail/v1/users/me/profile"]);
    await assert.rejects(fetch("https://example.org/", { method: "GET" }), /fake Google/);
  });
});

describe("The host's Google client", () => {
  let dir: string;
  let logged: string[];
  const log = { info: (line: string) => logged.push(line), error: (line: string) => logged.push(line) };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "usual-mail-google-"));
    logged = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function file(content: unknown, mode = 0o600): Promise<void> {
    const path = join(dir, GOOGLE_CLIENT_FILE);
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), { mode });
    await chmod(path, mode);
  }
  const source = (env: Record<string, string> = {}) =>
    googleClientSource({ dataDir: dir, env: readConfig([], env).googleClient, log, redirectUri: () => "http://127.0.0.1:8585/v1/google/callback" });

  test("is read from the file as Google's console downloads it, owner-only, without printing it", async () => {
    assert.equal(await source()(), null, "no file: not set up, and nothing to say");
    assert.deepEqual(logged, []);
    await file(DOWNLOADED);
    assert.deepEqual(await source()(), { clientId: "1234-abc.apps.googleusercontent.com", clientSecret: SECRET });
    assert.deepEqual(logged, []);
  });

  test("a file others can read, a desktop client, or a file that isn't one is refused with words, never its contents", async () => {
    await file(DOWNLOADED, 0o644);
    const open = source();
    assert.equal(await open(), null);
    assert.equal(await open(), null);
    assert.equal(logged.length, 1, "said once, not at every read");
    assert.match(logged[0]!, /other users can read .*google-client\.json.*chmod 600/);
    await file({ installed: DOWNLOADED.web });
    assert.equal(await source()(), null);
    assert.match(logged.at(-1)!, /Desktop app.*Web application/);
    await file("not json");
    assert.equal(await source()(), null);
    assert.match(logged.at(-1)!, /isn't a Google OAuth client file/);
    for (const line of logged) assert.ok(!line.includes(SECRET) && !line.includes("1234-abc"), line);
  });

  test("says when the file names other redirect addresses than this server's, as a hint, not a failure foretold", async () => {
    await file({ web: { ...DOWNLOADED.web, redirect_uris: ["http://localhost:3000/oauth2callback"] } });
    assert.ok(await source()(), "the client is used all the same");
    const said = logged.join("\n");
    assert.match(said, /doesn't list http:\/\/127\.0\.0\.1:8585\/v1\/google\/callback/);
    // The file is frozen when it is downloaded; Google's own record of the client is what counts.
    assert.match(said, /older than a change made at Google/);
    assert.match(said, /If Google refuses a sign-in, check that address at Google/);
    assert.doesNotMatch(said, /will fail|or sign-ins/);
  });

  test("the environment wins over the file; one of its two variables alone is refused at start", async () => {
    await file(DOWNLOADED);
    const env = { USUAL_MAIL_GOOGLE_CLIENT_ID: "env-id.apps.googleusercontent.com", USUAL_MAIL_GOOGLE_CLIENT_SECRET: "env-secret" };
    assert.deepEqual(await source(env)(), { clientId: "env-id.apps.googleusercontent.com", clientSecret: "env-secret" });
    assert.throws(() => readConfig([], { USUAL_MAIL_GOOGLE_CLIENT_ID: "only-the-id" }), (error: Error) => {
      assert.match(error.message, /USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET/);
      assert.ok(!error.message.includes("only-the-id"));
      return true;
    });
  });
});
