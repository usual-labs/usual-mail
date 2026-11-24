// Without a terminal nothing is asked: commands take flags or fail with a message naming them, and change nothing.
// The test context throws if a command asks a question when it isn't interactive.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { configPath, freePort, run, savedConfig, scratch, type Options } from "./helpers.ts";
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
  server.addInbox({ name: "Acme", address: "ana@acme.example" });
  savedConfig(home.dir, { server: server.url, token: me.token, deviceId: me.device.id });
  options = { home: home.dir };
});

/** Nothing was changed on the server. */
const unchanged = () =>
  assert.deepEqual(
    server.requests.filter((request) => request.method !== "GET").map((request) => request.route),
    [],
  );

test("init without --mode, the first time", async () => {
  const fresh = scratch();
  try {
    const ran = await run(["init", "--port", String(await freePort())], { home: fresh.dir });
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /This isn't a terminal, so nothing can be asked\. Pass --mode docker or --mode node/);
    assert.equal(existsSync(configPath(fresh.dir)), false);
    const json = await run(["init", "--json"], { home: fresh.dir });
    assert.equal(JSON.parse(json.stderr).error.code, "not_a_terminal");
  } finally {
    fresh.remove();
  }
});

test("init --server without a code", async () => {
  const fresh = scratch();
  try {
    const ran = await run(["init", "--server", server.url], { home: fresh.dir });
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /Pass --code with a pairing code/);
    assert.equal(server.calls("pair").length, 0);
  } finally {
    fresh.remove();
  }
});

test("inbox add names every missing flag at once", async () => {
  const bare = await run(["inbox", "add"], options);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /Pass --provider, --name, --color, --secrets-stdin\./);
  const imap = await run(["inbox", "add", "--provider", "imap", "--name", "A", "--color", "red"], options);
  assert.match(imap.stderr, /Pass --address, --imap-host, --smtp-host, --secrets-stdin\./);
  const gmail = await run(["inbox", "add", "--provider", "gmail", "--name", "A", "--color", "red", "--secrets-stdin"], options);
  assert.match(gmail.stderr, /Pass --client-id\./);
  unchanged();
});

test("inbox add with --secrets-stdin and nothing on standard input", async () => {
  const ran = await run(
    ["inbox", "add", "--provider", "gmail", "--name", "A", "--color", "red", "--client-id", "x", "--secrets-stdin"],
    { ...options, stdin: "" },
  );
  assert.equal(ran.code, 2);
  assert.match(ran.stderr, /--secrets-stdin found nothing on standard input/);
  unchanged();
});

test("agent add without a name or inboxes", async () => {
  for (const argv of [["agent", "add"], ["agent", "add", "Helper"], ["agent", "add", "--all"]]) {
    const ran = await run(argv, options);
    assert.equal(ran.code, 2, argv.join(" "));
    assert.match(ran.stderr, /Pass the agent's name and --inbox \(or --all\)/);
  }
  unchanged();
});

test("inbox remove without --yes", async () => {
  const ran = await run(["inbox", "remove", "Acme"], options);
  assert.equal(ran.code, 2);
  assert.match(ran.stderr, /Pass --yes to remove it without asking\./);
  unchanged();
});

test("devices revoke of this command's own device without --yes", async () => {
  const ran = await run(["devices", "revoke", me.device.id], options);
  assert.equal(ran.code, 2);
  assert.match(ran.stderr, /Pass --yes to revoke this command's own device\./);
  unchanged();
  const yes = await run(["devices", "revoke", me.device.id, "--yes"], options);
  assert.equal(yes.code, 0, yes.stderr);
  assert.equal(server.calls("revokeDevice").length, 1);
});
