// `usual-mail inbox reconnect`: new credentials for a connected inbox, checked by the server with the provider
// before they are kept. It starts from the details the server stored (`Inbox.connection`), so only secrets are
// asked again. Secrets are read unseen or from standard input, sent once, and never printed or stored.

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { allFiles, run, savedConfig, scratch, type Options } from "./helpers.ts";
import { StandIn } from "./stand-in.ts";

const PASSWORD = "N3w-Mailbox-Pw!";

let home: { dir: string; remove: () => void };
let server: StandIn;
let me: { device: { id: string }; token: string };
let options: Options;
let acme: { id: string };

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
  acme = server.addInbox({ name: "Acme", address: "ana@acme.example", status: "needs_attention", statusDetail: "The password was refused", version: 4 });
  savedConfig(home.dir, { server: server.url, token: me.token, deviceId: me.device.id });
  options = { home: home.dir };
});

const flags = ["inbox", "reconnect", "Acme", "--imap-host", "imap.acme.example", "--smtp-host", "smtp.acme.example", "--secrets-stdin"];

function assertNowhere(secret: string, printed: string): void {
  assert.ok(!printed.includes(secret), "printed");
  for (const file of allFiles(home.dir)) assert.ok(!file.text.includes(secret), `in ${file.path}`);
}

test("with only the password, sends the stored details with it, and the inbox leaves needs attention", async () => {
  Object.assign(server.inboxes[0]!, {
    connection: {
      kind: "imap",
      imap: { host: "mail.acme.example", port: 143, secure: false, user: "ana-login" },
      smtp: { host: "relay.acme.example", port: 587, secure: false, user: "relay-user" },
      saveSent: false,
    },
  });
  const ran = await run(["inbox", "reconnect", "Acme", "--secrets-stdin"], { ...options, stdin: `${PASSWORD}\n` });
  assert.equal(ran.code, 0, ran.stderr);
  const [request] = server.calls("updateInbox");
  assert.equal(request!.method, "PATCH");
  assert.equal(request!.path, `/v1/inboxes/${acme.id}`);
  assert.deepEqual(request!.body, {
    credentials: {
      imap: { host: "mail.acme.example", port: 143, secure: false, user: "ana-login", password: PASSWORD },
      smtp: { host: "relay.acme.example", port: 587, secure: false, user: "relay-user", password: PASSWORD },
      address: "ana@acme.example",
      saveSent: false,
    },
  });
  assert.match(ran.stdout, /The provider accepted the new details for Acme\. Its rules and history stay\./);
  assert.match(ran.stdout, /Status: connecting\./);
  assert.match(ran.stdout, /Connected: IMAP mail\.acme\.example:143 \(STARTTLS\) as ana-login, SMTP relay\.acme\.example:587 \(STARTTLS\) as relay-user, sent mail not saved\./);
  assert.match(ran.stdout, /It syncs again/);
  assertNowhere(PASSWORD, ran.stdout + ran.stderr);
});

test("flags change stored details: servers, a login for both, and saving sent mail", async () => {
  const ran = await run([...flags, "--user", "ana@acme.example", "--save-sent"], { ...options, stdin: `${PASSWORD}\n` });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(server.calls("updateInbox")[0]!.body, {
    credentials: {
      imap: { host: "imap.acme.example", port: 993, secure: true, user: "ana@acme.example", password: PASSWORD },
      smtp: { host: "smtp.acme.example", port: 465, secure: true, user: "ana@acme.example", password: PASSWORD },
      saveSent: true,
    },
  });
  const both = await run([...flags, "--save-sent", "--no-save-sent"], { ...options, stdin: `${PASSWORD}\n` });
  assert.equal(both.code, 2);
  assert.match(both.stderr, /Pass --save-sent or --no-save-sent, not both\./);
});

test("a login other than the address sends the address too; --json prints the inbox", async () => {
  const ran = await run([...flags, "--user", "ana-login", "--imap-starttls", "--no-save-sent", "--json"], { ...options, stdin: `${PASSWORD}\nsmtp-only-pw\n` });
  assert.equal(ran.code, 0, ran.stderr);
  const body = server.calls("updateInbox")[0]!.body as { credentials: Record<string, any> };
  assert.equal(body.credentials.address, "ana@acme.example");
  assert.equal(body.credentials.saveSent, false);
  assert.deepEqual(body.credentials.imap, { host: "imap.acme.example", port: 143, secure: false, user: "ana-login", password: PASSWORD });
  assert.equal(body.credentials.smtp.password, "smtp-only-pw");
  const printed = JSON.parse(ran.stdout);
  assert.equal(printed.id, acme.id);
  assert.equal(printed.version, 5, "the inbox's version rose");
});

test("a Gmail inbox keeps its stored client id, or takes a new one, with the two secrets", async () => {
  server.addInbox({ name: "Studio", address: "owner@gmail.example", provider: "gmail" });
  const kept = await run(["inbox", "reconnect", "Studio", "--secrets-stdin"], { ...options, stdin: "new-client-secret\nnew-refresh-token\n" });
  assert.equal(kept.code, 0, kept.stderr);
  assert.deepEqual((server.calls("updateInbox")[0]!.body as Record<string, unknown>).credentials, {
    clientId: "stored.apps.example",
    clientSecret: "new-client-secret",
    refreshToken: "new-refresh-token",
  });
  const ran = await run(["inbox", "reconnect", "Studio", "--client-id", "new.apps.example", "--secrets-stdin"], {
    ...options,
    stdin: "new-client-secret\nnew-refresh-token\n",
  });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual((server.calls("updateInbox")[1]!.body as Record<string, unknown>).credentials, {
    clientId: "new.apps.example",
    clientSecret: "new-client-secret",
    refreshToken: "new-refresh-token",
  });
  assertNowhere("new-refresh-token", ran.stdout + ran.stderr);
  assertNowhere("new-client-secret", kept.stdout + kept.stderr);
});

test("in a terminal it shows the stored details and asks only for the password, unseen", async () => {
  const ran = await run(["inbox", "reconnect", "Acme"], { ...options, interactive: true, answers: ["", PASSWORD, "y"] });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(ran.questions, [
    "Keep these details and give only the password? [Y/n] ",
    "(secret) Password (not shown): ",
    "Use the same password for sending (SMTP)? [Y/n] ",
  ]);
  assert.match(ran.stdout, /New connection details for Acme \(ana@acme\.example, IMAP\)\./);
  assert.match(ran.stdout, /Stored details: IMAP imap\.acme\.example:993 \(TLS\) as ana@acme\.example; SMTP smtp\.acme\.example:465 \(TLS\) as ana@acme\.example; a copy of sent mail is saved\./);
  assert.deepEqual((server.calls("updateInbox")[0]!.body as { credentials: Record<string, any> }).credentials.imap.host, "imap.acme.example");
  assertNowhere(PASSWORD, ran.stdout + ran.stderr);
});

test("in a terminal, not keeping the stored details asks for each, suggesting what was stored", async () => {
  const ran = await run(["inbox", "reconnect", "Acme"], { ...options, interactive: true, answers: ["n", "", "imap2.acme.example", "", "", "", PASSWORD, "y"] });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(ran.questions, [
    "Keep these details and give only the password? [Y/n] ",
    "Login [ana@acme.example]: ",
    "IMAP server [imap.acme.example]: ",
    "IMAP port [993]: ",
    "SMTP server (for sending) [smtp.acme.example]: ",
    "SMTP port [465]: ",
    "(secret) Password (not shown): ",
    "Use the same password for sending (SMTP)? [Y/n] ",
  ]);
  assert.equal((server.calls("updateInbox")[0]!.body as { credentials: Record<string, any> }).credentials.imap.host, "imap2.acme.example");
});

test("when the provider refuses the details, its words are shown, nothing changes, and no secret is printed", async () => {
  const ran = await run(flags, { ...options, stdin: "wrong-password\n" });
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /The mail provider answered with an error: The IMAP server refused the login\./);
  assert.equal(server.inboxes[0]!.status, "needs_attention");
  assert.equal(server.inboxes[0]!.version, 4);
  assertNowhere("wrong-password", ran.stdout + ran.stderr);

  server.failNext("updateInbox", "provider_error", `LOGIN ana@acme.example ${PASSWORD} rejected`);
  for (const json of [false, true]) {
    if (json) server.failNext("updateInbox", "provider_error", `LOGIN ana@acme.example ${PASSWORD} rejected`);
    const echoed = await run(json ? [...flags, "--json"] : flags, { ...options, stdin: `${PASSWORD}\n` });
    assert.equal(echoed.code, 1);
    assert.match(echoed.stderr, /LOGIN ana@acme\.example ••• rejected/);
    assertNowhere(PASSWORD, echoed.stdout + echoed.stderr);
  }
});

test("details for another mailbox are refused as invalid, in the server's words", async () => {
  // The command sends the inbox's own address with a different login. A provider that reports another address
  // makes the server answer invalid, and nothing changes.
  server.failNext("updateInbox", "invalid", "These details are for bob@other.example, not ana@acme.example");
  const refused = await run([...flags, "--user", "bob@other.example"], { ...options, stdin: `${PASSWORD}\n` });
  assert.match(refused.stderr, /The server refused the request: These details are for bob@other\.example, not ana@acme\.example\./);
});

test("a paused inbox stays paused", async () => {
  server.inboxes[0]!.status = "paused";
  const ran = await run(flags, { ...options, stdin: `${PASSWORD}\n` });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(server.inboxes[0]!.status, "paused");
  assert.match(ran.stdout, /It stays paused until `usual-mail inbox resume`\./);
});

test("without a terminal, or with --json in one, it names every missing flag and sends nothing", async () => {
  const bare = await run(["inbox", "reconnect", "Acme"], options);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /This isn't a terminal, so nothing can be asked\. Pass --secrets-stdin\./, "the servers are stored");
  // An inbox whose stored details lack its servers (a store from an older server) needs them as flags.
  Object.assign(server.inboxes[0]!, {
    connection: { kind: "imap", imap: { host: "", port: 993, secure: true, user: "" }, smtp: { host: "", port: 465, secure: true, user: "" }, saveSent: true },
  });
  const unknown = await run(["inbox", "reconnect", "Acme"], options);
  assert.match(unknown.stderr, /Pass --imap-host, --smtp-host, --secrets-stdin\./);
  const json = await run(["inbox", "reconnect", "Acme", "--json"], { ...options, interactive: true, answers: [] });
  assert.equal(json.code, 2);
  assert.deepEqual(json.questions, []);
  assert.equal(json.stdout, "");
  const printed = JSON.parse(json.stderr);
  assert.equal(printed.error.code, "not_a_terminal");
  assert.match(printed.error.message, /With --json nothing is asked, so every answer must come from a flag\. Pass --imap-host, --smtp-host, --secrets-stdin\./);
  assert.equal(server.calls("updateInbox").length, 0);
});

test("an agent's token gets needs_person", async () => {
  server.inboxes[0]!.agentAccess = true;
  const agent = server.addDevice("agent", "Helper", [acme.id]);
  const ran = await run(flags, { ...options, env: { USUAL_MAIL_TOKEN: agent.token }, stdin: `${PASSWORD}\n` });
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /Only a person may do this/);
});
