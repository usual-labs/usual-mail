// The owner's pairing code: the server writes it whenever no person's device is paired and again when it expires.
// `init` pairs with whatever code is there, and `doctor` says what to do.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { closeAll, FakeNode, serverFor } from "./fakes.ts";
import { configPath, freePort, run, scratch } from "./helpers.ts";
import { OWNER_FILE } from "./stand-in.ts";

let home: { dir: string; remove: () => void };
let port: number;
let dataDir: string;
let serverFile: string;

beforeEach(async () => {
  home = scratch();
  port = await freePort();
  dataDir = join(home.dir, "data");
  serverFile = join(home.dir, "server.mjs");
  writeFileSync(serverFile, "// the server\n");
});
afterEach(async () => {
  await closeAll();
  home.remove();
});

const initFlags = () => ["init", "--mode", "node", "--data-dir", dataDir, "--port", String(port), "--server-file", serverFile];
const readConfig = () => JSON.parse(readFileSync(configPath(home.dir), "utf8"));

test("after this command's device is removed and no person's device is left, init pairs again with the new owner's code", async () => {
  const node = new FakeNode();
  const opts = { home: home.dir, runner: node };
  assert.equal((await run(initFlags(), opts)).code, 0);
  const first = readConfig().token;
  assert.equal(existsSync(join(dataDir, OWNER_FILE)), false, "the code was used");

  const revoked = await run(["devices", "revoke", readConfig().deviceId, "--yes"], opts);
  assert.equal(revoked.code, 0, revoked.stderr);
  assert.ok(existsSync(join(dataDir, OWNER_FILE)), "the server wrote a new owner's code");

  const doctor = await run(["doctor", "--json"], opts);
  const checks = Object.fromEntries(JSON.parse(doctor.stdout).checks.map((c: { name: string }) => [c.name, c]));
  assert.equal(checks.pairing.level, "fail");
  assert.match(checks.pairing.fix, /Run `usual-mail init`: no person's device is paired, so the server wrote a new owner's code to ~\/data\/owner-pairing-code, and init pairs with it\./);
  assert.equal(checks["owner code"].level, "warn");
  assert.match(checks["owner code"].text, /no app or browser is paired, and the owner's pairing code waits in ~\/data\/owner-pairing-code/);

  const again = await run(initFlags(), opts);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stderr, /The saved token no longer works here, so this command pairs again\./);
  assert.notEqual(readConfig().token, first);
  assert.equal(serverFor(dataDir).calls("pair").length, 2);
  const healthy = await run(["doctor", "--json"], opts);
  const after = Object.fromEntries(JSON.parse(healthy.stdout).checks.map((c: { name: string }) => [c.name, c]));
  assert.equal(after.pairing.level, "ok");
  assert.equal(after["owner code"], undefined, "no code waits once a person's device is paired");
});

test("an owner's code that expired is replaced by the server, and init uses the new one", async () => {
  mkdirSync(dataDir, { recursive: true });
  const server = serverFor(dataDir);
  await server.listen(port);
  const old = readFileSync(join(dataDir, OWNER_FILE), "utf8").trim();
  server.expireOwnerCode();
  const fresh = readFileSync(join(dataDir, OWNER_FILE), "utf8").trim();
  assert.notEqual(fresh, old);
  const ran = await run(["init", "--server", server.url, "--data-dir", dataDir], { home: home.dir });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(server.calls("pair").map((request) => (request.body as { code: string }).code), [fresh]);
  assert.equal(existsSync(join(dataDir, OWNER_FILE)), false, "the server removed the file once the code was used");
});

test("when the code expires between reading it and pairing, init reads the new one and pairs", async () => {
  mkdirSync(dataDir, { recursive: true });
  const server = serverFor(dataDir);
  server.expireOwnerCodeOnNextPair = true;
  const ran = await run(initFlags(), { home: home.dir, runner: new FakeNode() });
  assert.equal(ran.code, 0, ran.stderr);
  assert.match(ran.stderr, /That owner's code had expired; the server wrote a new one, so this command uses that\./);
  assert.equal(server.calls("pair").length, 2);
  assert.equal(server.devices.filter((device) => device.kind === "person").length, 1);
});

test("a code made for an agent can't pair this command; the agent's new token is ended at once", async () => {
  mkdirSync(dataDir, { recursive: true });
  const server = serverFor(dataDir);
  await server.listen();
  const owner = server.addDevice("person", "Ana's Mac");
  const inbox = server.addInbox({ name: "Acme", address: "ana@acme.example", agentAccess: true });
  const code = await fetch(`${server.url}/v1/pairing-codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "agent", inboxIds: [inbox.id] }),
  }).then((response) => response.json() as Promise<{ code: string }>);
  const ran = await run(["init", "--server", server.url, "--code", code.code], { home: home.dir });
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /That code was made for an agent, so this command can't pair with it\./);
  assert.equal(server.calls("revokeDevice").length, 1);
  assert.deepEqual(server.devices.map((device) => device.kind), ["person"], "the agent device is gone");
  assert.equal(existsSync(configPath(home.dir)), false, "nothing was saved");
});

test("doctor fails an owner's code file other users can read", async () => {
  const node = new FakeNode();
  const opts = { home: home.dir, runner: node };
  assert.equal((await run(initFlags(), opts)).code, 0);
  await run(["devices", "revoke", readConfig().deviceId, "--yes"], opts);
  chmodSync(join(dataDir, OWNER_FILE), 0o644);
  const doctor = await run(["doctor", "--json"], opts);
  assert.equal(doctor.code, 1);
  const owner = JSON.parse(doctor.stdout).checks.find((c: { name: string }) => c.name === "owner code");
  assert.equal(owner.level, "fail");
  assert.match(owner.fix, /chmod 600 ~\/data\/owner-pairing-code/);
});

test("with another person's device still paired, doctor says to make a code there", async () => {
  const node = new FakeNode();
  const opts = { home: home.dir, runner: node };
  assert.equal((await run(initFlags(), opts)).code, 0);
  serverFor(dataDir).addDevice("person", "Ana's Mac");
  await run(["devices", "revoke", readConfig().deviceId, "--yes"], opts);
  const doctor = await run(["doctor", "--json"], opts);
  const pairing = JSON.parse(doctor.stdout).checks.find((c: { name: string }) => c.name === "pairing");
  assert.match(pairing.fix, /Another app or browser is still paired, so the server has no owner's code\..*usual-mail init --code <code>/);
  const init = await run(initFlags(), opts);
  assert.equal(init.code, 1);
  assert.match(init.stderr, /no owner's pairing code, because an app or browser is paired with it already/);
});
