// Secrets stay secret: mailbox passwords are sent once and never printed or stored, the command's own token is
// never printed, hidden questions don't echo, and the settings file is owner-only.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, test } from "node:test";
import { writeConfig } from "../src/config.ts";
import { terminalPrompter } from "../src/prompt.ts";
import { allFiles, configPath, context, mode, run, savedConfig, scratch, type Options } from "./helpers.ts";
import { StandIn } from "./stand-in.ts";

const PASSWORD = "Sup3r-Secret-Pw!";
const SMTP_PASSWORD = "0ther-Smtp-Secret";
const imapFlags = [
  "inbox", "add", "--provider", "imap", "--name", "Acme", "--color", "teal", "--address", "ana@acme.example",
  "--imap-host", "imap.acme.example", "--smtp-host", "smtp.acme.example", "--secrets-stdin",
];

let home: { dir: string; remove: () => void };
let server: StandIn;
let me: { device: { id: string }; token: string };
let options: Options;

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
  me = server.addDevice("person", "usual-mail on test-machine");
  savedConfig(home.dir, { server: server.url, token: me.token, deviceId: me.device.id });
  options = { home: home.dir };
});

/** Fails when a secret appears in what was printed or in any file under the home directory. */
function assertNowhere(secret: string, printed: string): void {
  assert.ok(!printed.includes(secret), "printed");
  for (const file of allFiles(home.dir)) assert.ok(!file.text.includes(secret), `in ${file.path}`);
}

test("a mailbox password is sent once and is never printed or stored, plain or --json", async () => {
  for (const json of [false, true]) {
    const ran = await run(json ? [...imapFlags, "--json"] : imapFlags, { ...options, stdin: `${PASSWORD}\n${SMTP_PASSWORD}\n` });
    assert.equal(ran.code, 0, ran.stderr);
    assertNowhere(PASSWORD, ran.stdout + ran.stderr);
    assertNowhere(SMTP_PASSWORD, ran.stdout + ran.stderr);
  }
  const requests = server.requests.filter((request) => request.text.includes(PASSWORD));
  assert.equal(requests.length, 2, "one connect request per run, and no other request carries it");
  assert.ok(requests.every((request) => request.route === "connectInbox"));
});

test("a password the provider refuses doesn't appear in the error", async () => {
  for (const json of [false, true]) {
    const ran = await run(json ? [...imapFlags, "--json"] : imapFlags, { ...options, stdin: "wrong-password\n" });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /The mail provider answered with an error: The IMAP server refused the login\./);
    assertNowhere("wrong-password", ran.stdout + ran.stderr);
  }
});

test("Gmail's client secret and refresh token are never printed or stored", async () => {
  const ran = await run(
    ["inbox", "add", "--provider", "gmail", "--name", "G", "--color", "plum", "--client-id", "id.example", "--secrets-stdin", "--json"],
    { ...options, stdin: "gmail-client-secret-123\ngmail-refresh-token-456\n" },
  );
  assert.equal(ran.code, 0, ran.stderr);
  assertNowhere("gmail-client-secret-123", ran.stdout + ran.stderr);
  assertNowhere("gmail-refresh-token-456", ran.stdout + ran.stderr);
});

test("passwords typed in a terminal are not shown", async () => {
  const ran = await run(["inbox", "add", "--provider", "imap", "--name", "Acme", "--color", "teal"], {
    ...options,
    interactive: true,
    answers: ["ana@acme.example", "", "", "", "", "", PASSWORD, "n", SMTP_PASSWORD],
  });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(
    ran.questions.filter((q) => q.startsWith("(secret)")),
    ["(secret) Password (not shown): ", "(secret) SMTP password (not shown): "],
  );
  assertNowhere(PASSWORD, ran.stdout + ran.stderr);
  const body = server.calls("connectInbox")[0]!.body as { credentials: { imap: { password: string }; smtp: { password: string } } };
  assert.equal(body.credentials.imap.password, PASSWORD);
  assert.equal(body.credentials.smtp.password, SMTP_PASSWORD);
});

test("the terminal prompter echoes answers but not secrets", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk: Buffer) => (shown += chunk.toString()));
  const prompter = terminalPrompter(input, output);
  const name = prompter.ask("Name: ");
  input.write("visible-answer\r");
  assert.equal(await name, "visible-answer");
  const secret = prompter.secret("Password: ");
  input.write(`${PASSWORD}\r`);
  assert.equal(await secret, PASSWORD);
  prompter.close();
  assert.match(shown, /Name: /);
  assert.match(shown, /visible-answer/, "ordinary answers are echoed, so the muting is what hides the secret");
  assert.match(shown, /Password: /);
  assert.ok(!shown.includes(PASSWORD));
});

test("Ctrl-C at a question stops without an answer", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const prompter = terminalPrompter(input, output);
  const answer = prompter.secret("Password: ");
  input.write("half-typ\u0003");
  await assert.rejects(answer, /Stopped; nothing was changed\./);
  prompter.close();
});

test("the command's own token is never printed by any command", async () => {
  server.addInbox({ name: "Acme", address: "ana@acme.example", agentAccess: true });
  const commands = [
    ["status"], ["status", "--json"], ["doctor"], ["doctor", "--json"], ["devices"], ["devices", "--json"],
    ["pair"], ["pair", "--json"], ["inbox", "list", "--json"], ["agent", "list", "--json"],
    ["agent", "add", "Helper", "--all"], ["agent", "add", "Helper2", "--all", "--json"],
    ["ai", "status"], ["ai", "status", "--json"], ["ai", "models"], ["ai", "test", "--json"], ["inbox", "list"],
  ];
  for (const argv of commands) {
    const ran = await run(argv, options);
    assert.ok(ran.code === 0, `${argv.join(" ")}: ${ran.stderr}`);
    assert.ok(!(ran.stdout + ran.stderr).includes(me.token), argv.join(" "));
  }
});

test("the settings file is owner-only, also when its folder was made loosely before", async () => {
  const fresh = scratch();
  try {
    const dir = join(fresh.dir, ".config", "usual-mail");
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    const { ctx } = context({ home: fresh.dir });
    writeConfig(ctx, { server: "http://127.0.0.1:1", token: "umt_secret" });
    assert.equal(mode(configPath(fresh.dir)), 0o600);
    assert.equal(mode(dir), 0o700);
    assert.equal(JSON.parse(readFileSync(configPath(fresh.dir), "utf8")).token, "umt_secret");

    chmodSync(configPath(fresh.dir), 0o644);
    const doctor = await run(["doctor", "--json"], { home: fresh.dir });
    const settings = JSON.parse(doctor.stdout).checks.find((c: { name: string }) => c.name === "settings");
    assert.equal(settings.level, "fail");
    assert.match(settings.fix, /chmod 700 ~\/\.config\/usual-mail && chmod 600 ~\/\.config\/usual-mail\/config\.json/);
    assert.ok(!doctor.stdout.includes("umt_secret"));
  } finally {
    fresh.remove();
  }
});

test("a token is never sent to a server other than the one it was saved for", async () => {
  const other = new StandIn();
  await other.listen();
  try {
    const ran = await run(["inbox", "list"], { ...options, env: { USUAL_MAIL_SERVER: other.url } });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /isn't paired with the server yet/);
    assert.equal(other.requests.length, 0);
  } finally {
    await other.close();
  }
});
