// Every command that talks to the server: the requests it makes and what it prints, plain and with --json.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { run, savedConfig, scratch, type Options } from "./helpers.ts";
import { StandIn } from "./stand-in.ts";

let home: { dir: string; remove: () => void };
let server: StandIn;
let me: { device: { id: string }; token: string };
let options: Options;

before(() => {
  home = scratch();
});
after(() => home.remove());

beforeEach(async () => {
  await server?.close();
  server = new StandIn();
  const url = await server.listen();
  me = server.addDevice("person", "usual-mail on test-machine");
  savedConfig(home.dir, { server: url, token: me.token, deviceId: me.device.id, deviceName: "usual-mail on test-machine" });
  options = { home: home.dir };
});
after(() => server.close());

const bearer = () => `Bearer ${me.token}`;

describe("pair", () => {
  test("makes a code for a person's app and shows it with the address and expiry", async () => {
    const ran = await run(["pair"], options);
    assert.equal(ran.code, 0, ran.stderr);
    const [request] = server.calls("createPairingCode");
    assert.deepEqual(request!.body, { kind: "person" });
    assert.equal(request!.authorization, bearer());
    const code = server.codes.at(-1)!.code;
    assert.match(ran.stdout, new RegExp(`Pairing code  ${code}`));
    assert.match(ran.stdout, new RegExp(`Server        ${server.url}`));
    assert.match(ran.stdout, /Valid until   \d{4}-\d\d-\d\d \d\d:\d\d UTC \(in 15 minutes\), once/);
    assert.match(ran.stdout, /works only on this machine/);
  });

  test("--json prints the code, its expiry and the server", async () => {
    const ran = await run(["pair", "--json"], options);
    const printed = JSON.parse(ran.stdout);
    assert.equal(printed.code, server.codes.at(-1)!.code);
    assert.match(printed.expiresAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(printed.server, server.url);
  });
});

describe("agent", () => {
  test("add gives chosen inboxes, turns agent access on where it is off, and shows the connector and token once", async () => {
    const acme = server.addInbox({ name: "Acme", address: "ana@acme.example", agentAccess: false });
    const home2 = server.addInbox({ name: "Personal", address: "ana@home.example", agentAccess: true });
    server.addInbox({ name: "Other", address: "ana@other.example" });
    const ran = await run(["agent", "add", "Claude Code", "--inbox", "Acme", "--inbox", "ana@home.example"], options);
    assert.equal(ran.code, 0, ran.stderr);

    const updates = server.calls("updateInbox");
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.path, `/v1/inboxes/${acme.id}`);
    assert.deepEqual(updates[0]!.body, { agentAccess: true });
    assert.deepEqual(server.calls("createPairingCode")[0]!.body, { kind: "agent", inboxIds: [acme.id, home2.id] });
    const pairBody = server.calls("pair")[0]!;
    assert.equal(pairBody.authorization, undefined);
    assert.equal((pairBody.body as { name: string }).name, "Claude Code");

    const agent = server.devices.find((device) => device.kind === "agent")!;
    assert.deepEqual(agent.inboxIds, [acme.id, home2.id]);
    assert.match(ran.stdout, /Added the agent "Claude Code"\. It may see: Acme, Personal\./);
    assert.match(ran.stdout, /Turned on agent access for: Acme\./);
    assert.match(ran.stdout, new RegExp(`Connector  ${server.url}/mcp`));
    assert.match(ran.stdout, new RegExp(`Token      ${agent.token}`));
    assert.ok(!ran.stdout.includes(me.token), "the command's own token is never printed");
  });

  test("add --all --json prints the agent, connector and token", async () => {
    const a = server.addInbox({ name: "Acme", address: "ana@acme.example", agentAccess: true });
    const ran = await run(["agent", "add", "Helper", "--all", "--json"], options);
    assert.equal(ran.code, 0, ran.stderr);
    const printed = JSON.parse(ran.stdout);
    const agent = server.devices.find((device) => device.kind === "agent")!;
    assert.equal(printed.token, agent.token);
    assert.equal(printed.connector, `${server.url}/mcp`);
    assert.deepEqual(printed.agent.inboxIds, [a.id]);
    assert.deepEqual(printed.agentAccessTurnedOn, []);
    assert.equal(server.calls("updateInbox").length, 0);
  });

  test("add without inboxes on the server says to connect one first", async () => {
    const ran = await run(["agent", "add", "Helper", "--all"], options);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /no inboxes to give yet.*usual-mail inbox add/);
  });

  test("list shows agents with their inboxes, marking where agent access is off", async () => {
    const a = server.addInbox({ name: "Acme", address: "ana@acme.example", agentAccess: true });
    const b = server.addInbox({ name: "Personal", address: "ana@home.example", agentAccess: false });
    const agent = server.addDevice("agent", "Claude Code", [a.id, b.id]);
    const plain = await run(["agent", "list"], options);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /NAME\s+INBOXES\s+LAST SEEN\s+ID/);
    assert.match(plain.stdout, new RegExp(`Claude Code\\s+Acme, Personal \\(agent access off\\)\\s+never\\s+${agent.device.id}`));
    const json = JSON.parse((await run(["agent", "list", "--json"], options)).stdout);
    assert.deepEqual(json.map((d: { id: string }) => d.id), [agent.device.id]);
    assert.equal((await run(["agent"], options)).stdout, plain.stdout, "`usual-mail agent` lists them too");
  });

  test("remove revokes the agent by name", async () => {
    const agent = server.addDevice("agent", "Claude Code", []);
    const ran = await run(["agent", "remove", "claude code"], options);
    assert.equal(ran.code, 0, ran.stderr);
    const [request] = server.calls("revokeDevice");
    assert.equal(request!.method, "DELETE");
    assert.equal(request!.path, `/v1/devices/${agent.device.id}`);
    assert.match(ran.stdout, /Removed the agent "Claude Code"\. Its token no longer works\./);
    assert.ok(!server.devices.some((device) => device.id === agent.device.id));
  });

  test("remove won't touch a person's device", async () => {
    const ran = await run(["agent", "remove", "usual-mail on test-machine"], options);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /No agent is called/);
    assert.equal(server.calls("revokeDevice").length, 0);
  });
});

describe("inbox", () => {
  test("add connects an IMAP inbox from flags and a password on standard input", async () => {
    const ran = await run(
      ["inbox", "add", "--provider", "imap", "--name", "Acme", "--color", "blue", "--address", "ana@acme.example",
        "--imap-host", "imap.acme.example", "--smtp-host", "smtp.acme.example", "--smtp-starttls", "--secrets-stdin"],
      { ...options, stdin: "pw-one\n" },
    );
    assert.equal(ran.code, 0, ran.stderr);
    const [request] = server.calls("connectInbox");
    assert.equal(request!.authorization, bearer());
    assert.deepEqual(request!.body, {
      name: "Acme",
      color: "#285fcd",
      provider: "imap",
      credentials: {
        imap: { host: "imap.acme.example", port: 993, secure: true, user: "ana@acme.example", password: "pw-one" },
        smtp: { host: "smtp.acme.example", port: 587, secure: false, user: "ana@acme.example", password: "pw-one" },
      },
    });
    assert.match(ran.stdout, /Connected Acme \(ana@acme\.example\), IMAP, hat blue\./);
    assert.match(ran.stdout, /Status: connecting\. Trust: suggest\./);
  });

  test("add takes a separate SMTP password, a login, a trust level and any #RRGGBB", async () => {
    const ran = await run(
      ["inbox", "add", "--provider", "imap", "--name", "Shop", "--color", "#C2541D", "--trust", "act_with_undo",
        "--address", "shop@acme.example", "--user", "shop-login", "--imap-host", "mail.acme.example", "--imap-port", "1993",
        "--smtp-host", "mail.acme.example", "--secrets-stdin", "--json"],
      { ...options, stdin: "imap-pw\nsmtp-pw\n" },
    );
    assert.equal(ran.code, 0, ran.stderr);
    const body = server.calls("connectInbox")[0]!.body as Record<string, any>;
    assert.equal(body.color, "#c2541d");
    assert.equal(body.trust, "act_with_undo");
    assert.equal(body.credentials.address, "shop@acme.example");
    assert.deepEqual(body.credentials.imap, { host: "mail.acme.example", port: 1993, secure: true, user: "shop-login", password: "imap-pw" });
    assert.equal(body.credentials.smtp.password, "smtp-pw");
    const printed = JSON.parse(ran.stdout);
    assert.equal(printed.name, "Shop");
    assert.equal(printed.trust, "act_with_undo");
  });

  test("add connects Gmail with the client id from a flag and the two secrets from standard input", async () => {
    const ran = await run(
      ["inbox", "add", "--provider", "gmail", "--name", "Gmail", "--color", "red", "--client-id", "id.apps.example", "--secrets-stdin"],
      { ...options, stdin: "client-secret\nrefresh-token\n" },
    );
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual((server.calls("connectInbox")[0]!.body as Record<string, unknown>).credentials, {
      clientId: "id.apps.example",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });
  });

  test("add in a terminal asks for each detail, the password unseen, and offers the twelve colours", async () => {
    server.addInbox({ name: "Old", address: "old@acme.example", color: "#b53031" });
    const ran = await run(["inbox", "add"], {
      ...options,
      interactive: true,
      answers: ["1", "Acme", "", "ana@acme.example", "", "", "", "", "", "typed-secret", "y"],
    });
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(ran.questions, [
      "Number [1]: ",
      "Name (for example the company's name): ",
      "Number [2]: ",
      "The mailbox's address: ",
      "Login [ana@acme.example]: ",
      "IMAP server [imap.acme.example]: ",
      "IMAP port [993]: ",
      "SMTP server (for sending) [smtp.acme.example]: ",
      "SMTP port [465]: ",
      "(secret) Password (not shown): ",
      "Use the same password for sending (SMTP)? [Y/n] ",
    ]);
    assert.match(ran.stdout, /1  red \(in use\)/);
    assert.match(ran.stdout, /12  slate/);
    const body = server.calls("connectInbox")[0]!.body as Record<string, any>;
    assert.equal(body.color, "#a34a00", "Enter takes the first colour not in use: orange");
    assert.equal(body.credentials.imap.host, "imap.acme.example");
    assert.equal(body.credentials.smtp.password, "typed-secret");
    assert.ok(!ran.stdout.includes("typed-secret"));
  });

  test("add refuses a provider other than IMAP or Gmail, an unknown colour and an unknown trust level", async () => {
    const base = ["inbox", "add", "--name", "X", "--secrets-stdin"];
    const outlook = await run([...base, "--provider", "outlook", "--color", "red"], { ...options, stdin: "pw" });
    assert.equal(outlook.code, 2);
    assert.match(outlook.stderr, /--provider takes imap or gmail, not "outlook"\./);
    const help = await run(["inbox", "add", "--help"], options);
    assert.doesNotMatch(help.stdout, /outlook/i, "Outlook isn't mentioned any more");
    const colour = await run([...base, "--provider", "gmail", "--client-id", "x", "--color", "chartreuse"], { ...options, stdin: "a\nb" });
    assert.equal(colour.code, 2);
    assert.match(colour.stderr, /--color takes one of red, orange/);
    const trust = await run([...base, "--provider", "gmail", "--client-id", "x", "--color", "red", "--trust", "always"], options);
    assert.equal(trust.code, 2);
    assert.match(trust.stderr, /--trust takes suggest, act_with_undo, act_silently/);
    assert.equal(server.calls("connectInbox").length, 0);
  });

  test("list shows each inbox's place, icon, hat, status and the reason when something is wrong", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example", color: "#2F6FED", lastSyncedAt: "2026-11-16T09:30:00Z" });
    server.addInbox({ name: "Personal", address: "me@home.example", color: "#C2541D", status: "needs_attention", statusDetail: "The password was refused" });
    server.addInbox({ name: "Shop", address: "shop@acme.example", provider: "gmail", status: "paused", icon: "shop" });
    // A first sync under way says how far it has got; one that needs attention or is paused says that instead.
    server.addInbox({ name: "New", address: "new@acme.example", provider: "gmail", status: "connecting", firstSync: { fetched: 1200, total: 3400 } });
    server.addInbox({ name: "Stuck", address: "stuck@acme.example", provider: "gmail", status: "needs_attention", statusDetail: "Gmail didn't answer", firstSync: { fetched: 20, total: 340 } });
    const ran = await run(["inbox", "list"], options);
    assert.equal(ran.code, 0, ran.stderr);
    const lines = ran.stdout.trimEnd().split("\n");
    assert.match(lines[0]!, /^#\s+NAME\s+ICON\s+HAT\s+ADDRESS\s+PROVIDER\s+CONNECTION\s+STATUS\s+LAST SYNC\s+ID$/);
    assert.match(lines[1]!, /^1\s+Acme\s+person\s+blue\s+ana@acme\.example\s+IMAP\s+imap\.acme\.example:993 as ana@acme\.example\s+ok\s+2026-11-16 09:30 UTC\s+inb_\d+$/);
    assert.match(lines[2]!, /^2\s+Personal\s+building\s+orange\s+me@home\.example\s+IMAP\s+imap\.home\.example:993 as me@home\.example\s+needs attention: The password was refused\s+never/);
    assert.match(lines[3]!, /^3\s+Shop\s+shop\s+blue\s+shop@acme\.example\s+Gmail\s+client stored\.apps\.example\s+paused/);
    assert.match(lines[4]!, /^4\s+New\s+.*\s+fetching your mail · 1,200 of 3,400\s+never/);
    assert.match(lines[5]!, /^5\s+Stuck\s+.*\s+needs attention: Gmail didn't answer\s+never/);
    const json = JSON.parse((await run(["inbox", "list", "--json"], options)).stdout);
    assert.deepEqual(json, server.inboxes);
  });

  test("list says how to start when there are none", async () => {
    const ran = await run(["inbox", "list"], options);
    assert.match(ran.stdout, /No inboxes yet\. `usual-mail inbox add` connects one\./);
  });

  test("sync, pause and resume call their routes for the inbox named", async () => {
    const acme = server.addInbox({ name: "Acme", address: "ana@acme.example" });
    const sync = await run(["inbox", "sync", "Acme"], options);
    assert.equal(sync.code, 0, sync.stderr);
    assert.equal(server.calls("syncInbox")[0]!.path, `/v1/inboxes/${acme.id}/sync`);
    assert.equal(server.calls("syncInbox")[0]!.method, "POST");
    assert.match(sync.stdout, /Asked the server to sync Acme\./);

    const pause = await run(["inbox", "pause", acme.id], options);
    assert.equal(pause.code, 0, pause.stderr);
    assert.deepEqual(server.calls("updateInbox")[0]!.body, { paused: true });
    assert.match(pause.stdout, /Paused Acme\./);

    const resume = await run(["inbox", "resume", "ana@acme.example", "--json"], options);
    assert.deepEqual(server.calls("updateInbox")[1]!.body, { paused: false });
    assert.equal(JSON.parse(resume.stdout).status, "connecting", "resumed, it is connecting until its next good sync");
  });

  test("remove asks first in a terminal, and does nothing on no", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    const no = await run(["inbox", "remove", "Acme"], { ...options, interactive: true, answers: [""] });
    assert.equal(no.code, 0);
    assert.deepEqual(no.questions, ["Remove Acme? [y/N] "]);
    assert.match(no.stdout, /its copy of the mail, its rules,\nits history, its drafts and its guide\. Agents lose access to it, and briefs no longer show its section\./);
    assert.match(no.stdout, /Nothing changes at the provider: the mail stays, and so do the labels or folders Usual Mail made there\./);
    assert.match(no.stdout, /This can't be undone\./);
    assert.match(no.stdout, /Nothing was removed\./);
    assert.equal(server.calls("removeInbox").length, 0);

    const yes = await run(["inbox", "remove", "Acme"], { ...options, interactive: true, answers: ["y"] });
    assert.equal(yes.code, 0, yes.stderr);
    assert.equal(server.calls("removeInbox")[0]!.method, "DELETE");
    assert.match(yes.stdout, /Removed Acme\. Nothing changed at the provider\./);
    assert.equal(server.inboxes.length, 0);
  });

  test("remove --yes doesn't ask", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    const ran = await run(["inbox", "remove", "Acme", "--yes"], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(server.calls("removeInbox").length, 1);
  });

  test("an inbox name that matches two inboxes asks for the id", async () => {
    const a = server.addInbox({ name: "Acme", address: "a@acme.example" });
    const b = server.addInbox({ name: "acme", address: "b@acme.example" });
    const ran = await run(["inbox", "sync", "ACME"], options);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, new RegExp(`More than one inbox is called "ACME": ${a.id}, ${b.id}\\. Name it by its id\\.`));
  });
});

describe("devices", () => {
  test("lists apps and agents, marking this command", async () => {
    const mac = server.addDevice("person", "Ana's Mac");
    const ran = await run(["devices"], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /usual-mail on test-machine \(this command\)\s+app/);
    assert.match(ran.stdout, new RegExp(`Ana's Mac\\s+app\\s+.*${mac.device.id}`));
    const json = JSON.parse((await run(["devices", "--json"], options)).stdout);
    assert.equal(json.length, 2);
    assert.ok(json.every((device: Record<string, unknown>) => !("token" in device)));
  });

  test("revoke ends another device's access by name", async () => {
    const mac = server.addDevice("person", "Ana's Mac");
    const ran = await run(["devices", "revoke", "Ana's Mac"], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(server.calls("revokeDevice")[0]!.path, `/v1/devices/${mac.device.id}`);
    assert.match(ran.stdout, /Revoked Ana's Mac\. Its token no longer works\./);
  });

  test("revoking this command's own device asks first", async () => {
    const ran = await run(["devices", "revoke", me.device.id], { ...options, interactive: true, answers: ["n"] });
    assert.equal(ran.code, 0);
    assert.deepEqual(ran.questions, ["Revoke it anyway? [y/N] "]);
    assert.equal(server.calls("revokeDevice").length, 0);
  });
});

describe("status", () => {
  test("says the server answers, its version and what this command is paired as", async () => {
    const ran = await run(["status"], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, new RegExp(`Server     ${server.url}`));
    assert.match(ran.stdout, /Runs with  set up elsewhere/);
    assert.match(ran.stdout, /Answers    yes, version 0\.0\.0-stand-in/);
    assert.match(ran.stdout, /Paired as  usual-mail on test-machine/);
    const json = JSON.parse((await run(["status", "--json"], options)).stdout);
    assert.deepEqual(json, {
      server: server.url,
      mode: "elsewhere",
      answers: true,
      version: "0.0.0-stand-in",
      paired: { id: me.device.id, name: "usual-mail on test-machine", kind: "person" },
      syncDays: 30,
    });
    assert.match(ran.stdout, /First sync the last 30 days of mail, for each new inbox/);
    assert.equal(server.calls("me").length, 2, "it asks the server who the token belongs to");
  });

  test("names the device the token in use belongs to, not the saved name (GET /v1/me)", async () => {
    const mac = server.addDevice("person", "Ana's Mac");
    const other = await run(["status"], { ...options, env: { USUAL_MAIL_TOKEN: mac.token } });
    assert.equal(other.code, 0, other.stderr);
    assert.match(other.stdout, /Paired as  Ana's Mac \(the token in USUAL_MAIL_TOKEN\)/);
    const inbox = server.addInbox({ name: "Acme", address: "ana@acme.example", agentAccess: true });
    const agent = server.addDevice("agent", "Helper", [inbox.id]);
    const asAgent = await run(["status", "--json"], { ...options, env: { USUAL_MAIL_TOKEN: agent.token } });
    assert.deepEqual(JSON.parse(asAgent.stdout).paired, { id: agent.device.id, name: "Helper", kind: "agent" });
    // The saved name stays in the settings file, but status asks the server.
    server.devices.find((device) => device.id === me.device.id)!.name = "Renamed on the server";
    assert.match((await run(["status"], options)).stdout, /Paired as  Renamed on the server\n/);
  });

  test("exits with 1 when the server doesn't answer", async () => {
    await server.close();
    const ran = await run(["status"], options);
    assert.equal(ran.code, 1);
    assert.match(ran.stdout, /Answers    no/);
    const json = await run(["status", "--json"], options);
    assert.equal(json.code, 1);
    assert.equal(JSON.parse(json.stdout).answers, false);
  });
});
