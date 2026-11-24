// How many days of mail a new inbox's first sync takes: a setting of the server that persists. `init` asks for it and
// keeps it in the data directory's settings.json, where every start finds it (Node mode and Docker alike); `sync-days`
// changes it and restarts the server so it takes effect; `status` and `doctor` show what the server uses.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { closeAll, FakeDocker, FakeNode, serverFor } from "./fakes.ts";
import { freePort, mode, run, scratch } from "./helpers.ts";

let home: { dir: string; remove: () => void };
let port: number;
let dataDir: string;

beforeEach(async () => {
  home = scratch();
  port = await freePort();
  dataDir = join(home.dir, "data");
});
afterEach(async () => {
  await closeAll();
  home.remove();
});

function serverFile(): string {
  const root = join(home.dir, "usual-mail");
  mkdirSync(join(root, "server/dist"), { recursive: true });
  writeFileSync(join(root, "server/dist/server.mjs"), "// the server\n");
  return join(root, "server/dist/server.mjs");
}
const settingsFile = () => join(dataDir, "settings.json");
const saved = () => JSON.parse(readFileSync(settingsFile(), "utf8")) as { syncDays?: number };
const nodeInit = (...extra: string[]) => ["init", "--mode", "node", "--data-dir", dataDir, "--port", String(port), "--server-file", serverFile(), ...extra];

describe("the first sync's days", () => {
  test("init keeps them in the data directory, and a later plain start honours them (Node)", async () => {
    const node = new FakeNode();
    const opts = { home: home.dir, runner: node };
    const ran = await run(nodeInit("--sync-days", "7"), opts);
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(saved(), { syncDays: 7 });
    assert.equal(mode(settingsFile()), 0o600);
    assert.equal(serverFor(dataDir).firstSync.days, 7, "the server read them at its start");

    // The finding: a plain start used to go back to 30. The setting is in the data directory, so it doesn't.
    assert.equal((await run(["stop"], opts)).code, 0);
    serverFor(dataDir).firstSync.days = 30;
    const started = await run(["start"], opts);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(serverFor(dataDir).firstSync.days, 7);

    const status = await run(["status"], opts);
    assert.match(status.stdout, /First sync the last 7 days of mail, for each new inbox/);
    assert.equal(JSON.parse((await run(["status", "--json"], opts)).stdout).syncDays, 7);
    const doctor = JSON.parse((await run(["doctor", "--json"], opts)).stdout).checks.find((c: { name: string }) => c.name === "first sync");
    assert.equal(doctor.level, "ok");
    assert.match(doctor.text, /a new inbox's first sync takes the last 7 days of mail/);

    // A second init with the same settings changes nothing, and asks nothing.
    const again = await run(nodeInit(), { ...opts, interactive: true, answers: [] });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Nothing changed\./);
    assert.deepEqual(saved(), { syncDays: 7 });
  });

  test("init asks in a terminal, with the plain words, and takes USUAL_MAIL_SYNC_DAYS as the answer's default", async () => {
    const node = new FakeNode();
    const asked = await run(nodeInit(), { home: home.dir, runner: node, interactive: true, answers: [""] });
    assert.equal(asked.code, 0, asked.stderr);
    assert.deepEqual(asked.questions, ["Days of mail for a new inbox's first sync [30]: "]);
    assert.match(asked.stdout, /When you connect an inbox, the server first copies its recent mail and sorts it\./);
    assert.match(asked.stdout, /Older mail stays in your mailbox, and new mail always arrives\./);
    assert.deepEqual(saved(), { syncDays: 30 });

    await closeAll();
    const other = join(home.dir, "other");
    const fromEnv = await run(["init", "--mode", "node", "--data-dir", other, "--port", String(port), "--server-file", serverFile()], {
      home: home.dir, runner: node, env: { USUAL_MAIL_SYNC_DAYS: "5" },
    });
    assert.equal(fromEnv.code, 0, fromEnv.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(other, "settings.json"), "utf8")), { syncDays: 5 }, "kept, so a plain start later honours it");

    const bad = await run(nodeInit("--sync-days", "0"), { home: home.dir, runner: node });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--sync-days takes a whole number of days from 1 to 36500/);
  });

  test("sync-days changes it, restarts the server so it takes effect, and says what happens to inboxes", async () => {
    const node = new FakeNode();
    const opts = { home: home.dir, runner: node };
    assert.equal((await run(nodeInit("--sync-days", "30"), opts)).code, 0);

    const shown = await run(["sync-days"], opts);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /A new inbox's first sync takes the last 30 days of mail\./);
    assert.match(shown.stdout, /usual-mail sync-days <days>/);

    const smaller = await run(["sync-days", "7"], opts);
    assert.equal(smaller.code, 0, smaller.stderr);
    assert.deepEqual(saved(), { syncDays: 7 });
    assert.equal(node.started.length, 2, "restarted");
    assert.equal(serverFor(dataDir).firstSync.days, 7);
    assert.match(smaller.stdout, /A new inbox's first sync now takes the last 7 days of mail\./);
    assert.match(smaller.stdout, /An inbox still on its first sync stops fetching mail older than 7 days; what it fetched already stays\./);
    assert.match(smaller.stderr, /Restarted the server/);

    const larger = await run(["sync-days", "60"], opts);
    assert.equal(larger.code, 0, larger.stderr);
    assert.match(larger.stdout, /Inboxes connected from now on take 60 days\./);
    assert.match(larger.stdout, /Inboxes already connected keep the mail they have: fetching more for one would be a new first sync/);

    const same = await run(["sync-days", "60"], opts);
    assert.match(same.stdout, /already takes the last 60 days/);
    assert.equal(node.started.length, 3, "nothing to restart for");

    assert.equal((await run(["sync-days", "0"], opts)).code, 2);
    assert.equal((await run(["sync-days", "seven"], opts)).code, 2);
    assert.deepEqual(saved(), { syncDays: 60 });

    const json = JSON.parse((await run(["sync-days", "10", "--json"], opts)).stdout);
    assert.deepEqual(json, { syncDays: 10, file: settingsFile(), restarted: true, serverDays: 10 });

    // The environment variable still wins where the server starts: the command says so.
    const shadowed = await run(["sync-days", "12"], { ...opts, env: { USUAL_MAIL_SYNC_DAYS: "3" } });
    assert.equal(shadowed.code, 0, shadowed.stderr);
    assert.match(shadowed.stderr, /USUAL_MAIL_SYNC_DAYS is set to 3 here, and it wins over this setting/);
  });

  test("sync-days keeps what else the settings file holds, and needs --data-dir for a server set up elsewhere", async () => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(settingsFile(), JSON.stringify({ syncDays: 30, later: "kept" }), { mode: 0o600 });
    const nowhere = await run(["sync-days", "7"], { home: home.dir });
    assert.equal(nowhere.code, 2);
    assert.match(nowhere.stderr, /--data-dir/);
    const there = await run(["sync-days", "7", "--data-dir", dataDir], { home: home.dir });
    assert.equal(there.code, 0, there.stderr);
    assert.deepEqual(saved(), { syncDays: 7, later: "kept" });
    assert.match(there.stdout, /Restart the server where it runs for it to take effect/);
  });

  test("in Docker the container finds the setting in its data directory; sync-days restarts it", async () => {
    const docker = new FakeDocker();
    docker.images.add("usual-mail");
    const opts = { home: home.dir, runner: docker };
    const ran = await run(["init", "--mode", "docker", "--data-dir", dataDir, "--port", String(port), "--sync-days", "14"], opts);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(serverFor(dataDir).firstSync.days, 14);
    const before = docker.verbs().length;
    const changed = await run(["sync-days", "7"], opts);
    assert.equal(changed.code, 0, changed.stderr);
    const verbs = docker.verbs().slice(before);
    assert.ok(verbs.includes("stop") && verbs.includes("start"), `stopped and started again: ${verbs.join(" ")}`);
    assert.ok(!verbs.includes("run") && !verbs.includes("rm"), "not made again: the data directory holds the setting");
    assert.equal(serverFor(dataDir).firstSync.days, 7);
  });

  test("doctor says when the server takes other days than the saved setting", async () => {
    const node = new FakeNode();
    const opts = { home: home.dir, runner: node };
    assert.equal((await run(nodeInit("--sync-days", "7"), opts)).code, 0);
    // As when it was started with USUAL_MAIL_SYNC_DAYS, which wins.
    serverFor(dataDir).firstSync.days = 3;
    const check = JSON.parse((await run(["doctor", "--json"], opts)).stdout).checks.find((c: { name: string }) => c.name === "first sync");
    assert.equal(check.level, "warn");
    assert.match(check.text, /the server takes the last 3 days of mail, but the saved setting is 7/);
    assert.match(check.fix, /USUAL_MAIL_SYNC_DAYS/);
    assert.ok(existsSync(settingsFile()));
  });
});
