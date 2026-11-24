// Stopping the server init set up gives it as long as the Compose files do (three minutes): its stop stores the mail
// in hand first, up to about two and a half minutes during a Gmail first sync. A stop that takes more than a moment
// says what it waits for; a Node process still running after three minutes is killed.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { readConfig } from "../src/config.ts";
import type { Context } from "../src/context.ts";
import { dockerLauncher } from "../src/launch/docker.ts";
import { STOP_SECONDS, waitForStop } from "../src/launch/launcher.ts";
import { nodeLauncher } from "../src/launch/node.ts";
import { closeAll, FakeDocker, FakeNode } from "./fakes.ts";
import { context, freePort, run, scratch } from "./helpers.ts";

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

const KILLED = /The server didn't stop within 3 minutes, so it was killed\. It fetches the mail it was fetching again when it starts\./g;
const WAITING = /Waiting for the server to store the mail it is fetching before it stops \(up to 3 minutes during an inbox's first sync\)/g;

test("Docker: the container is made and stopped with three minutes to stop, and a slow stop says what it waits for", async () => {
  const docker = new FakeDocker();
  docker.images.add("usual-mail");
  const opts = { home: home.dir, runner: docker };
  assert.equal((await run(["init", "--mode", "docker", "--data-dir", dataDir, "--port", String(port)], opts)).code, 0);
  const made = docker.calls.find((call) => call[1] === "run")!;
  assert.equal(made[made.indexOf("--stop-timeout") + 1], "180");

  docker.stopTakesMs = 300;
  const stopped = await run(["stop"], opts);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(stopped.stdout, "Stopped.\n");
  assert.equal(stopped.stderr.match(WAITING)?.length, 1, "said once");
  assert.deepEqual(docker.calls.find((call) => call[1] === "stop"), ["docker", "stop", "-t", "180", "usual-mail"]);
});

/** A clock that moves only when the command sleeps, each sleep a turn of the event loop. */
function virtualClock(ctx: Context): () => number {
  let clock = 0;
  ctx.now = () => clock;
  ctx.sleep = async (ms) => {
    clock += ms;
    await new Promise((resolve) => setImmediate(resolve));
  };
  return () => clock;
}

test("Docker: a server Docker killed when its three minutes ran out is said to be killed", async () => {
  const docker = new FakeDocker();
  docker.images.add("usual-mail");
  const opts = { home: home.dir, runner: docker };
  assert.equal((await run(["init", "--mode", "docker", "--data-dir", dataDir, "--port", String(port)], opts)).code, 0);
  const quick = await run(["stop"], opts);
  assert.equal(quick.stdout, "Stopped.\n");
  assert.doesNotMatch(quick.stderr, KILLED, "a server that stopped by itself isn't said to be killed");

  assert.equal((await run(["start"], opts)).code, 0);
  const { ctx, stderr } = context({ home: home.dir, runner: docker });
  const clock = virtualClock(ctx);
  // Docker's three minutes start when it sends SIGTERM, after the command's: it kills the server once they are up.
  docker.stopUntil = () => clock() >= STOP_SECONDS * 1000;
  docker.stopKills = true;
  assert.equal(await dockerLauncher(ctx, readConfig(ctx).run!).stop(), true);
  assert.equal(stderr.join("").match(KILLED)?.length, 1);
});

test("Docker: an exit code of 137 left by an earlier kill (out of memory in a restart loop) isn't said to be this stop's", async () => {
  const docker = new FakeDocker();
  docker.images.add("usual-mail");
  const opts = { home: home.dir, runner: docker };
  assert.equal((await run(["init", "--mode", "docker", "--data-dir", dataDir, "--port", String(port)], opts)).code, 0);
  // As a container restarting after the kernel killed it for memory: `docker stop` ends it at once, and its last exit
  // code stays 137, with Docker's OOMKilled flag.
  docker.stopKills = true;
  docker.oomKilled = true;
  const oom = await run(["stop"], opts);
  assert.equal(oom.code, 0, oom.stderr);
  assert.equal(oom.stdout, "Stopped.\n");
  assert.doesNotMatch(oom.stderr, KILLED);

  // Killed some other way before (`docker kill`): 137 without the flag, and still a stop that took a moment.
  assert.equal((await run(["start"], opts)).code, 0);
  docker.oomKilled = false;
  const earlier = await run(["stop"], opts);
  assert.equal(earlier.stdout, "Stopped.\n");
  assert.doesNotMatch(earlier.stderr, KILLED);

  // Out of memory while it stored the mail in hand, after the three minutes: killed, but not by the deadline.
  assert.equal((await run(["start"], opts)).code, 0);
  const { ctx, stderr } = context({ home: home.dir, runner: docker });
  const clock = virtualClock(ctx);
  docker.stopUntil = () => clock() >= STOP_SECONDS * 1000;
  docker.oomKilled = true;
  assert.equal(await dockerLauncher(ctx, readConfig(ctx).run!).stop(), true);
  assert.doesNotMatch(stderr.join(""), KILLED);
});

test("Docker: a running container made with other settings is stopped with its time to stop before it is made again", async () => {
  const docker = new FakeDocker();
  docker.images.add("usual-mail");
  const opts = { home: home.dir, runner: docker };
  const flags = ["init", "--mode", "docker", "--data-dir", dataDir, "--port", String(port)];
  assert.equal((await run(flags, opts)).code, 0);
  // As a container made by an earlier usual-mail, before it gave the server time to stop: init makes it again.
  docker.containers.get("usual-mail")!.label = "0123456789abcdef";
  docker.calls.length = 0;
  const again = await run(flags, opts);
  assert.equal(again.code, 0, again.stderr);
  const verbs = docker.verbs();
  assert.ok(verbs.indexOf("stop") >= 0 && verbs.indexOf("stop") < verbs.indexOf("rm"), `stopped before removed: ${verbs.join(" ")}`);
  assert.deepEqual(docker.calls.find((call) => call[1] === "stop"), ["docker", "stop", "-t", "180", "usual-mail"]);
  assert.ok(verbs.includes("run"));
});

test("Node: the process gets three minutes after SIGTERM, not ten seconds, and a slow stop says what it waits for", async () => {
  const root = join(home.dir, "usual-mail");
  mkdirSync(join(root, "server/dist"), { recursive: true });
  writeFileSync(join(root, "server/dist/server.mjs"), "// the server\n");
  const node = new FakeNode();
  const opts = { home: home.dir, runner: node };
  const flags = ["init", "--mode", "node", "--data-dir", dataDir, "--port", String(port), "--server-file", join(root, "server/dist/server.mjs")];
  assert.equal((await run(flags, opts)).code, 0);
  // Fifteen seconds of checks every tenth of a second: longer than the ten the command used to give it.
  node.lingers = 150;
  const stopped = await run(["stop"], opts);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(stopped.stdout, "Stopped.\n");
  assert.deepEqual(node.signals.map(([, signal]) => signal), ["SIGTERM"], "never killed");
  assert.equal(stopped.stderr.match(WAITING)?.length, 1, "said once");
});

test("Node: init after a stop interrupted with Ctrl-C lets that server finish before it starts another", async () => {
  const root = join(home.dir, "usual-mail");
  mkdirSync(join(root, "server/dist"), { recursive: true });
  writeFileSync(join(root, "server/dist/server.mjs"), "// the server\n");
  const node = new FakeNode();
  const opts = { home: home.dir, runner: node };
  const flags = ["init", "--mode", "node", "--data-dir", dataDir, "--port", String(port), "--server-file", join(root, "server/dist/server.mjs")];
  assert.equal((await run(flags, opts)).code, 0);
  node.lingers = 30;
  // `usual-mail stop`, then Ctrl-C while it waits: the command is gone, the server still stores the mail in hand and
  // has closed its port already.
  const { ctx } = context({ home: home.dir, runner: node });
  ctx.sleep = () => new Promise(() => {});
  void nodeLauncher(ctx, readConfig(ctx).run!).stop();
  for (let turn = 0; turn < 100 && node.signals.length === 0; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(node.signals.map(([, signal]) => signal), ["SIGTERM"], "the stop has sent its SIGTERM");

  const status = JSON.parse((await run(["status", "--json"], opts)).stdout);
  assert.equal(status.state, "running", "still the server while it stops");
  assert.equal(status.stateDetail, "stopping");
  const again = await run(flags, opts);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(node.overlapped, false, "no second server on the same data folder while the first one stopped");
  assert.equal(node.started.length, 2);
  assert.match(again.stderr, /still stopping after an interrupted `usual-mail stop`/);
  assert.deepEqual(node.signals.map(([, signal]) => signal), ["SIGTERM", "SIGTERM"], "let finish, not killed");
});

test("waitForStop gives up after three minutes, and says once what it waits for", async () => {
  const { ctx, stderr } = context({ home: home.dir });
  const clock = virtualClock(ctx);
  assert.equal(await waitForStop(ctx, () => false), false);
  assert.equal(clock(), STOP_SECONDS * 1000);
  assert.equal(stderr.join("").match(WAITING)?.length, 1);

  const late = virtualClock(ctx);
  assert.equal(await waitForStop(ctx, () => late() >= STOP_SECONDS * 1000 - 100), true, "stopped just in time");
  const quick = virtualClock(ctx);
  stderr.length = 0;
  assert.equal(await waitForStop(ctx, () => quick() >= 1_900), true);
  assert.deepEqual(stderr, [], "a quick stop says nothing");

  // The time is the clock's, not a count of checks: checks that take longer than their tenth of a second (a slow
  // `docker stop` call, a busy machine) don't stretch the three minutes.
  const slow = virtualClock(ctx);
  const sleep = ctx.sleep;
  ctx.sleep = (ms) => sleep(ms * 3);
  assert.equal(await waitForStop(ctx, () => false), false);
  assert.equal(slow(), STOP_SECONDS * 1000);
});
