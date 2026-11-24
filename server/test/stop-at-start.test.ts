// A stop asked for while the server starts (Node's host: SIGTERM or SIGINT during start-up, as `docker stop` sends
// to a container that is still starting). The process hears it from the start, before the rest of its code loads,
// since in a container Node is PID 1 and ignores a signal it has no handler for. It ends without listening, and a
// start whose stop was asked for starts no sync, so the stop after it has nothing in hand.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MailProvider } from "@usualmail/core";
import { aesGcmSecrets, FakeModels, MailServer, MemoryEventBus, ProviderRegistry, webRandom, type Host } from "../src/index.ts";
import { openDatabase } from "../src/node/db.ts";
import { ManualClock, MemoryMailbox, memoryFactory } from "../src/testing/index.ts";
import { at, HOUR, historyFromKnown, KNOWN, START } from "./helpers.ts";

const MAIN = fileURLToPath(new URL("../src/node/main.ts", import.meta.url));

/**
 * Loaded before the server (`--import`): as soon as anything listens for SIGTERM, the process sends itself one, which
 * arrives a moment later, while the server is still starting.
 */
const SIGTERM_AT_ONCE = `
const on = process.on.bind(process);
let sent = false;
process.on = (event, listener) => {
  on(event, listener);
  if (event === "SIGTERM" && !sent) {
    sent = true;
    setImmediate(() => process.kill(process.pid, "SIGTERM"));
  }
  return process;
};
`;

test("SIGTERM during start-up ends the server cleanly before it listens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usual-mail-stop-at-start-"));
  try {
    const preload = join(dir, "sigterm-at-once.mjs");
    writeFileSync(preload, SIGTERM_AT_ONCE);
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { mode: 0o700 });
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(preload).href, MAIN, "--data-dir", dataDir, "--port", "0", "--host", "127.0.0.1"],
      { env: { PATH: process.env.PATH, HOME: dir }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
    );
    clearTimeout(timer);
    assert.equal(signal, null, output);
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /Usual Mail server .* on http/, "it never listened");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a start whose stop was asked for meanwhile starts no sync, and a start without one does", async () => {
  const store = await openDatabase(":memory:");
  const clock = new ManualClock(START);
  const mailboxes = new Map<string, MemoryMailbox>();
  const mailbox = new MemoryMailbox({ address: "me@acme.example", now: () => clock.now() });
  mailboxes.set(mailbox.address, mailbox);
  mailbox.deliver(historyFromKnown);
  const providers = new ProviderRegistry();
  const memory = memoryFactory(mailboxes);
  let syncs = 0;
  providers.register("imap", (credentials, options) => {
    const provider = memory(credentials, options) as MailProvider;
    const sync = provider.sync.bind(provider);
    provider.sync = (cursor, syncOptions) => {
      syncs++;
      return sync(cursor, syncOptions);
    };
    return provider;
  });
  const host = async (): Promise<Host> => ({
    db: store.db, clock, scheduler: clock, random: webRandom, events: new MemoryEventBus(),
    secrets: await aesGcmSecrets(new Uint8Array(32).fill(7), webRandom), log: { info: () => {}, error: () => {} },
  });
  const first = await MailServer.create(await host(), { providers, models: new FakeModels() });
  await first.start();
  const person = (await first.authenticate((await first.pair({ code: (await first.ownerPairingCode())!.code, name: "Mac" })).token))!;
  const inbox = await first.connectInbox(person, { name: "Acme", color: "#000000", provider: "imap", credentials: { mailbox: mailbox.address } });
  await first.syncInbox(person, inbox.id);
  await first.whenIdle();
  await first.stop();
  mailbox.deliver({ from: KNOWN, subject: "While stopped", date: at(-HOUR) });

  // The next process is asked to stop while it starts: its first step waits for the store.
  const second = await MailServer.create(await host(), { providers, models: new FakeModels() });
  syncs = 0;
  const asked = new AbortController();
  const starting = second.start({ signal: asked.signal });
  asked.abort();
  await starting;
  await second.whenIdle();
  clock.advance(2 * HOUR);
  await second.whenIdle();
  await second.stop();
  assert.equal(syncs, 0, "no sync started");
  assert.equal((await second.search(person, { q: "While stopped" })).items.length, 0);

  const third = await MailServer.create(await host(), { providers, models: new FakeModels() });
  await third.start();
  await third.whenIdle();
  assert.ok(syncs > 0, "a start without a stop syncs");
  assert.equal((await third.search(person, { q: "While stopped" })).items.length, 1);
  await third.stop();
  store.close();
});
