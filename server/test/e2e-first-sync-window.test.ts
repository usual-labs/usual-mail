// End to end with the real providers: a first sync in progress when the window is made smaller. Either the server is
// stopped mid-sync (here the first one fails after its first batch, as a stop would leave it) and started again on the
// same store with fewer days, or a person sets fewer days while it runs (`PATCH /v1/first-sync`, since 2026-11-18):
// mail older than the new window is no longer fetched, and what was fetched stays. Against mail's fake of Gmail's API
// and against an IMAP server in this process.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MailProvider, ProviderFactory, ProviderKind } from "@usualmail/core";
import { createGmailProvider } from "@usualmail/mail";
import { FakeGmail } from "@usualmail/mail/testing";
import { aesGcmSecrets, FakeModels, MailServer, MemoryEventBus, ProviderRegistry, webRandom, type Host } from "../src/index.ts";
import { openDatabase } from "../src/node/db.ts";
import { parts } from "../src/node/parts.ts";
import { ManualClock } from "../src/testing/index.ts";
import { rawMail, startMailHost } from "./e2e/imap-server.ts";

const DAY = 24 * 60 * 60_000;
const AGES = [25, 10, 5, 2, 1];

/**
 * The real provider, one message a batch so the first sync spans calls, and the sync failing from its second call
 * while `failAfterOne` is set: the first batch is stored, the rest waits, as when the server stops in the middle.
 */
function oneAtATime(factory: ProviderFactory, failAfterOne: boolean): ProviderFactory {
  return (credentials, options) => {
    const provider: MailProvider = factory(credentials, options);
    const sync = provider.sync.bind(provider);
    let calls = 0;
    provider.sync = async (cursor) => {
      if (failAfterOne && ++calls > 1) throw new Error("The connection dropped");
      return sync(cursor, { limit: 1 });
    };
    return provider;
  };
}

async function scenario(kind: ProviderKind, factory: ProviderFactory, credentials: unknown): Promise<void> {
  const store = await openDatabase(":memory:");
  const clock = new ManualClock(Math.floor(Date.now() / 1000) * 1000);
  const errors: string[] = [];
  const secrets = await aesGcmSecrets(webRandom.bytes(32), webRandom);
  const host = (): Host => ({
    db: store.db, clock, scheduler: clock, random: webRandom, events: new MemoryEventBus(), secrets,
    log: { info: () => {}, error: (message) => errors.push(message) },
  });
  const now: { running: MailServer | null } = { running: null };
  const start = async (syncWindowDays: number, failAfterOne: boolean) => {
    await now.running?.stop();
    const providers = new ProviderRegistry();
    providers.register(kind, oneAtATime(factory, failAfterOne));
    const server = await MailServer.create(host(), { providers, models: new FakeModels(), syncWindowDays, pollIntervalMs: 3_600_000 });
    now.running = server;
    await server.start();
    return server;
  };
  try {
    await steps(start, errors, kind, credentials);
  } finally {
    // Stopped also when a check fails, so its connections don't keep the test running.
    await now.running?.stop();
    store.close();
  }
}

async function steps(
  start: (days: number, failAfterOne: boolean) => Promise<MailServer>,
  errors: string[],
  kind: ProviderKind,
  credentials: unknown,
): Promise<void> {
  const subjects = async (server: MailServer, person: Awaited<ReturnType<MailServer["authenticate"]>>) =>
    (await server.search(person!, { q: "days old", limit: 200 })).items.map((thread) => thread.subject).sort();

  // Connected with 30 days; the first sync stops after its first batch.
  const first = await start(30, true);
  const person = await first.authenticate((await first.pair({ code: (await first.ownerPairingCode())!.code, name: "Mac" })).token);
  const inbox = await first.connectInbox(person!, { name: "Mail", color: "#2F6FED", provider: kind, credentials });
  await first.whenIdle();
  assert.deepEqual(await subjects(first, person), ["1 days old"]);
  assert.equal((await first.listInboxes(person!))[0]!.status, "needs_attention", "the first sync is still in progress");

  // Started again with 7 days: the first sync goes on inside the new window only. What it had stays.
  const second = await start(7, false);
  await second.syncInbox(person!, inbox.id);
  await second.whenIdle();
  assert.deepEqual(await subjects(second, person), ["1 days old", "2 days old", "5 days old"], "nothing older than 7 days was fetched");
  assert.equal((await second.listInboxes(person!))[0]!.status, "ok");

  // Raised to 60 later: an inbox already connected keeps what its first sync took.
  const third = await start(60, false);
  await third.syncInbox(person!, inbox.id);
  await third.whenIdle();
  assert.deepEqual(await subjects(third, person), ["1 days old", "2 days old", "5 days old"]);
  assert.deepEqual(errors.filter((line) => !line.includes("The connection dropped") && !line.includes("Watching")), []);
}

/** The same, with the window made smaller by a person while the server runs: no restart. */
async function whileRunning(kind: ProviderKind, factory: ProviderFactory, credentials: unknown): Promise<void> {
  const store = await openDatabase(":memory:");
  const clock = new ManualClock(Math.floor(Date.now() / 1000) * 1000);
  const errors: string[] = [];
  const flaky = { fail: true };
  const providers = new ProviderRegistry();
  providers.register(kind, (given, options) => {
    const provider: MailProvider = factory(given, options);
    const sync = provider.sync.bind(provider);
    let calls = 0;
    provider.sync = async (cursor) => {
      if (flaky.fail && ++calls > 1) throw new Error("The connection dropped");
      return sync(cursor, { limit: 1 });
    };
    return provider;
  });
  const host: Host = {
    db: store.db, clock, scheduler: clock, random: webRandom, events: new MemoryEventBus(), secrets: await aesGcmSecrets(webRandom.bytes(32), webRandom),
    log: { info: () => {}, error: (message) => errors.push(message) },
  };
  const kept: number[] = [];
  const server = await MailServer.create(host, {
    providers, models: new FakeModels(), syncWindowDays: 30, syncWindowSetBy: "settings", pollIntervalMs: 3_600_000,
    saveSyncWindowDays: async (days) => void kept.push(days),
  });
  await server.start();
  try {
    const person = (await server.authenticate((await server.pair({ code: (await server.ownerPairingCode())!.code, name: "Mac" })).token))!;
    const subjects = async () => (await server.search(person, { q: "days old", limit: 200 })).items.map((thread) => thread.subject).sort();
    const inbox = await server.connectInbox(person, { name: "Mail", color: "#2F6FED", provider: kind, credentials });
    await server.whenIdle();
    assert.deepEqual(await subjects(), ["1 days old"], "the first sync stopped after its first batch");

    await server.updateFirstSyncWindow(person, { days: 7 });
    flaky.fail = false;
    await server.syncInbox(person, inbox.id);
    await server.whenIdle();
    assert.deepEqual(await subjects(), ["1 days old", "2 days old", "5 days old"], "nothing older than 7 days was fetched");
    assert.equal((await server.listInboxes(person))[0]!.status, "ok");

    await server.updateFirstSyncWindow(person, { days: 60 });
    await server.syncInbox(person, inbox.id);
    await server.whenIdle();
    assert.deepEqual(await subjects(), ["1 days old", "2 days old", "5 days old"], "a larger window fetches nothing more");
    assert.deepEqual(kept, [7, 60]);
    assert.deepEqual(errors.filter((line) => !line.includes("The connection dropped") && !line.includes("Watching")), []);
  } finally {
    await server.stop();
    store.close();
  }
}

describe("a first sync in progress when the window is made smaller", () => {
  test("Gmail: mail older than the new window is no longer fetched; what was fetched stays", async () => {
    const fake = new FakeGmail({ address: "me@gmail.example" });
    const now = Date.now();
    for (const days of AGES) {
      await fake.deliver(rawMail({ from: "Bo <bo@people.example>", to: "me@gmail.example", subject: `${days} days old`, messageId: `gmail-${days}@e2e.example`, date: new Date(now - days * DAY) }), ["INBOX"], now - days * DAY);
    }
    const gmail: ProviderFactory = (credentials, options) => createGmailProvider(credentials, { ...options, fetch: fake.fetch, quotaPerSecond: 1_000_000 });
    await scenario("gmail", gmail, fake.credentials);
    const fetched = fake.requests.filter((r) => r.method === "GET" && r.query.get("format") === "raw").length;
    assert.equal(fetched, 3, "only the three messages inside seven days were ever downloaded");
  });

  test("Gmail, made smaller by a person while the server runs: the same, with no restart", async () => {
    const fake = new FakeGmail({ address: "me@gmail.example" });
    const now = Date.now();
    for (const days of AGES) {
      await fake.deliver(rawMail({ from: "Bo <bo@people.example>", to: "me@gmail.example", subject: `${days} days old`, messageId: `gmail-run-${days}@e2e.example`, date: new Date(now - days * DAY) }), ["INBOX"], now - days * DAY);
    }
    const gmail: ProviderFactory = (credentials, options) => createGmailProvider(credentials, { ...options, fetch: fake.fetch, quotaPerSecond: 1_000_000 });
    await whileRunning("gmail", gmail, fake.credentials);
    const fetched = fake.requests.filter((r) => r.method === "GET" && r.query.get("format") === "raw").length;
    assert.equal(fetched, 3, "only the three messages inside seven days were ever downloaded");
  });

  test("IMAP, made smaller by a person while the server runs: the same, with no restart", async () => {
    const mail = await startMailHost();
    try {
      const now = Date.now();
      for (const days of AGES) {
        mail.append("INBOX", rawMail({ from: "Bo <bo@people.example>", subject: `${days} days old`, messageId: `imap-run-${days}@e2e.example`, date: new Date(now - days * DAY) }), ["\\Seen"], new Date(now - days * DAY));
      }
      await whileRunning("imap", parts.providers.imap!, mail.credentials());
    } finally {
      await mail.close();
    }
  });

  test("IMAP: mail older than the new window is no longer fetched; what was fetched stays", async () => {
    const mail = await startMailHost();
    try {
      const now = Date.now();
      for (const days of AGES) {
        mail.append("INBOX", rawMail({ from: "Bo <bo@people.example>", subject: `${days} days old`, messageId: `imap-${days}@e2e.example`, date: new Date(now - days * DAY) }), ["\\Seen"], new Date(now - days * DAY));
      }
      await scenario("imap", parts.providers.imap!, mail.credentials());
    } finally {
      await mail.close();
    }
  });
});
