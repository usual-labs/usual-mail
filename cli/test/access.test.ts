// Who the command is, as the server says (GET /v1/me); removing an agent and the agent access it leaves behind;
// and --json never mixing with questions.

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
after(async () => {
  await server.close();
  home.remove();
});
beforeEach(async () => {
  await server?.close();
  server = new StandIn();
  await server.listen();
  me = server.addDevice("person", "usual-mail on test-machine");
  savedConfig(home.dir, { server: server.url, token: me.token, deviceId: me.device.id, deviceName: "usual-mail on test-machine" });
  options = { home: home.dir };
});

describe("agent remove", () => {
  /** Two inboxes: one only this agent uses, one another agent uses too, and one whose access is already off. */
  function agents() {
    const acme = server.addInbox({ name: "Acme", address: "ana@acme.example", agentAccess: true });
    const shared = server.addInbox({ name: "Shared", address: "team@acme.example", agentAccess: true });
    const off = server.addInbox({ name: "Quiet", address: "quiet@acme.example", agentAccess: false });
    const helper = server.addDevice("agent", "Helper", [acme.id, shared.id, off.id]);
    server.addDevice("agent", "Other", [shared.id]);
    return { acme, shared, off, helper };
  }

  test("in a terminal it offers to turn agent access off for inboxes no other agent uses", async () => {
    const { acme } = agents();
    const ran = await run(["agent", "remove", "Helper"], { ...options, interactive: true, answers: [""] });
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(ran.questions, ["Turn agent access off for it too? [Y/n] "]);
    assert.match(ran.stdout, /No other agent uses Acme, and agent access is on for it\./);
    assert.match(ran.stdout, /Removed the agent "Helper"\. Its token no longer works\./);
    assert.match(ran.stdout, /Turned off agent access for: Acme\./);
    assert.deepEqual(server.calls("updateInbox").map((request) => [request.path, request.body]), [[`/v1/inboxes/${acme.id}`, { agentAccess: false }]]);
    assert.equal(server.inboxes.find((inbox) => inbox.name === "Shared")!.agentAccess, true, "another agent still uses it");
  });

  test("answering no leaves agent access as it is and says so", async () => {
    agents();
    const ran = await run(["agent", "remove", "Helper"], { ...options, interactive: true, answers: ["n"] });
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /Agent access stays on for: Acme\./);
    assert.equal(server.calls("updateInbox").length, 0);
    assert.equal(server.calls("revokeDevice").length, 1);
  });

  test("--access-off and --keep-access decide without asking; --json prints what was done", async () => {
    const { acme, helper } = agents();
    const json = await run(["agent", "remove", "Helper", "--access-off", "--json"], options);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), { agent: { id: helper.device.id, name: "Helper" }, agentAccessTurnedOff: [acme.id] });
    const second = server.addDevice("agent", "Second", [acme.id]);
    server.inboxes.find((inbox) => inbox.id === acme.id)!.agentAccess = true;
    const kept = await run(["agent", "remove", "Second", "--keep-access"], options);
    assert.equal(kept.code, 0, kept.stderr);
    assert.equal(server.calls("updateInbox").length, 1);
    assert.ok(!server.devices.some((device) => device.id === second.device.id));
  });

  test("without a terminal and without a flag it changes nothing and names both flags", async () => {
    const { helper } = agents();
    for (const argv of [["agent", "remove", "Helper"], ["agent", "remove", "Helper", "--json"]]) {
      const ran = await run(argv, argv.includes("--json") ? { ...options, interactive: true, answers: [] } : options);
      assert.equal(ran.code, 2, argv.join(" "));
      assert.match(ran.stderr, /Pass --access-off to turn agent access off for its inboxes no other agent uses, or --keep-access\./);
      assert.deepEqual(ran.questions, []);
    }
    assert.ok(server.devices.some((device) => device.id === helper.device.id), "the agent is still there");
    assert.equal(server.calls("revokeDevice").length, 0);
  });

  test("with no inbox only it used, nothing is asked", async () => {
    const shared = server.addInbox({ name: "Shared", address: "team@acme.example", agentAccess: true });
    server.addDevice("agent", "Helper", [shared.id]);
    server.addDevice("agent", "Other", [shared.id]);
    const ran = await run(["agent", "remove", "Helper"], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.doesNotMatch(ran.stdout, /agent access/i);
  });

  test("refuses both flags at once", async () => {
    agents();
    const ran = await run(["agent", "remove", "Helper", "--access-off", "--keep-access"], options);
    assert.equal(ran.code, 2);
    assert.equal(server.calls("revokeDevice").length, 0);
  });
});

describe("the paired device, as the server says", () => {
  test("devices marks the device the token in use belongs to", async () => {
    const mac = server.addDevice("person", "Ana's Mac");
    const own = await run(["devices"], options);
    assert.match(own.stdout, /usual-mail on test-machine \(this command\)/);
    const other = await run(["devices"], { ...options, env: { USUAL_MAIL_TOKEN: mac.token } });
    assert.match(other.stdout, /Ana's Mac \(this command\)/);
    assert.doesNotMatch(other.stdout, /usual-mail on test-machine \(this command\)/);
    assert.ok(server.calls("me").length >= 2);
  });

  test("revoking with USUAL_MAIL_TOKEN's device asks first, since it is the one in use", async () => {
    const mac = server.addDevice("person", "Ana's Mac");
    const ran = await run(["devices", "revoke", "Ana's Mac"], { ...options, env: { USUAL_MAIL_TOKEN: mac.token }, interactive: true, answers: ["n"] });
    assert.deepEqual(ran.questions, ["Revoke it anyway? [y/N] "]);
    assert.equal(server.calls("revokeDevice").length, 0);
  });

  test("revoking the last person's device says the server made a new owner's code", async () => {
    const ran = await run(["devices", "revoke", me.device.id, "--yes"], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /No app or browser is paired any more, so the server made a new owner's pairing code\./);
    assert.ok(server.ownerCode, "the stand-in, like the server, made one");
    server.addDevice("person", "Ana's Mac");
    const another = server.addDevice("person", "iPhone");
    const notLast = await run(["devices", "revoke", "iPhone"], { ...options, env: { USUAL_MAIL_TOKEN: another.token }, interactive: true, answers: ["y"] });
    assert.doesNotMatch(notLast.stdout, /owner's pairing code/);
  });
});

describe("--json asks nothing", () => {
  test("in a terminal, a command with --json fails with the flags it needs instead of asking", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    const cases: Array<[string[], RegExp]> = [
      [["inbox", "add", "--json"], /Pass --provider, --name, --color, --secrets-stdin\./],
      [["agent", "add", "--json"], /Pass the agent's name and --inbox \(or --all\)/],
    ];
    for (const [argv, flags] of cases) {
      const ran = await run(argv, { ...options, interactive: true, answers: [] });
      assert.equal(ran.code, 2, argv.join(" "));
      assert.deepEqual(ran.questions, [], argv.join(" "));
      assert.equal(ran.stdout, "", "nothing but JSON would go to standard output");
      const printed = JSON.parse(ran.stderr);
      assert.equal(printed.error.code, "not_a_terminal");
      assert.match(printed.error.message, /^With --json nothing is asked/);
      assert.match(printed.error.message, flags);
    }
    const fresh = scratch();
    try {
      const init = await run(["init", "--json"], { home: fresh.dir, interactive: true, answers: [] });
      assert.equal(init.code, 2);
      assert.deepEqual(init.questions, []);
      assert.match(JSON.parse(init.stderr).error.message, /With --json nothing is asked.*Pass --mode docker or --mode node/);
    } finally {
      fresh.remove();
    }
  });

  test("with --json and every flag given, it works in a terminal and prints only JSON", async () => {
    const ran = await run(
      ["inbox", "add", "--provider", "gmail", "--name", "G", "--color", "red", "--client-id", "x", "--secrets-stdin", "--json"],
      { ...options, interactive: true, answers: [], stdin: "secret\nrefresh\n" },
    );
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(JSON.parse(ran.stdout).name, "G");
  });
});
