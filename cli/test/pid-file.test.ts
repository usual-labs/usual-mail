// Node mode's pid file and which process counts as the server. A removal that finds another command's newer record
// puts it back, also on a filesystem without hard links, and this command's own process is never taken for the server
// even when its id was the server's and its command line holds the same data folder.

import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { nodeLauncher, pidFile } from "../src/launch/node.ts";
import { readRecord, removeRecord, writeRecord } from "../src/launch/pid-file.ts";
import { FakeNode } from "./fakes.ts";
import { context, freePort, scratch } from "./helpers.ts";

let home: { dir: string; remove: () => void };
let file: string;

beforeEach(() => {
  home = scratch();
  file = join(home.dir, "server.pid");
});
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  home.remove();
});

/** Replaces one of `node:fs`'s functions for `pid-file.ts` too, whose named imports follow it once synced. */
function replace<Name extends "renameSync" | "linkSync">(name: Name, by: (typeof fs)[Name]): void {
  mock.method(fs, name, by);
  syncBuiltinESMExports();
}

/** As another command recording the next server between this command's read of the file and its rename. */
function newerRecordBeforeTheRename(pid: number): void {
  const rename = fs.renameSync;
  let first = true;
  replace("renameSync", (from, to) => {
    if (first) {
      first = false;
      writeFileSync(file, `${pid}\n`, { mode: 0o600 });
    }
    rename(from, to);
  });
}

/** What is left beside the record: this command's own temporary names must all be gone. */
const leftOver = () => readdirSync(home.dir).filter((name) => name !== "server.pid");

test("a removal takes away its own server's record", () => {
  writeRecord(file, { pid: 100, stoppedBy: 7 });
  assert.equal(removeRecord(file, 100), true);
  assert.ok(!existsSync(file));
  assert.deepEqual(leftOver(), []);
});

test("a removal that finds the next server's record puts it back with a hard link", () => {
  writeRecord(file, { pid: 100, stoppedBy: 7 });
  newerRecordBeforeTheRename(200);
  assert.equal(removeRecord(file, 100), false);
  assert.deepEqual(readRecord(file), { pid: 200 });
  assert.deepEqual(leftOver(), []);
});

test("on a filesystem without hard links, the next server's record goes back by a rename, not lost", () => {
  writeRecord(file, { pid: 100, stoppedBy: 7 });
  newerRecordBeforeTheRename(200);
  replace("linkSync", () => {
    throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
  });
  assert.equal(removeRecord(file, 100), false);
  assert.deepEqual(readRecord(file), { pid: 200 }, "kept");
  assert.deepEqual(leftOver(), []);
});

test("a record naming this command's own process isn't the server, even when its command line holds the data folder", async () => {
  const dataDir = join(home.dir, "data");
  /** As if this process had taken over the id of a server that ended, run as `usual-mail … --data-dir <dataDir>`. */
  class OwnIdTaken extends FakeNode {
    override isAlive(pid: number): boolean {
      return pid === process.pid || super.isAlive(pid);
    }
    override async commandLine(pid: number): Promise<string | null> {
      return pid === process.pid ? `node usual-mail stop --data-dir ${dataDir}` : super.commandLine(pid);
    }
  }
  const node = new OwnIdTaken();
  const { ctx } = context({ home: home.dir, runner: node });
  mkdirSync(dirname(pidFile(ctx)), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile(ctx), `${process.pid}\nstopping ${process.pid}\n`, { mode: 0o600 });
  // A free port, never the one a real server here may use: nothing is reached, but nothing could be.
  const launcher = nodeLauncher(ctx, { mode: "node", dataDir, port: await freePort(), serverFile: join(home.dir, "server.mjs") });

  assert.deepEqual(await launcher.state(), { state: "stopped" });
  assert.equal(await launcher.stop(), false);
  assert.deepEqual(node.signals, [], "this command never signals itself");
  assert.ok(!existsSync(pidFile(ctx)), "the stale record went");
});
