// The pure pieces and the Node host: matching, state restore, cursors, codes, sealing, the key file, config.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { aesGcmSecrets, FakeModels, MailServer, MemoryEventBus, ProviderRegistry, webRandom } from "../src/index.ts";
import { readConfig } from "../src/node/config.ts";
import { openDatabase } from "../src/node/db.ts";
import { loadSecretKey } from "../src/node/host.ts";
import { firstSyncDays, firstSyncWords, SETTINGS_FILE } from "../src/node/settings.ts";
import { ownerCodeLines, ownerCodePath, readOwnerCode, removeOwnerCode, writeOwnerCode } from "../src/node/owner-code.ts";
import { ManualClock } from "../src/testing/index.ts";
import { normalizeListId, ruleMatches, subjectFor } from "../src/service/match.ts";
import { allowState, applyAction, withGroups, type ThreadState } from "../src/service/state.ts";
import { decodeCursor, encodeCursor, iso, makePairingCode, normalizePairingCode, orderedId } from "../src/util.ts";

describe("rule matching", () => {
  const message = subjectFor({
    from: { email: "Billing@Mail.Stripe.example" },
    to: [{ email: "me@acme.example" }],
    cc: [{ email: "Books@acme.example" }],
    subject: "Your Receipt #42",
    listId: "Stripe Receipts <receipts.stripe.example>",
    automated: true,
  });

  test("every set field must match", () => {
    assert.ok(ruleMatches({ domain: "stripe.example" }, message));
    assert.ok(ruleMatches({ domain: "mail.stripe.example", automated: true }, message));
    assert.ok(!ruleMatches({ domain: "tripe.example" }, message));
    assert.ok(ruleMatches({ from: "billing@mail.stripe.example" }, message));
    assert.ok(ruleMatches({ subjectContains: "receipt" }, message));
    assert.ok(ruleMatches({ to: "books@acme.example" }, message));
    assert.ok(ruleMatches({ listId: "receipts.stripe.example" }, message));
    assert.ok(!ruleMatches({ subjectContains: "receipt", automated: false }, message));
  });

  test("list ids compare without their display name or brackets", () => {
    assert.equal(normalizeListId("Weekly <Weekly-Build.Example>"), "weekly-build.example");
    assert.equal(normalizeListId(" plain.example "), "plain.example");
    assert.equal(normalizeListId(""), null);
  });
});

describe("thread state", () => {
  const base: ThreadState = {
    category: "conversation", categorizedBy: "ai", screened: false, screenedByMailbox: false, summary: "Asks about Friday.",
    done: false, stack: null, comeBackAt: null, comeBackIfNoReply: false, comeBackSetAt: null,
    unread: true, unreadMessageIds: ["m2"], readMessageIds: ["m1"], trashed: false, need: null, reason: null,
  };

  test("restoring unread leaves messages that arrived since alone", () => {
    const read = applyAction(base, { kind: "read" }, 0, "m2");
    assert.deepEqual([read.unread, read.unreadMessageIds], [false, []]);
    const withNew = { ...read, unread: true, unreadMessageIds: ["m3"], readMessageIds: ["m1", "m2"] };
    const restored = withGroups(["unread"], withNew, base);
    assert.deepEqual(new Set(restored.unreadMessageIds), new Set(["m2", "m3"]));
    assert.deepEqual(restored.readMessageIds, ["m1"]);
    assert.equal(restored.unread, true);
  });

  test("restoring touches only the given parts", () => {
    const moved = { ...base, category: "newsletter" as const, done: true };
    assert.deepEqual(withGroups(["category"], moved, base), { ...moved, category: "conversation" });
  });

  test("a one-time code stops being screened and loses its summary; restoring the category brings the summary back", () => {
    const screened = { ...base, category: "unknown" as const, screened: true };
    const code = applyAction(screened, { kind: "categorize", category: "otp" }, 0, null);
    assert.deepEqual([code.category, code.screened, code.summary], ["otp", false, null]);
    const back = withGroups(["category", "screened"], code, screened);
    assert.deepEqual([back.category, back.screened, back.summary], ["unknown", true, "Asks about Friday."]);
    const other = applyAction(screened, { kind: "categorize", category: "invoice" }, 0, null);
    assert.deepEqual([other.category, other.screened, other.summary], ["invoice", true, "Asks about Friday."], "any other category keeps the gate");
  });

  test("a filing under Screening at the mailbox holds even a one-time code; letting the sender in lifts any screening", () => {
    const filed = { ...base, category: "unknown" as const, screened: true, screenedByMailbox: true };
    const code = applyAction(filed, { kind: "categorize", category: "otp" }, 0, null);
    assert.deepEqual([code.category, code.screened], ["otp", true]);
    assert.deepEqual([allowState(filed).screened, allowState(filed).screenedByMailbox], [false, false]);
  });
});

describe("helpers", () => {
  test("cursors round-trip and reject anything else", () => {
    assert.deepEqual(decodeCursor(encodeCursor({ at: 1_700_000_000_000, tie: "thr_x" })), { at: 1_700_000_000_000, tie: "thr_x" });
    assert.throws(() => decodeCursor("nope"), /cursor/);
    assert.throws(() => decodeCursor(encodeCursor({ at: 1, tie: 2 }).slice(0, -2)), /cursor/);
  });

  test("times are whole-second UTC like the sample", () => {
    assert.equal(iso(Date.parse("2026-11-16T09:30:00.789Z")), "2026-11-16T09:30:00Z");
  });

  test("ids sort in the order they were made, by time and then by a counter within the millisecond", () => {
    const made = [
      orderedId(webRandom, "act", 1_794_000_000_000, 0),
      orderedId(webRandom, "act", 1_794_000_000_000, 1),
      orderedId(webRandom, "act", 1_794_000_000_000, 31),
      orderedId(webRandom, "act", 1_794_000_000_000, 32),
      orderedId(webRandom, "act", 1_794_000_000_001, 0),
      orderedId(webRandom, "act", 4_102_444_800_000, 0),
    ];
    assert.deepEqual([...made].sort(), made);
    for (const id of made) assert.match(id, /^act_[0-9a-hjkmnp-tv-z]{22}$/);
  });

  test("pairing codes are typed loosely", () => {
    const code = makePairingCode(webRandom);
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(normalizePairingCode(code.toLowerCase().replace("-", " ")), code);
    assert.equal(normalizePairingCode("abco-1il0"), "ABC0-1110");
  });
});

describe("secrets", () => {
  test("credentials are sealed with AES-GCM and bound to their inbox", async () => {
    const secrets = await aesGcmSecrets(webRandom.bytes(32), webRandom);
    const sealed = await secrets.seal('{"password":"hunter2"}', "inb_a");
    assert.ok(!sealed.includes("hunter2"));
    assert.notEqual(await secrets.seal('{"password":"hunter2"}', "inb_a"), sealed);
    assert.equal(await secrets.open(sealed, "inb_a"), '{"password":"hunter2"}');
    await assert.rejects(secrets.open(sealed, "inb_b"), /can't be opened/);
    const other = await aesGcmSecrets(webRandom.bytes(32), webRandom);
    await assert.rejects(other.open(sealed, "inb_a"), /can't be opened/);
  });

  test("the key file is created once, readable only by its owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usual-mail-key-"));
    try {
      const key = await loadSecretKey(dir, null, webRandom);
      assert.equal(key.length, 32);
      assert.equal((await stat(join(dir, "secret.key"))).mode & 0o777, 0o600);
      assert.deepEqual(await loadSecretKey(dir, null, webRandom), key);
      const fromEnv = await loadSecretKey(dir, Buffer.alloc(32, 7).toString("base64"), webRandom);
      assert.deepEqual([...fromEnv], new Array(32).fill(7));
      assert.ok((await readFile(join(dir, "secret.key"), "utf8")).trim().length > 40);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("the owner's pairing code", () => {
  test("the file holds the code and a newline, readable only by the owner, and goes away when removed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usual-mail-owner-"));
    try {
      await writeOwnerCode(dir, "ABCD-EFGH");
      assert.equal(await readFile(ownerCodePath(dir), "utf8"), "ABCD-EFGH\n");
      assert.equal((await stat(ownerCodePath(dir))).mode & 0o777, 0o600);
      await writeOwnerCode(dir, "JKMN-PQRS");
      assert.equal(await readFile(ownerCodePath(dir), "utf8"), "JKMN-PQRS\n");
      await removeOwnerCode(dir);
      await assert.rejects(stat(ownerCodePath(dir)), /ENOENT/);
      await removeOwnerCode(dir);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("the code is printed when it is made; at a later start the log says where it waits, without the code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usual-mail-owner-"));
    try {
      assert.equal(await readOwnerCode(dir), null, "no file: nothing kept from before");
      await writeOwnerCode(dir, "ABCD-EFGH");
      assert.equal(await readOwnerCode(dir), "ABCD-EFGH", "what a later start hands the service to keep");
      const code = { code: "ABCD-EFGH", expiresAt: "2026-11-18T09:30:00Z" };
      const made = ownerCodeLines(code, true, ownerCodePath(dir)).join("\n");
      assert.match(made, /ABCD-EFGH/);
      assert.match(made, /until 2026-11-18T09:30:00Z/);
      const kept = ownerCodeLines(code, false, ownerCodePath(dir)).join("\n");
      assert.doesNotMatch(kept, /ABCD|EFGH/, "never printed again");
      assert.match(kept, /waiting/);
      assert.ok(kept.includes(ownerCodePath(dir)), "it says where the file is");
      assert.match(kept, /until 2026-11-18T09:30:00Z/);
      assert.deepEqual(ownerCodeLines(null, false, ownerCodePath(dir)), []);
      // Demo mode writes no file, and its fresh store makes a new code at every start.
      assert.match(ownerCodeLines(code, true, null).join("\n"), /ABCD-EFGH/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("only the newest owner code works; while one is kept, pairing a person ends it and the listener hears null", async () => {
    const store = await openDatabase(":memory:");
    const clock = new ManualClock("2026-11-16T09:30:00Z");
    const server = await MailServer.create({
      db: store.db,
      clock,
      scheduler: clock,
      random: webRandom,
      events: new MemoryEventBus(),
      secrets: await aesGcmSecrets(webRandom.bytes(32), webRandom),
      log: { info: () => {}, error: () => {} },
    }, { providers: new ProviderRegistry(), models: new FakeModels() });
    const heard: Array<string | null> = [];
    const older = (await server.ownerPairingCode())!;
    await server.keepOwnerCode((code) => heard.push(code?.code ?? null));
    const newer = heard[0]!;
    assert.equal(older.expiresAt, "2026-11-17T09:30:00Z");
    await assert.rejects(server.pair({ code: older.code, name: "Old" }), /wrong, used or expired/);
    const { token } = await server.pair({ code: newer, name: "Mac" });
    const person = (await server.authenticate(token))!;
    const second = await server.createPairingCode(person, { kind: "person" });
    await server.pair({ code: second.code, name: "iPhone" });
    assert.deepEqual(heard, [newer, null]);
    assert.equal(await server.ownerPairingCode(), null);
    await server.stop();
    store.close();
  });
});

describe("the first sync's days", () => {
  test("USUAL_MAIL_SYNC_DAYS wins; else the data directory's settings.json, which init and sync-days write; else 30", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usual-mail-settings-"));
    try {
      assert.deepEqual(await firstSyncDays(null, dir), { days: 30, from: "default" });
      await writeFile(join(dir, SETTINGS_FILE), JSON.stringify({ syncDays: 7 }));
      assert.deepEqual(await firstSyncDays(null, dir), { days: 7, from: "settings" });
      assert.deepEqual(await firstSyncDays(14, dir), { days: 14, from: "environment" });
      assert.deepEqual(await firstSyncDays(null, null), { days: 30, from: "default" }, "demo mode reads no file");
      assert.match(firstSyncWords(await firstSyncDays(null, dir), dir), /last 7 days of mail .*settings\.json/);
      assert.match(firstSyncWords({ days: 14, from: "environment" }, dir), /last 14 days of mail .*USUAL_MAIL_SYNC_DAYS/);
      await writeFile(join(dir, SETTINGS_FILE), JSON.stringify({ syncDays: 0 }));
      await assert.rejects(firstSyncDays(null, dir), /syncDays .*whole number from 1/);
      await writeFile(join(dir, SETTINGS_FILE), "{ not json");
      await assert.rejects(firstSyncDays(null, dir), /settings\.json isn't valid JSON/);
      await writeFile(join(dir, SETTINGS_FILE), JSON.stringify({ }));
      assert.deepEqual(await firstSyncDays(null, dir), { days: 30, from: "default" }, "a file without the setting");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("config", () => {
  test("flags win over the environment; defaults bind to localhost", () => {
    const defaults = readConfig([], {});
    // The first sync's days come from USUAL_MAIL_SYNC_DAYS when it is set, else from the data directory's settings.
    assert.deepEqual([defaults.host, defaults.port, defaults.demo, defaults.pollIntervalMs, defaults.syncWindowDays], ["127.0.0.1", 8484, false, 60_000, null]);
    assert.equal(readConfig([], { USUAL_MAIL_SYNC_DAYS: "7" }).syncWindowDays, 7);
    assert.equal(readConfig([], { USUAL_MAIL_SYNC_DAYS: "" }).syncWindowDays, null, "set but empty is unset");
    assert.throws(() => readConfig([], { USUAL_MAIL_SYNC_DAYS: "0" }), /USUAL_MAIL_SYNC_DAYS/);
    const set = readConfig(["--port", "9000", "--data-dir", "/tmp/um", "--demo"], { USUAL_MAIL_PORT: "1", USUAL_MAIL_HOST: "0.0.0.0", USUAL_MAIL_POLL_SECONDS: "30" });
    assert.deepEqual([set.port, set.dataDir, set.host, set.demo, set.pollIntervalMs], [9000, "/tmp/um", "0.0.0.0", true, 30_000]);
    assert.throws(() => readConfig(["--port", "x"], {}), /port/);
    assert.throws(() => readConfig(["--nope"], {}));
  });

  test("the development-only fake AI needs this machine's address and never runs in production", () => {
    assert.equal(readConfig([], {}).devFakeAi, false);
    assert.equal(readConfig(["--dev-fake-ai"], {}).devFakeAi, true);
    assert.equal(readConfig(["--dev-fake-ai", "--host", "::1"], {}).devFakeAi, true);
    assert.throws(() => readConfig(["--dev-fake-ai", "--host", "0.0.0.0"], {}), /this machine only/);
    assert.throws(() => readConfig(["--dev-fake-ai"], { USUAL_MAIL_HOST: "192.168.1.5" }), /this machine only/);
    assert.throws(() => readConfig(["--dev-fake-ai"], { NODE_ENV: "production" }), /production/);
  });
});
