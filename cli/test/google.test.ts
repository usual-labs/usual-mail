// Google sign-in from the command: giving the server its Google client (`google set`, the secret read unseen and
// never echoed, the file owner-only), what the server says about it (`google`), connecting and reconnecting Gmail by
// signing in (`inbox add`, `inbox reconnect`), and `doctor`'s check.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { googleSetupPrompt } from "@usualmail/core";
import { writeOwnerOnly } from "../src/commands/google.ts";
import type { Runner } from "../src/runner.ts";
import { allFiles, mode, noRunner, run, savedConfig, scratch, type Options } from "./helpers.ts";
import { StandIn } from "./stand-in.ts";

const SECRET = "GOCSPX-never-shown-anywhere";
const DOWNLOADED = {
  web: {
    client_id: "1234-abc.apps.googleusercontent.com",
    project_id: "usual-mail-owner",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    client_secret: SECRET,
    redirect_uris: ["http://127.0.0.1:18585/v1/google/callback"],
  },
};

let home: { dir: string; remove: () => void };
let server: StandIn;
let options: Options;
let dataDir: string;

before(() => {
  home = scratch();
});
after(async () => {
  await server.close();
  home.remove();
});
beforeEach(async () => {
  await server?.close();
  server = new StandIn();
  await server.listen();
  const me = server.addDevice("person", "usual-mail on test-machine");
  dataDir = join(home.dir, "data-" + Math.random().toString(36).slice(2));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  savedConfig(home.dir, { server: server.url, token: me.token, deviceId: me.device.id, run: { mode: "node", dataDir, port: 18585 } });
  options = { home: home.dir };
});

function assertNowhere(secret: string, printed: string): void {
  assert.ok(!printed.includes(secret), "printed");
  for (const file of allFiles(home.dir)) {
    // The server's client file holds it on purpose, and so does the file the person downloaded from Google.
    if (file.path.endsWith("google-client.json") || file.path.includes("client_secret_") || file.path.endsWith("desktop.json")) continue;
    assert.ok(!file.text.includes(secret), `in ${file.path}`);
  }
}

/** A runner that records the programs it is asked to run, as opening a browser does. */
function recording(): { runner: Runner; ran: Array<{ command: string; args: string[] }> } {
  const ran: Array<{ command: string; args: string[] }> = [];
  return { ran, runner: { ...noRunner, run: async (command, args) => (ran.push({ command, args }), { code: 0, stdout: "", stderr: "" }) } };
}

test("google set --file puts the client Google's console downloaded into the data directory, owner-only, unprinted", async () => {
  const downloaded = join(home.dir, "client_secret_1234-abc.apps.googleusercontent.com.json");
  writeFileSync(downloaded, JSON.stringify(DOWNLOADED), { mode: 0o644 });
  server.google = { available: true, redirectUri: "http://127.0.0.1:18585/v1/google/callback" };
  const ran = await run(["google", "set", "--file", downloaded], options);
  assert.equal(ran.code, 0, ran.stderr);
  const file = join(dataDir, "google-client.json");
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(DOWNLOADED), "the file as Google downloads it");
  assert.equal(mode(file), 0o600);
  assert.match(ran.stdout, /Google sign-in is available/);
  assert.match(ran.stdout, /http:\/\/127\.0\.0\.1:18585\/v1\/google\/callback/);
  assert.match(ran.stdout, /seven days/);
  assert.match(ran.stdout, /restricted/);
  assertNowhere(SECRET, ran.stdout + ran.stderr);
});

test("google set asks for the id and the secret unseen, or reads the secret from standard input", async () => {
  const asked = await run(["google", "set"], { ...options, interactive: true, answers: ["1234-abc.apps.googleusercontent.com", SECRET] });
  assert.equal(asked.code, 0, asked.stderr);
  assert.deepEqual(asked.questions.map((q) => q.startsWith("(secret)")), [false, true]);
  const written = JSON.parse(readFileSync(join(dataDir, "google-client.json"), "utf8"));
  assert.deepEqual(written, { web: { client_id: "1234-abc.apps.googleusercontent.com", client_secret: SECRET } });
  assertNowhere(SECRET, asked.stdout + asked.stderr);

  const piped = await run(["google", "set", "--client-id", "5678.apps.googleusercontent.com", "--secret-stdin"], { ...options, stdin: `${SECRET}\n` });
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(JSON.parse(readFileSync(join(dataDir, "google-client.json"), "utf8")).web.client_id, "5678.apps.googleusercontent.com");
  assertNowhere(SECRET, piped.stdout + piped.stderr);

  const bare = await run(["google", "set"], options);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /--file.*--client-id.*--secret-stdin/);
  const typed = await run(["google", "set", "--client-id", "x", "--secret", SECRET], options);
  assert.equal(typed.code, 2);
  assert.ok(!typed.stderr.includes(SECRET), "a secret on the command line isn't repeated");
});

test("google set refuses a desktop client, a file that isn't one, and an unknown data directory, and writes nothing", async () => {
  const desktop = join(home.dir, "desktop.json");
  writeFileSync(desktop, JSON.stringify({ installed: DOWNLOADED.web }));
  const ran = await run(["google", "set", "--file", desktop], options);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /Desktop app.*Web application/);
  const junk = join(home.dir, "junk.json");
  writeFileSync(junk, "not json");
  assert.match((await run(["google", "set", "--file", junk], options)).stderr, /isn't a Google OAuth client file/);
  assert.ok(!existsSync(join(dataDir, "google-client.json")));
  savedConfig(home.dir, { server: server.url, token: server.devices[0]!.token });
  const nowhere = await run(["google", "set", "--file", desktop], options);
  assert.equal(nowhere.code, 2);
  assert.match(nowhere.stderr, /--data-dir/);
});

test("google says what the server has, and exactly what the host must still do", async () => {
  const off = await run(["google"], options);
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, /off/);
  assert.match(off.stdout, /usual-mail google set/);
  assert.match(off.stdout, /Web application/);
  assert.match(off.stdout, /http:\/\/127\.0\.0\.1:18585\/v1\/google\/callback/);
  server.google = { available: false, missing: ["address"] };
  assert.match((await run(["google"], options)).stdout, /USUAL_MAIL_PUBLIC_URL/);
  server.google = { available: true, redirectUri: "http://127.0.0.1:18585/v1/google/callback" };
  const json = await run(["google", "--json"], options);
  assert.deepEqual(JSON.parse(json.stdout), server.google);
});

test("google set checks the file as the server does: a client id or secret of spaces is refused", async () => {
  const blank = join(home.dir, "client_secret_blank.json");
  writeFileSync(blank, JSON.stringify({ web: { ...DOWNLOADED.web, client_id: "   " } }));
  const ran = await run(["google", "set", "--file", blank], options);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /needs web\.client_id and web\.client_secret/);
  assert.ok(!existsSync(join(dataDir, "google-client.json")));
  assertNowhere(SECRET, ran.stdout + ran.stderr);
});

test("google set never writes through a file or link at its temporary name, and cleans up when it fails", async () => {
  const target = join(dataDir, "google-client.json");
  const elsewhere = join(home.dir, "elsewhere.txt");
  writeFileSync(elsewhere, "keep");
  symlinkSync(elsewhere, `${target}.fixed.tmp`);
  assert.throws(() => writeOwnerOnly(target, JSON.stringify(DOWNLOADED), "fixed"), /Couldn't write .*google-client\.json \(EEXIST\)/);
  assert.equal(readFileSync(elsewhere, "utf8"), "keep");
  assert.ok(existsSync(`${target}.fixed.tmp`), "someone else's link is left alone");
  assert.ok(!existsSync(target));
  rmSync(`${target}.fixed.tmp`);

  // A directory where the file goes: the rename fails, the command says so, and no temporary file stays behind.
  mkdirSync(target);
  const downloaded = join(home.dir, "client_secret_dir.json");
  writeFileSync(downloaded, JSON.stringify(DOWNLOADED));
  const ran = await run(["google", "set", "--file", downloaded], options);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /Couldn't write .*google-client\.json/);
  assert.deepEqual(readdirSync(dataDir).filter((name) => name.endsWith(".tmp")), []);
  assertNowhere(SECRET, ran.stdout + ran.stderr);
});

test("google prompt prints the browser agent's prompt with the server's redirect address filled in", async () => {
  const ran = await run(["google", "prompt"], options);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.stdout, `${googleSetupPrompt("http://127.0.0.1:18585/v1/google/callback")}\n`, "the prompt alone, ready to copy");
  assert.match(ran.stdout, /^- Redirect address: http:\/\/127\.0\.0\.1:18585\/v1\/google\/callback$/m);
  assert.equal(ran.stdout.match(/\[FILL IN: /g)?.length, 2, "the person fills in the addresses and the user type");
  assert.match(ran.stderr, /fill in the two lines that still say FILL IN/);
  assert.equal(server.calls("googleSetup").length, 1);

  const json = await run(["google", "prompt", "--json"], options);
  assert.equal(json.code, 0, json.stderr);
  const setup = JSON.parse(json.stdout);
  assert.equal(setup.prompt, googleSetupPrompt("http://127.0.0.1:18585/v1/google/callback"));
  assert.equal(setup.steps.length, 7);
});

test("google prompt says why there is none when the server doesn't know its address, or is too old", async () => {
  server.google = { available: false, missing: ["client", "address"] };
  const ran = await run(["google", "prompt"], options);
  assert.equal(ran.code, 1);
  assert.equal(ran.stdout, "");
  assert.match(ran.stderr, /doesn't know its own address.*USUAL_MAIL_PUBLIC_URL/);

  server.failNext("googleSetup", "not_found", "No such route");
  const old = await run(["google", "prompt"], options);
  assert.equal(old.code, 1);
  assert.match(old.stderr, /older than this command/);
});

test("a client file that doesn't list the server's address is a hint in google, google set and doctor, never a failure", async () => {
  // Downloaded before the redirect address was changed at Google: the file is frozen, and Google's own list counts.
  const older = { web: { ...DOWNLOADED.web, redirect_uris: ["http://localhost:3000/oauth2callback"] } };
  writeFileSync(join(dataDir, "google-client.json"), JSON.stringify(older), { mode: 0o600 });
  server.google = { available: true, redirectUri: "http://127.0.0.1:18585/v1/google/callback" };
  const hint = (text: string) => {
    assert.match(text, /doesn't list http:\/\/127\.0\.0\.1:18585\/v1\/google\/callback among the client's redirect addresses/);
    assert.match(text, /The file may simply be older than a change made at Google/);
    assert.match(text, /If Google refuses a sign-in, check that address at Google/);
    assert.doesNotMatch(text, /will fail|add exactly that address/);
  };

  const status = await run(["google"], options);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Google sign-in is available/);
  hint(status.stdout);

  const downloaded = join(home.dir, "client_secret_older.json");
  writeFileSync(downloaded, JSON.stringify(older));
  const set = await run(["google", "set", "--file", downloaded], options);
  assert.equal(set.code, 0, set.stderr);
  hint(set.stdout);

  const doctor = await run(["doctor", "--json"], options);
  const google = JSON.parse(doctor.stdout).checks.find((check: { name: string }) => check.name === "google");
  assert.equal(google.level, "ok", "Google accepted sign-ins all the same: nothing to fix");
  hint(google.note);
  const words = await run(["doctor"], options);
  assert.match(words.stdout, /^ok    google: .*\n {6}.*doesn't list/m);

  // The file that lists it says nothing more.
  writeFileSync(join(dataDir, "google-client.json"), JSON.stringify(DOWNLOADED), { mode: 0o600 });
  assert.doesNotMatch((await run(["google"], options)).stdout, /doesn't list/);
  assert.equal(JSON.parse((await run(["doctor", "--json"], options)).stdout).checks.find((check: { name: string }) => check.name === "google").note, undefined);
});

test("inbox add signs in with Google when the server can: opens the browser, waits, and says what happened", async () => {
  server.google = { available: true, redirectUri: "http://127.0.0.1:18585/v1/google/callback" };
  const { runner, ran: opened } = recording();
  const ran = await run(["inbox", "add", "--provider", "gmail", "--name", "Ana", "--color", "green", "--trust", "act_with_undo"], { ...options, runner });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(server.calls("startGoogleSignIn")[0]!.body, { name: "Ana", color: "#277a40" });
  assert.equal(opened.length, 1);
  assert.match(opened[0]!.args.join(" "), /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(ran.stderr, /Sign in with Google/);
  assert.match(ran.stdout, /Connected .*Ana \(ana@gmail\.example\)/);
  assert.equal(server.calls("connectInbox").length, 0, "no client id, secret or token was asked for or sent");
  assert.equal(server.inboxes[0]!.trust, "act_with_undo", "the trust asked for is set afterwards");
  assert.ok(server.calls("googleSignIn").length >= 3, "it waited for the outcome");
});

test("inbox add --no-browser prints the address only; a failed sign-in says why and exits 1", async () => {
  server.google = { available: true, redirectUri: "http://127.0.0.1:18585/v1/google/callback" };
  server.signInPlan = { address: "ana@gmail.example", ends: "declined", polls: 1 };
  const ran = await run(["inbox", "add", "--provider", "gmail", "--name", "Ana", "--color", "green", "--no-browser"], options);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /https:\/\/accounts\.google\.com\//);
  assert.match(ran.stderr, /declined/);
  assert.deepEqual(server.inboxes, []);
});

test("inbox add pastes a client id, secret and token when asked to, or when the server can't sign in", async () => {
  server.google = { available: true, redirectUri: "http://127.0.0.1:18585/v1/google/callback" };
  const ran = await run(["inbox", "add", "--provider", "gmail", "--name", "Ana", "--color", "green", "--client-id", "own.apps.example", "--secrets-stdin"], { ...options, stdin: "secret\nrefresh\n" });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(server.calls("startGoogleSignIn").length, 0);
  assert.equal(server.calls("connectInbox").length, 1);
  server.google = { available: false, missing: ["client"] };
  const off = await run(["inbox", "add", "--provider", "gmail", "--name", "Bo", "--color", "blue"], options);
  assert.equal(off.code, 2);
  assert.match(off.stderr, /--client-id/);
});

test("inbox reconnect signs a Gmail inbox in again with Google, in place; another account is refused", async () => {
  server.google = { available: true, redirectUri: "http://127.0.0.1:18585/v1/google/callback" };
  const ana = server.addInbox({ name: "Ana", address: "ana@gmail.example", provider: "gmail", status: "needs_attention", statusDetail: "Google no longer accepts this inbox's sign-in. Sign in with Google again." });
  const ran = await run(["inbox", "reconnect", "Ana", "--no-browser"], options);
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(server.calls("startGoogleSignIn")[0]!.body, { inboxId: ana.id });
  assert.match(ran.stdout, /Reconnected Ana .*Its rules and history stay/);
  assert.equal(server.calls("updateInbox").length, 0);

  server.signInPlan = { address: "bo@gmail.example", ends: "connected", polls: 0 };
  const wrong = await run(["inbox", "reconnect", "Ana", "--no-browser"], options);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /bo@gmail\.example.*ana@gmail\.example/);

  // In a terminal it asks first; no means the client id, secret and token.
  const asked = await run(["inbox", "reconnect", "Ana", "--no-browser"], { ...options, interactive: true, answers: ["n", "", "secret", "refresh"] });
  assert.equal(asked.code, 0, asked.stderr);
  assert.match(asked.questions[0]!, /Sign in with Google/);
  assert.equal(server.calls("updateInbox").length, 1);
});

test("doctor says whether Google sign-in is set up, what to do if not, and refuses a client file others can read", async () => {
  const off = await run(["doctor", "--json"], options);
  const google = JSON.parse(off.stdout).checks.find((check: { name: string }) => check.name === "google");
  assert.equal(google.level, "warn");
  assert.match(google.fix, /usual-mail google set/);
  assert.match(google.fix, /http:\/\/127\.0\.0\.1:18585\/v1\/google\/callback/);

  writeFileSync(join(dataDir, "google-client.json"), JSON.stringify(DOWNLOADED));
  chmodSync(join(dataDir, "google-client.json"), 0o644);
  const loose = JSON.parse((await run(["doctor", "--json"], options)).stdout).checks.find((check: { name: string }) => check.name === "google");
  assert.equal(loose.level, "fail");
  assert.match(loose.fix, /chmod 600/);

  chmodSync(join(dataDir, "google-client.json"), 0o600);
  server.google = { available: true, redirectUri: "http://127.0.0.1:18585/v1/google/callback" };
  const on = JSON.parse((await run(["doctor", "--json"], options)).stdout).checks.find((check: { name: string }) => check.name === "google");
  assert.equal(on.level, "ok");
  assert.match(on.text, /seven days/);
  assertNowhere(SECRET, JSON.stringify(on) + JSON.stringify(loose));
});
