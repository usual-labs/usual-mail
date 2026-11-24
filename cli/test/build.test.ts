// The one bundled file, the version, the hat colours against the design tokens, and small pieces.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { table, fromNow, isLoopback } from "../src/format.ts";
import { HATS, nearestHat } from "../src/hats.ts";
import { readOwnerCode } from "../src/launch/wait.ts";
import { VERSION } from "../src/version.ts";
import { context, scratch } from "./helpers.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(cli, "..");

test("the build is one file with no imports but Node's own, and it runs --help and --version", async () => {
  const { build } = await import("../scripts/build.mjs");
  const temp = scratch();
  try {
    const file = await build(join(temp.dir, "usual-mail.mjs"));
    const source = readFileSync(file, "utf8");
    assert.ok(source.startsWith("#!/usr/bin/env node\n"));
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]!);
    assert.ok(imports.length > 0);
    assert.deepEqual(imports.filter((name) => !name.startsWith("node:")), []);

    const help = spawnSync(process.execPath, [file, "--help"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: temp.dir } });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /usual-mail init\s+set up a server on this machine/);
    const version = spawnSync(process.execPath, [file, "--version"], { encoding: "utf8" });
    assert.equal(version.stdout, `usual-mail ${VERSION}\n`);
    const commandHelp = spawnSync(process.execPath, [file, "inbox", "add", "--help"], { encoding: "utf8" });
    assert.match(commandHelp.stdout, /^usual-mail inbox add /);
    const unknown = spawnSync(process.execPath, [file, "frobnicate"], { encoding: "utf8" });
    assert.equal(unknown.status, 2);
    // Run without a terminal and without settings: a clear message and exit 1, without touching a real home.
    const status = spawnSync(process.execPath, [file, "status"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: temp.dir, XDG_CONFIG_HOME: join(temp.dir, "config") },
    });
    assert.equal(status.status, 1);
    assert.match(status.stderr, /No server is set up for this command\. Run `usual-mail init` first\./);
  } finally {
    temp.remove();
  }
});

test("the version matches package.json", () => {
  assert.equal(JSON.parse(readFileSync(join(cli, "package.json"), "utf8")).version, VERSION);
});

test("the twelve hats match design/tokens.json", { skip: !existsSync(join(repo, "design/tokens.json")) }, () => {
  const tokens = JSON.parse(readFileSync(join(repo, "design/tokens.json"), "utf8"));
  const fromTokens = Object.entries(tokens.color.hat)
    .filter(([name]) => !name.startsWith("$"))
    .map(([name, hat]) => ({ name, fill: (hat as { fill: { $value: { hex: string } } }).fill.$value.hex.toLowerCase() }));
  assert.deepEqual(HATS, fromTokens);
});

test("a stored colour is shown as the nearest hat, as the design package does", () => {
  for (const hat of HATS) assert.equal(nearestHat(hat.fill).name, hat.name);
  // The sample data's three colours land on orange, blue and green (design.md).
  assert.equal(nearestHat("#C2541D").name, "orange");
  assert.equal(nearestHat("#2F6FED").name, "blue");
  assert.equal(nearestHat("#1F8A5B").name, "green");
  assert.equal(nearestHat("not a colour").name, "slate");
});

test("tables, times and addresses", () => {
  assert.equal(table(["A", "LONGER"], [["xx", "1"], ["y", "22"]]), "A   LONGER\nxx  1\ny   22\n");
  const now = Date.parse("2026-11-16T09:00:00Z");
  assert.equal(fromNow("2026-11-16T09:15:00Z", now), "in 15 minutes");
  assert.equal(fromNow("2026-11-17T09:00:00Z", now), "in 24 hours");
  assert.equal(fromNow("2026-11-16T08:00:00Z", now), "now");
  assert.ok(isLoopback("http://127.0.0.1:8484"));
  assert.ok(isLoopback("http://localhost:8484"));
  assert.ok(isLoopback("http://[::1]:8484"));
  assert.ok(!isLoopback("http://192.168.1.5:8484"));
  assert.ok(!isLoopback("https://mail.example"));
});

test("the owner's code file is read as plain text or as JSON, and a missing one is null", async () => {
  const temp = scratch();
  try {
    const { ctx } = context({ home: temp.dir });
    mkdirSync(join(temp.dir, "a"));
    mkdirSync(join(temp.dir, "b"));
    writeFileSync(join(temp.dir, "a", "owner-pairing-code"), "ABCDE-12345\n");
    writeFileSync(join(temp.dir, "b", "owner-pairing-code"), JSON.stringify({ code: "FGHIJ-67890", expiresAt: "2026-11-17T09:00:00Z" }));
    assert.equal(await readOwnerCode(ctx, join(temp.dir, "a"), 0), "ABCDE-12345");
    assert.equal(await readOwnerCode(ctx, join(temp.dir, "b"), 0), "FGHIJ-67890");
    assert.equal(await readOwnerCode(ctx, join(temp.dir, "none"), 1), null);
  } finally {
    temp.remove();
  }
});
