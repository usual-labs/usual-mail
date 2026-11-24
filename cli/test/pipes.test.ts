// Output cut short (`usual-mail … | head`): the command exits quietly instead of crashing with a stack trace.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { exitQuietlyOnClosedPipe } from "../src/pipes.ts";
import { scratch } from "./helpers.ts";

const entry = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");

test("a reader that stopped reading ends the command quietly; any other error on the stream is still thrown", () => {
  const stream = new EventEmitter();
  const exits: number[] = [];
  exitQuietlyOnClosedPipe([stream as unknown as NodeJS.WritableStream], (code) => exits.push(code));
  stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  assert.deepEqual(exits, [0]);
  assert.throws(() => stream.emit("error", Object.assign(new Error("disk full"), { code: "ENOSPC" })), /disk full/);
});

test("usual-mail whose output is closed before it writes exits 0 with nothing on standard error", async () => {
  const home = scratch();
  try {
    const child = spawn(process.execPath, [entry, "--help"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: home.dir, XDG_CONFIG_HOME: join(home.dir, "config") },
    });
    // The reader goes away at once, as `head` does once it has its lines.
    child.stdout.destroy();
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const code = await new Promise<number | null>((resolve) => child.on("close", (exit) => resolve(exit)));
    assert.equal(stderr, "", "no stack trace");
    assert.equal(code, 0);
  } finally {
    home.remove();
  }
});
