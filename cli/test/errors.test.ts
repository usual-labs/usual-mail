// How the command explains each of the contract's error codes, and failures that aren't answers at all.

import type { ErrorCode } from "@usualmail/core";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { freePort, run, savedConfig, scratch, type Options } from "./helpers.ts";
import { StandIn } from "./stand-in.ts";

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
  const url = await server.listen();
  me = server.addDevice("person", "usual-mail on test-machine");
  savedConfig(home.dir, { server: url, token: me.token, deviceId: me.device.id });
  options = { home: home.dir };
});

const EXPECTED: Record<ErrorCode, RegExp> = {
  unauthorized: /didn't accept this command's token.*Run `usual-mail init` to pair this command again/,
  forbidden: /The server refused: Refused by the stand-in \(forbidden\)\./,
  not_found: /Refused by the stand-in \(not_found\)\./,
  invalid: /The server refused the request: Refused by the stand-in \(invalid\)\./,
  conflict: /Refused by the stand-in \(conflict\)\. Something changed in the meantime; look again and retry\./,
  needs_person: /Only a person may do this, and the token in use belongs to an agent.*USUAL_MAIL_TOKEN/,
  rate_limited: /turning requests away for now\. Wait up to ten minutes/,
  provider_error: /The mail provider answered with an error: Refused by the stand-in \(provider_error\)\. Check the connection details/,
  internal: /The server hit an error: Refused by the stand-in \(internal\)\. `usual-mail logs` shows what happened\./,
};

for (const [code, expected] of Object.entries(EXPECTED) as Array<[ErrorCode, RegExp]>) {
  test(`${code}: a sentence that says what to do, exit 1, and the code with --json`, async () => {
    server.failNext("listInboxes", code);
    const plain = await run(["inbox", "list"], options);
    assert.equal(plain.code, 1);
    assert.equal(plain.stdout, "");
    assert.match(plain.stderr, expected);

    server.failNext("listInboxes", code);
    const json = await run(["inbox", "list", "--json"], options);
    assert.equal(json.code, 1);
    assert.equal(json.stdout, "");
    const printed = JSON.parse(json.stderr);
    assert.equal(printed.error.code, code);
    assert.match(printed.error.message, expected);
  });
}

test("unauthorized: a revoked token says to pair again", async () => {
  server.devices.splice(0);
  const ran = await run(["devices"], options);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /didn't accept this command's token/);
  assert.ok(!ran.stderr.includes(me.token));
});

test("unauthorized on pairing: the code is wrong, used or expired", async () => {
  const fresh = scratch();
  try {
    const ran = await run(["init", "--server", server.url, "--code", "WRONG-CODE"], { home: fresh.dir });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /The pairing code is wrong, used or expired\. Make a new one/);
  } finally {
    fresh.remove();
  }
});

test("rate_limited on pairing: after ten wrong codes the server refuses, and the command says how long to wait", async () => {
  const fresh = scratch();
  try {
    for (let i = 0; i < 10; i++) await run(["init", "--server", server.url, "--code", `WRONG-${i}`], { home: fresh.dir });
    const ran = await run(["init", "--server", server.url, "--code", "WRONG-11", "--json"], { home: fresh.dir });
    assert.equal(ran.code, 1);
    const printed = JSON.parse(ran.stderr);
    assert.equal(printed.error.code, "rate_limited");
    assert.match(printed.error.message, /Too many wrong pairing codes, so the server refuses new tries for now\. Try again in 10 minutes\./);
    assert.ok(printed.error.retryAfter > 590 && printed.error.retryAfter <= 600, `retryAfter ${printed.error.retryAfter}`);
    assert.equal(server.calls("pair").length, 11);
  } finally {
    fresh.remove();
  }
});

test("rate_limited: the wait comes from Retry-After, in seconds or as a date, and in words", async () => {
  for (const [header, words] of [["45", "Try again in 45 seconds."], ["61", "Try again in 2 minutes."], ["0", "Try again now."]] as const) {
    server.failNext("listInboxes", "rate_limited", "Slow down", header);
    const ran = await run(["inbox", "list"], options);
    assert.match(ran.stderr, new RegExp(`turning requests away for now\\. ${words.replace(/\./g, "\\.")}`), header);
  }
  server.failNext("listInboxes", "rate_limited", "Slow down", new Date(Date.now() + 120_000).toUTCString());
  const dated = JSON.parse((await run(["inbox", "list", "--json"], options)).stderr);
  assert.match(dated.error.message, /Try again in [23] minutes\./);
  assert.ok(dated.error.retryAfter >= 119 && dated.error.retryAfter <= 121);
});

test("needs_person: an agent's token can't connect an inbox", async () => {
  const inbox = server.addInbox({ name: "Acme", address: "ana@acme.example", agentAccess: true });
  const agent = server.addDevice("agent", "Helper", [inbox.id]);
  const ran = await run(
    ["inbox", "add", "--provider", "gmail", "--name", "G", "--color", "red", "--client-id", "x", "--secrets-stdin"],
    { ...options, env: { USUAL_MAIL_TOKEN: agent.token }, stdin: "a\nb\n" },
  );
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /Only a person may do this, and the token in use belongs to an agent \(A person must do this\.\)/);
  // The AI settings (read to offer AI for the new inbox) are a person's too, so it stops there, before connecting.
  assert.equal(server.calls("aiSettings")[0]!.authorization, `Bearer ${agent.token}`);
  assert.equal(server.calls("connectInbox").length, 0);
  assert.equal(server.inboxes.length, 1);
});

test("needs_person: an agent may not pause an inbox", async () => {
  const inbox = server.addInbox({ name: "Acme", address: "ana@acme.example", agentAccess: true });
  const agent = server.addDevice("agent", "Helper", [inbox.id]);
  const ran = await run(["inbox", "pause", "Acme"], { ...options, env: { USUAL_MAIL_TOKEN: agent.token } });
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /Only a person may do this/);
});

test("not_found names the command that lists what there is", async () => {
  server.addInbox({ name: "Acme", address: "ana@acme.example" });
  server.failNext("syncInbox", "not_found", "No such inbox");
  const ran = await run(["inbox", "sync", "Acme"], options);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /No such inbox\. `usual-mail inbox list` shows what there is\./);
});

test("a server that doesn't answer: says how to check and start it", async () => {
  const port = await freePort();
  savedConfig(home.dir, { server: `http://127.0.0.1:${port}`, token: me.token });
  const ran = await run(["inbox", "list", "--json"], options);
  assert.equal(ran.code, 1);
  const printed = JSON.parse(ran.stderr);
  assert.equal(printed.error.code, "unreachable");
  assert.match(printed.error.message, /Can't reach the server at http:\/\/127\.0\.0\.1:\d+: nothing answered\. `usual-mail status`/);
});

test("something that isn't a Usual Mail server says so", async () => {
  const other = createServer((_, response) => response.writeHead(500, { "content-type": "text/html" }).end("<h1>Oops</h1>"));
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const { port } = other.address() as { port: number };
  savedConfig(home.dir, { server: `http://127.0.0.1:${port}`, token: me.token });
  const ran = await run(["inbox", "list"], options);
  other.close();
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /answered HTTP 500 with something other than JSON\. Is it a Usual Mail server\?/);
});

test("nothing set up: says to run init", async () => {
  const empty = scratch();
  try {
    const ran = await run(["inbox", "list"], { home: empty.dir });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /No server is set up for this command\. Run `usual-mail init` first\./);
  } finally {
    empty.remove();
  }
});

test("a mistake in the arguments exits with 2 and names the help", async () => {
  const unknownFlag = await run(["inbox", "list", "--colour"], options);
  assert.equal(unknownFlag.code, 2);
  assert.match(unknownFlag.stderr, /Unknown option '--colour'\. `usual-mail inbox list --help` lists what it takes\./);
  const extra = await run(["pair", "now"], options);
  assert.equal(extra.code, 2);
  assert.match(extra.stderr, /Too many words after `usual-mail pair`: now\./);
  const unknown = await run(["inbox", "frob"], options);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command: usual-mail inbox frob\. `usual-mail --help` lists the commands\./);
  const missing = await run(["inbox", "sync"], options);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /needs the inbox/);
});

test("every command has --help, and help <command> says the same", async () => {
  const { COMMANDS } = await import("../src/main.ts");
  for (const command of COMMANDS) {
    const ran = await run([...command.name.split(" "), "--help"], options);
    assert.equal(ran.code, 0, command.name);
    assert.ok(ran.stdout.startsWith(command.usage), command.name);
    assert.equal((await run(["help", ...command.name.split(" ")], options)).stdout, ran.stdout);
  }
  assert.equal(server.requests.length, 0, "help makes no requests");
});
