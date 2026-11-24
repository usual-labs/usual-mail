// `init` in both modes, with Docker and the server process replaced by fakes, in a scratch directory. Also
// start, stop, status, logs and doctor on the server init set up.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { closeAll, FakeDocker, FakeNode, serverFor } from "./fakes.ts";
import { configPath, freePort, mode, run, scratch } from "./helpers.ts";
import { OWNER_FILE, StandIn } from "./stand-in.ts";

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

const readConfig = () => JSON.parse(readFileSync(configPath(home.dir), "utf8"));
const dockerFlags = () => ["init", "--mode", "docker", "--data-dir", dataDir, "--port", String(port)];

/** A checkout of Usual Mail around a fake CLI file: the Dockerfile, server/ and core/. */
function checkout(): string {
  const root = join(home.dir, "usual-mail");
  for (const dir of ["server/dist", "core", "cli/dist"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(root, "server/package.json"), "{}");
  writeFileSync(join(root, "core/package.json"), "{}");
  writeFileSync(join(root, "server/dist/server.mjs"), "// the server\n");
  return root;
}

describe("init with Docker", () => {
  test("starts a container, pairs once with the owner's code, and saves owner-only settings", async () => {
    const docker = new FakeDocker();
    docker.images.add("usual-mail");
    const ran = await run(dockerFlags(), { home: home.dir, runner: docker });
    assert.equal(ran.code, 0, ran.stderr);

    const config = readConfig();
    assert.equal(config.server, `http://127.0.0.1:${port}`);
    assert.deepEqual(config.run, { mode: "docker", dataDir, port, image: "usual-mail", container: "usual-mail" });
    assert.match(config.token, /^umt_/);
    assert.equal(config.deviceName, "usual-mail on test-machine");
    assert.equal(mode(configPath(home.dir)), 0o600);
    assert.equal(mode(join(home.dir, ".config", "usual-mail")), 0o700);
    assert.equal(mode(dataDir), 0o700);

    const server = serverFor(dataDir);
    assert.equal(server.calls("pair").length, 1, "the owner's code is used once");
    assert.equal(existsSync(join(dataDir, OWNER_FILE)), false);
    assert.equal(server.devices[0]!.kind, "person");

    const [, ...runArgs] = docker.calls.find((call) => call[1] === "run")!;
    assert.deepEqual(runArgs, [
      "run", "--detach", "--name", "usual-mail", "--restart", "unless-stopped",
      "--publish", `127.0.0.1:${port}:8484`, "--volume", `${dataDir}:/data`,
      // The address the browser reaches it at, for Google sign-in's redirect: the container can't know it.
      "--env", `USUAL_MAIL_PUBLIC_URL=http://127.0.0.1:${port}`,
      "--label", runArgs[runArgs.indexOf("--label") + 1], "--user", "501:20", "usual-mail",
    ]);

    assert.match(ran.stdout, new RegExp(`Usual Mail runs at http://127\\.0\\.0\\.1:${port} \\(Docker; data in ~/data\\)\\.`));
    assert.match(ran.stdout, /This command is paired as "usual-mail on test-machine"\. Its token is in ~\/\.config\/usual-mail\/config\.json, readable only by you\./);
    assert.match(ran.stdout, /usual-mail inbox add {4}connect a mailbox/);
    assert.match(ran.stderr, /Paired this command with the server/);
    assert.ok(!`${ran.stdout}${ran.stderr}`.includes(config.token), "the token is never printed");
  });

  test("a second run changes nothing: no new pairing, no new container, the same file", async () => {
    const docker = new FakeDocker();
    docker.images.add("usual-mail");
    assert.equal((await run(dockerFlags(), { home: home.dir, runner: docker })).code, 0);
    const before = readFileSync(configPath(home.dir), "utf8");
    const mtime = statSync(configPath(home.dir)).mtimeMs;
    docker.calls.length = 0;

    const again = await run(dockerFlags(), { home: home.dir, runner: docker });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Usual Mail already runs at/);
    assert.match(again.stdout, /Nothing changed\./);
    assert.equal(readFileSync(configPath(home.dir), "utf8"), before);
    assert.equal(statSync(configPath(home.dir)).mtimeMs, mtime);
    assert.equal(serverFor(dataDir).calls("pair").length, 1);
    assert.deepEqual([...new Set(docker.verbs())].sort(), ["container", "image", "version"]);

    const bare = await run(["init", "--json"], { home: home.dir, runner: docker });
    assert.equal(bare.code, 0, bare.stderr);
    const printed = JSON.parse(bare.stdout);
    assert.equal(printed.changed, false);
    assert.equal(printed.mode, "docker");
    assert.equal(printed.device.name, "usual-mail on test-machine");
    assert.ok(!("token" in printed));
  });

  test("builds the image from the checkout around the command when it is missing", async () => {
    const root = checkout();
    const docker = new FakeDocker();
    const ran = await run(dockerFlags(), { home: home.dir, runner: docker, cliFile: join(root, "cli/dist/usual-mail.mjs") });
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(docker.calls.find((call) => call[1] === "build"), ["docker", "build", "--tag", "usual-mail", root]);
    assert.match(ran.stderr, /Building the image "usual-mail" from/);
  });

  test("without an image or a checkout, or with --no-build, it says how to build one and writes nothing", async () => {
    const docker = new FakeDocker();
    const ran = await run(dockerFlags(), { home: home.dir, runner: docker });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /The image "usual-mail" isn't on this machine\. Build it from a checkout of Usual Mail \(`docker build -t usual-mail <checkout>`\)/);
    assert.equal(existsSync(configPath(home.dir)), false);
    const root = checkout();
    const noBuild = await run([...dockerFlags(), "--no-build"], { home: home.dir, runner: docker, cliFile: join(root, "cli/dist/x.mjs") });
    assert.equal(noBuild.code, 1);
    assert.ok(!docker.verbs().includes("build"));
  });

  test("when Docker doesn't answer it says to start Docker, and writes nothing", async () => {
    const docker = new FakeDocker();
    docker.answering = false;
    const ran = await run(dockerFlags(), { home: home.dir, runner: docker });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /Docker isn't answering\. Start Docker Desktop or the Docker service/);
    assert.equal(existsSync(configPath(home.dir)), false);
  });

  test("a new port remakes the container and keeps the token, since the data is the same", async () => {
    const docker = new FakeDocker();
    docker.images.add("usual-mail");
    assert.equal((await run(dockerFlags(), { home: home.dir, runner: docker })).code, 0);
    const token = readConfig().token;
    const newPort = await freePort();
    const ran = await run(["init", "--port", String(newPort)], { home: home.dir, runner: docker });
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stderr, /Stopped the server set up before with other settings\./);
    assert.ok(docker.verbs().includes("rm"));
    assert.equal(docker.containers.get("usual-mail")!.port, newPort);
    assert.equal(readConfig().token, token);
    assert.equal(readConfig().server, `http://127.0.0.1:${newPort}`);
    assert.equal(serverFor(dataDir).calls("pair").length, 1);
  });

  test("a new data directory is a new server, so it pairs again with that server's owner code", async () => {
    const docker = new FakeDocker();
    docker.images.add("usual-mail");
    assert.equal((await run(dockerFlags(), { home: home.dir, runner: docker })).code, 0);
    const other = join(home.dir, "other-data");
    const ran = await run(["init", "--data-dir", other], { home: home.dir, runner: docker });
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stderr, /The saved token no longer works here, so this command pairs again\./);
    assert.equal(serverFor(other).calls("pair").length, 1);
    assert.equal(readConfig().run.dataDir, other);
  });

  test("won't take over a container it didn't make", async () => {
    const docker = new FakeDocker();
    docker.images.add("usual-mail");
    docker.containers.set("usual-mail", { state: "exited", label: "", port, dataDir, args: [] });
    const ran = await run(dockerFlags(), { home: home.dir, runner: docker });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /A container named "usual-mail" exists that usual-mail didn't make/);
  });

  test("start, stop, status and logs work on the container", async () => {
    const docker = new FakeDocker();
    docker.images.add("usual-mail");
    assert.equal((await run(dockerFlags(), { home: home.dir, runner: docker })).code, 0);
    const opts = { home: home.dir, runner: docker };

    assert.match((await run(["start"], opts)).stdout, /It runs already/);
    const stopped = await run(["stop"], opts);
    assert.equal(stopped.stdout, "Stopped.\n");
    assert.equal(docker.containers.get("usual-mail")!.state, "exited");
    const down = await run(["status", "--json"], opts);
    assert.equal(down.code, 1);
    assert.deepEqual(
      { state: JSON.parse(down.stdout).state, answers: JSON.parse(down.stdout).answers, mode: JSON.parse(down.stdout).mode },
      { state: "stopped", answers: false, mode: "docker" },
    );
    assert.equal((await run(["stop"], opts)).stdout, "It wasn't running.\n");

    const started = await run(["start"], opts);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /Started\. Usual Mail answers at/);
    const up = await run(["status"], opts);
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /Runs with  Docker \(container usual-mail, image usual-mail\), data in ~\/data/);
    assert.match(up.stdout, /State      running/);
    assert.match(up.stdout, /Paired as  usual-mail on test-machine/);

    docker.calls.length = 0;
    assert.equal((await run(["logs", "--follow", "--lines", "5"], opts)).code, 0);
    assert.deepEqual(docker.calls[0], ["docker", "logs", "--follow", "--tail", "5", "usual-mail"]);
  });
});

describe("init with Node", () => {
  const nodeFlags = (serverFile: string) => ["init", "--mode", "node", "--data-dir", dataDir, "--port", String(port), "--server-file", serverFile];

  test("starts the server's built file on 127.0.0.1, pairs once, and a second run changes nothing", async () => {
    const root = checkout();
    const serverFile = join(root, "server/dist/server.mjs");
    const node = new FakeNode();
    const ran = await run(nodeFlags(serverFile), { home: home.dir, runner: node });
    assert.equal(ran.code, 0, ran.stderr);

    assert.deepEqual(node.started, [
      ["/usr/local/bin/node", serverFile, "--data-dir", dataDir, "--port", String(port), "--host", "127.0.0.1"],
    ]);
    const state = join(home.dir, ".local", "state", "usual-mail");
    assert.equal(mode(state), 0o700);
    assert.equal(mode(join(state, "server.pid")), 0o600);
    assert.equal(mode(join(state, "server.log")), 0o600);
    assert.equal(mode(configPath(home.dir)), 0o600);
    assert.deepEqual(readConfig().run, { mode: "node", dataDir, port, serverFile });
    assert.equal(serverFor(dataDir).calls("pair").length, 1);
    assert.match(ran.stdout, /Usual Mail runs at .* \(Node; data in ~\/data\)\./);

    const before = readFileSync(configPath(home.dir), "utf8");
    const again = await run(nodeFlags(serverFile), { home: home.dir, runner: node });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Nothing changed\./);
    assert.equal(node.started.length, 1);
    assert.equal(readFileSync(configPath(home.dir), "utf8"), before);
    assert.equal(serverFor(dataDir).calls("pair").length, 1);
  });

  test("finds the server's built file in the checkout around the command", async () => {
    const root = checkout();
    const node = new FakeNode();
    const ran = await run(["init", "--mode", "node", "--data-dir", dataDir, "--port", String(port)], {
      home: home.dir,
      runner: node,
      cliFile: join(root, "cli/dist/usual-mail.mjs"),
    });
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(readConfig().run.serverFile, join(root, "server/dist/server.mjs"));
  });

  test("without a built server it says how to build one", async () => {
    const ran = await run(nodeFlags(join(home.dir, "nowhere.mjs")), { home: home.dir, runner: new FakeNode() });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /The server's built file isn't at .*nowhere\.mjs\. In a checkout of Usual Mail, run `npm ci && npm run build`/);
    assert.equal(existsSync(configPath(home.dir)), false);
  });

  test("reads an owner code written as JSON", async () => {
    serverFor(dataDir, "json");
    const node = new FakeNode();
    const ran = await run(nodeFlags(join(checkout(), "server/dist/server.mjs")), { home: home.dir, runner: node });
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(serverFor(dataDir).calls("pair").length, 1);
  });

  test("stop, start, logs and doctor on the process", async () => {
    const node = new FakeNode();
    assert.equal((await run(nodeFlags(join(checkout(), "server/dist/server.mjs")), { home: home.dir, runner: node })).code, 0);
    const opts = { home: home.dir, runner: node };

    assert.equal((await run(["stop"], opts)).stdout, "Stopped.\n");
    assert.equal(node.signals[0]![1], "SIGTERM");
    assert.equal(existsSync(join(home.dir, ".local/state/usual-mail/server.pid")), false);
    assert.equal((await run(["status"], opts)).code, 1);

    const started = await run(["start"], opts);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(node.started.length, 2);
    const status = await run(["status"], opts);
    assert.match(status.stdout, /Paired as  usual-mail on test-machine/, "the token survives a restart");

    const logs = await run(["logs", "--lines", "1"], opts);
    assert.match(logs.stdout, /^Usual Mail server on http:\/\/127\.0\.0\.1:\d+ \(data in .*\)\n$/);

    const doctor = await run(["doctor"], opts);
    assert.equal(doctor.code, 0, doctor.stdout);
    assert.match(doctor.stdout, /ok    settings: ~\/\.config\/usual-mail\/config\.json, readable only by you/);
    assert.match(doctor.stdout, /ok    process: runs with Node/);
    assert.match(doctor.stdout, /ok    server: answers at http:\/\/127\.0\.0\.1:\d+/);
    assert.match(doctor.stdout, /ok    version: Usual Mail 0\.0\.0-stand-in, API 1/);
    assert.match(doctor.stdout, /ok    pairing: paired as "usual-mail on test-machine"/);
    assert.match(doctor.stdout, /ok    data: ~\/data, readable only by you/);
    assert.match(doctor.stdout, /warn  inboxes: none yet\n {6}Run `usual-mail inbox add`\./);
    assert.match(doctor.stdout, /ok    reach: only this machine can reach it/);

    chmodSync(dataDir, 0o755);
    serverFor(dataDir).addInbox({ name: "Acme", address: "ana@acme.example", status: "needs_attention", statusDetail: "The password was refused" });
    serverFor(dataDir).addInbox({ name: "Fresh", address: "me@fresh.example", status: "connecting", firstSync: { fetched: 120, total: 340 } });
    const sick = await run(["doctor", "--json"], { ...opts, networkAddresses: ["127.0.0.1"] });
    assert.equal(sick.code, 1);
    const checks = JSON.parse(sick.stdout);
    assert.equal(checks.ok, false);
    const byName = Object.fromEntries(checks.checks.map((c: { name: string }) => [c.name, c]));
    assert.equal(byName.data.level, "fail");
    assert.match(byName.data.fix, /chmod -R go-rwx ~\/data/);
    assert.equal(byName["inbox Acme"].level, "fail");
    assert.equal(byName["inbox Acme"].text, "needs attention: The password was refused");
    assert.deepEqual([byName["inbox Fresh"].level, byName["inbox Fresh"].text], ["ok", "fetching your mail · 120 of 340"], "a first sync says how far it has got");
    assert.equal(byName.reach.level, "warn");
    assert.match(byName.reach.text, /other devices can reach port \d+ at 127\.0\.0\.1/);
    assert.ok(!sick.stdout.includes(readConfig().token));
  });
});

describe("init in general", () => {
  test("in a terminal it asks how to run the server, where to keep data and which port", async () => {
    const docker = new FakeDocker();
    docker.images.add("usual-mail");
    const ran = await run(["init"], { home: home.dir, runner: docker, interactive: true, answers: ["1", dataDir, String(port), "14"] });
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(ran.questions, [
      "Number [1]: ",
      `Where to keep the server's data [${join(home.dir, ".local/share/usual-mail")}]: `,
      "Port on this machine [8484]: ",
      "Days of mail for a new inbox's first sync [30]: ",
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")), { syncDays: 14 });
    assert.match(ran.stdout, /How do you want to run the server\?\n {3}1 {2}Docker/);
    assert.equal(readConfig().run.dataDir, dataDir);
    const again = await run(["init"], { home: home.dir, runner: docker, interactive: true, answers: [] });
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(again.questions, [], "a second run asks nothing");
  });

  test("a data directory typed with ~ is under the home directory", async () => {
    const docker = new FakeDocker();
    docker.images.add("usual-mail");
    const ran = await run(["init", "--mode", "docker", "--port", String(port)], {
      home: home.dir,
      runner: docker,
      interactive: true,
      // The data directory, then the first sync's days (Enter keeps 30).
      answers: ["~/mail-data", ""],
    });
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(readConfig().run.dataDir, join(home.dir, "mail-data"));
    assert.equal(mode(join(home.dir, "mail-data")), 0o700);
  });

  test("a port another program holds is refused before anything starts", async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
    try {
      const docker = new FakeDocker();
      docker.images.add("usual-mail");
      const ran = await run(dockerFlags(), { home: home.dir, runner: docker });
      assert.equal(ran.code, 1);
      assert.match(ran.stderr, new RegExp(`Port ${port} is in use by another program\\. Pick another with --port\\.`));
      assert.ok(!docker.verbs().includes("run"));
    } finally {
      holder.close();
    }
  });

  test("a Usual Mail server it didn't start is pointed out, with how to use it", async () => {
    const other = new StandIn();
    await other.listen(port);
    try {
      const docker = new FakeDocker();
      docker.images.add("usual-mail");
      const ran = await run(dockerFlags(), { home: home.dir, runner: docker });
      assert.equal(ran.code, 1);
      assert.match(ran.stderr, new RegExp(`already answers at http://127\\.0\\.0\\.1:${port}.*\`usual-mail init --server http://127\\.0\\.0\\.1:${port}\``));
    } finally {
      await other.close();
    }
  });

  test("--server pairs with a server that runs elsewhere, from a code or the owner's file", async () => {
    mkdirSync(dataDir, { recursive: true });
    const other = new StandIn({ dataDir });
    await other.listen();
    try {
      const ran = await run(["init", "--server", other.url, "--data-dir", dataDir], { home: home.dir });
      assert.equal(ran.code, 0, ran.stderr);
      assert.match(ran.stdout, new RegExp(`This command now talks to the Usual Mail server at ${other.url}\\.`));
      const config = readConfig();
      assert.equal(config.server, other.url);
      assert.equal(config.run, undefined);
      assert.equal(mode(configPath(home.dir)), 0o600);

      const again = await run(["init", "--server", other.url], { home: home.dir });
      assert.equal(again.code, 0, again.stderr);
      assert.match(again.stdout, /already talks to/);
      assert.equal(other.calls("pair").length, 1);

      const start = await run(["start"], { home: home.dir });
      assert.equal(start.code, 1);
      assert.match(start.stderr, /usual-mail didn't set up the server at .* on this machine, so it can't start or stop it/);
    } finally {
      await other.close();
    }
  });

  test("with the owner's code used already, it says to make one and pass --code", async () => {
    const docker = new FakeDocker();
    docker.images.add("usual-mail");
    mkdirSync(dataDir, { recursive: true });
    serverFor(dataDir).addDevice("person", "Ana's Mac");
    const ran = await run(dockerFlags(), { home: home.dir, runner: docker });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /no owner's pairing code, because an app or browser is paired with it already.*run `usual-mail init --code <code>`/s);
  });
});
