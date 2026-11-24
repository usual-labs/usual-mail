// Node mode with real processes: the command run from source, and a stand-in server that, like the real one, closes
// its port at SIGTERM, ignores a second SIGTERM, and takes a while to store the mail in hand before it exits. A stop
// interrupted with Ctrl-C leaves that process running; until it has exited it still counts as the server, so
// `start` lets it finish instead of starting a second server on the same data folder. A `stop` and a `start` waiting
// on the same server never lose the record of the server `start` then starts, and a record naming a process that
// isn't this data folder's server (its id reused, or another user's) is never signalled.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { freePort, savedConfig, scratch } from "./helpers.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
/** How long the stand-in takes to stop after SIGTERM. */
const STOP_MS = 3_000;

const STAND_IN = `
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const record = (what) => appendFileSync(join(arg("--data-dir"), "events"), what + " " + process.pid + "\\n");
const server = createServer((request, response) => {
  const health = request.url === "/healthz";
  response.writeHead(health ? 200 : 404, { "content-type": "application/json" }).end(health ? '{"ok":true}' : "{}");
});
server.listen(Number(arg("--port")), arg("--host"), () => record("start"));
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  record("stopping");
  server.close();
  server.closeAllConnections();
  setTimeout(() => {
    record("exit");
    process.exit(0);
  }, ${STOP_MS});
});
`;

/**
 * Another program of this user's, run as if it served another data folder whose name begins with this one's: it notes
 * each SIGTERM in the file it is given and otherwise runs until killed.
 */
const OTHER_PROGRAM = `
import { appendFileSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => appendFileSync(process.argv[2], "SIGTERM\\n"));
setInterval(() => {}, 1000);
writeFileSync(process.argv[2] + ".ready", "");
`;

let home: { dir: string; remove: () => void };
let dataDir: string;
let serverFile: string;
let port: number;
/** Every process a test started, killed afterwards whatever happened. */
let children: ChildProcess[];

beforeEach(async () => {
  home = scratch();
  children = [];
  dataDir = join(home.dir, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  serverFile = join(home.dir, "server.mjs");
  writeFileSync(serverFile, STAND_IN);
  port = await freePort();
  savedConfig(home.dir, { server: `http://127.0.0.1:${port}`, run: { mode: "node", dataDir, port, serverFile } });
});

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGCONT");
    child.kill("SIGKILL");
  }
  for (const [, pid] of events()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
  await until(() => events().every(([, pid]) => !alive(pid)));
  home.remove();
});

/** What the stand-ins did, in order: ["start" | "stopping" | "exit", pid]. */
function events(): Array<[string, number]> {
  const file = join(dataDir, "events");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [what, pid] = line.split(" ");
      return [what!, Number(pid)];
    });
}

/** The command's pid file, as `usual-mail start` writes it. */
const pidFile = () => join(home.dir, ".local", "state", "usual-mail", "server.pid");

function writePidFile(text: string): void {
  mkdirSync(dirname(pidFile()), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile(), text, { mode: 0o600 });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(done: () => boolean, ms = 20_000): Promise<void> {
  for (const deadline = Date.now() + ms; !done(); ) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The command from source, with only the scratch home's settings and a system PATH. */
function spawnCli(args: string[]): ChildProcess & { output: { stdout: string; stderr: string } } {
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home.dir,
    XDG_CONFIG_HOME: join(home.dir, ".config"),
    XDG_DATA_HOME: join(home.dir, ".local", "share"),
    XDG_STATE_HOME: join(home.dir, ".local", "state"),
  };
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const output = { stdout: "", stderr: "" };
  child.stdout!.on("data", (chunk: Buffer) => (output.stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (output.stderr += chunk.toString()));
  return Object.assign(child, { output });
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
}

/** Runs the command to its end, killing it after `ms`, as a command waiting for something that never happens. */
async function cli(args: string[], ms = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawnCli(args);
  const timer = setTimeout(() => child.kill("SIGKILL"), ms);
  const { code } = await exited(child);
  clearTimeout(timer);
  return { code, ...child.output };
}

test("a stop interrupted with Ctrl-C still counts as a running server, and start lets it finish before starting another", async () => {
  const started = await cli(["start", "--wait", "20"]);
  assert.equal(started.code, 0, started.stderr);
  const first = events()[0]![1];

  // Ctrl-C once the server has its SIGTERM and is storing the mail in hand.
  const stopping = spawnCli(["stop"]);
  await until(() => events().some(([what]) => what === "stopping"));
  stopping.kill("SIGINT");
  assert.equal((await exited(stopping)).signal, "SIGINT");
  assert.ok(alive(first), "the server is still stopping");

  const state = await cli(["status", "--json"]);
  const again = await cli(["start", "--wait", "20"]);

  assert.equal(again.code, 0, again.stderr);
  const seen = events();
  assert.deepEqual(
    seen.map(([what]) => what),
    ["start", "stopping", "exit", "start"],
    "the first server exited before the second started, never two on one data folder",
  );
  assert.equal(seen[2]![1], first);
  assert.match(again.stderr, /still stopping after an interrupted `usual-mail stop`/);
  assert.equal(again.stdout, `Started. Usual Mail answers at ${JSON.parse(state.stdout).server}.\n`);
  // While it stopped, it counted as running.
  assert.equal(JSON.parse(state.stdout).state, "running");
  assert.equal(JSON.parse(state.stdout).stateDetail, "stopping");
});

test("start finishing a stop that runs in another terminal says so, and that stop then leaves the new server's record alone", async () => {
  const started = await cli(["start", "--wait", "20"]);
  assert.equal(started.code, 0, started.stderr);
  const first = events()[0]![1];

  // `usual-mail stop` in one terminal, held still once the server has its SIGTERM, so that `start` in another sees
  // the server exit first and starts the next one before that stop looks again.
  const stopping = spawnCli(["stop"]);
  await until(() => events().some(([what]) => what === "stopping"));
  stopping.kill("SIGSTOP");
  const again = await cli(["start", "--wait", "20"]);
  const stopped = exited(stopping);
  stopping.kill("SIGCONT");
  assert.equal((await stopped).code, 0, stopping.output.stderr);

  assert.equal(again.code, 0, again.stderr);
  const seen = events();
  assert.deepEqual(seen.map(([what]) => what), ["start", "stopping", "exit", "start"]);
  assert.equal(seen[2]![1], first);
  const second = seen[3]![1];
  assert.equal(stopping.output.stdout, "Stopped.\n");
  assert.ok(existsSync(pidFile()), "the new server's record is kept");
  assert.equal(readFileSync(pidFile(), "utf8"), `${second}\n`);
  const state = JSON.parse((await cli(["status", "--json"])).stdout);
  assert.equal(state.state, "running");
  assert.equal(state.stateDetail, undefined);
  assert.ok(alive(second));
  assert.match(again.stderr, /still stopping: another `usual-mail` command is stopping it/);
  assert.doesNotMatch(again.stderr, /interrupted/, "that stop wasn't interrupted, it still runs");
});

test("a stale stopping record naming another program of this user isn't the server: nothing signals it", async () => {
  const program = join(home.dir, "other.mjs");
  writeFileSync(program, OTHER_PROGRAM);
  const signals = join(home.dir, "other-signals");
  const other = spawn(process.execPath, [program, signals, "--data-dir", `${dataDir}-other`], { stdio: "ignore" });
  children.push(other);
  await until(() => existsSync(`${signals}.ready`));
  writePidFile(`${other.pid}\nstopping\n`);

  const state = JSON.parse((await cli(["status", "--json"])).stdout);
  assert.equal(state.state, "stopped", "another program isn't the server");
  const stop = await cli(["stop"], 10_000);
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(stop.stdout, "It wasn't running.\n");
  assert.ok(!existsSync(pidFile()), "the stale record went");

  writePidFile(`${other.pid}\nstopping\n`);
  const started = await cli(["start", "--wait", "20"], 15_000);
  assert.equal(started.code, 0, started.stderr);
  assert.doesNotMatch(started.stderr, /stopping/);
  assert.equal(readFileSync(pidFile(), "utf8"), `${events()[0]![1]}\n`);

  assert.ok(!existsSync(signals), "the other program got no signal");
  assert.ok(alive(other.pid!));
});

test("a record naming another user's process (pid 1) isn't the server: status, stop and start carry on", { skip: process.getuid?.() === 0 && "as root, pid 1 is this user's" }, async () => {
  writePidFile("1\nstopping\n");
  const state = JSON.parse((await cli(["status", "--json"])).stdout);
  assert.equal(state.state, "stopped");
  const stop = await cli(["stop"], 10_000);
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(stop.stdout, "It wasn't running.\n");

  writePidFile("1\n");
  const started = await cli(["start", "--wait", "20"], 15_000);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(readFileSync(pidFile(), "utf8"), `${events()[0]![1]}\n`);
});

test("a server whose record an older usual-mail wrote (its pid alone) is still stopped", async () => {
  // As `usual-mail start` 0.1.0 left it: the server's process, and a file holding its id.
  const server = spawn(process.execPath, [serverFile, "--data-dir", dataDir, "--port", String(port), "--host", "127.0.0.1"], {
    detached: true,
    stdio: "ignore",
  });
  server.unref();
  await until(() => events().some(([what]) => what === "start"));
  writePidFile(`${server.pid}\n`);

  const state = JSON.parse((await cli(["status", "--json"])).stdout);
  assert.equal(state.state, "running");
  assert.equal(state.stateDetail, undefined);
  const stop = await cli(["stop"]);
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(stop.stdout, "Stopped.\n");
  assert.deepEqual(events(), [["start", server.pid], ["stopping", server.pid], ["exit", server.pid]]);
  assert.ok(!existsSync(pidFile()));
});
