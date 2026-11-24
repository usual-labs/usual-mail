// Inbox versions, changing credentials, removing an inbox (positions close the gap), `me`, `Retry-After`, the owner's
// code whenever no person's device is paired, brief subjects, and upgrading a store from the second revision.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { ServiceError, type MailEvent, type PairingCode } from "@usualmail/core";
import { aesGcmSecrets, FakeModels, MailServer, MemoryEventBus, ProviderRegistry, webRandom } from "../src/index.ts";
import { openDatabase } from "../src/node/db.ts";
import { createApp } from "../src/rest/app.ts";
import { ManualClock, MemoryMailbox, memoryFactory } from "../src/testing/index.ts";
import { at, DAY, HOUR, historyFromKnown, KNOWN, listen, makeServer, START, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => (t = await makeServer()));
afterEach(async () => t.close());

const code = (error: unknown) => (error instanceof ServiceError ? error.code : String(error));
const inboxEvents = (events: MailEvent[]) => events.flatMap((e) => (e.type === "inbox.changed" ? [[e.inbox.version, e.inbox.status]] : []));

describe("inbox versions", () => {
  test("every change raises the version and sends inbox.changed; a sync that only moves lastSyncedAt does neither", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const synced = (await t.server.listInboxes(t.person))[0]!;
    assert.equal(inbox.version, 1);
    assert.deepEqual([synced.version, synced.status], [2, "ok"], "connecting became ok");

    const heard = listen(t);
    t.clock.advance(HOUR);
    await t.sync(inbox);
    assert.deepEqual(inboxEvents(heard.events), []);
    const later = (await t.server.listInboxes(t.person))[0]!;
    assert.deepEqual([later.version, later.lastSyncedAt], [2, at(HOUR).replace(".000Z", "Z")]);

    assert.equal((await t.server.updateInbox(t.person, inbox.id, { name: "Acme" })).version, 3);
    assert.equal((await t.server.updateInbox(t.person, inbox.id, { name: "Acme" })).version, 3, "a patch that changes nothing");
    mailbox.failSync = "Connection refused";
    await t.sync(inbox);
    mailbox.failSync = null;
    await t.sync(inbox);
    heard.stop();
    assert.deepEqual(inboxEvents(heard.events), [[3, "ok"], [4, "needs_attention"], [5, "ok"]]);
  });
});

describe("changing credentials", () => {
  let password = "right";
  beforeEach(() => {
    password = "right";
  });

  /** An IMAP stand-in whose login takes only the current password, for the address in the credentials. */
  async function passwordInbox() {
    t.providers.register("imap", (credentials) => {
      const creds = credentials as { mailbox: string; password: string };
      const mailbox = t.mailboxes.get(creds.mailbox) ?? new MemoryMailbox({ address: creds.mailbox, now: () => t.clock.now() });
      const provider = mailbox.provider();
      // The password is checked on every call, as a mail server would after the password changed.
      const check = () => {
        if (creds.password !== password) throw new Error("The mail server refused the password");
      };
      const [verify, sync] = [provider.verify.bind(provider), provider.sync.bind(provider)];
      provider.verify = async () => (check(), verify());
      provider.sync = async (cursor, options) => (check(), sync(cursor, options));
      return provider;
    });
    const mailbox = new MemoryMailbox({ address: "me@acme.example", now: () => t.clock.now() });
    t.mailboxes.set(mailbox.address, mailbox);
    mailbox.deliver(historyFromKnown);
    const inbox = await t.server.connectInbox(t.person, { name: "Acme", color: "#000000", provider: "imap", credentials: { mailbox: mailbox.address, password } });
    await t.sync(inbox);
    return { inbox, mailbox };
  }

  test("only a person may; refused or for another address, nothing in the patch changes", async () => {
    const { inbox } = await passwordInbox();
    await t.server.updateInbox(t.person, inbox.id, { agentAccess: true });
    const agent = await t.agent([inbox.id]);
    await assert.rejects(t.server.updateInbox(agent.caller, inbox.id, { credentials: { mailbox: inbox.address, password: "right" } }), (e) => code(e) === "needs_person");
    const before = (await t.server.listInboxes(t.person))[0]!;

    await assert.rejects(
      t.server.updateInbox(t.person, inbox.id, { name: "Renamed", credentials: { mailbox: inbox.address, password: "wrong" } }),
      (e) => code(e) === "provider_error" && /refused the password/.test((e as Error).message),
    );
    await assert.rejects(
      t.server.updateInbox(t.person, inbox.id, { name: "Renamed", credentials: { mailbox: "other@acme.example", password: "right" } }),
      (e) => code(e) === "invalid" && /other@acme\.example/.test((e as Error).message),
    );
    assert.deepEqual((await t.server.listInboxes(t.person))[0], before);
  });

  test("new credentials that work leave needs_attention and sync again with them; a paused inbox stays paused", async () => {
    const { inbox, mailbox } = await passwordInbox();
    password = "changed";
    await t.sync(inbox);
    const failing = (await t.server.listInboxes(t.person))[0]!;
    assert.deepEqual([failing.status, failing.statusDetail], ["needs_attention", "The mail server refused the password"]);

    mailbox.deliver({ from: KNOWN, subject: "Arrived meanwhile", date: at(-HOUR) });
    const changed = await t.server.updateInbox(t.person, inbox.id, { credentials: { mailbox: inbox.address, password: "changed" } });
    assert.deepEqual([changed.status, changed.statusDetail, changed.version], ["connecting", undefined, failing.version + 1]);
    await t.server.whenIdle();
    const healthy = (await t.server.listInboxes(t.person))[0]!;
    assert.deepEqual([healthy.status, healthy.statusDetail], ["ok", undefined]);
    const arrived = await t.threadBySubject("Arrived meanwhile");
    assert.deepEqual([arrived.category, arrived.screened], ["unknown", false], "history and its let-in senders kept, new mail synced");

    await t.server.updateInbox(t.person, inbox.id, { paused: true });
    password = "again";
    const paused = await t.server.updateInbox(t.person, inbox.id, { credentials: { mailbox: inbox.address, password: "again" } });
    assert.equal(paused.status, "paused");
  });
});

describe("removing an inbox", () => {
  test("deletes the server's copy, ends agents' access, drops it from briefs, closes the gap and changes nothing at the provider", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const other = (await t.connect({ address: "other@acme.example", agentAccess: true, history: [historyFromKnown] })).inbox;
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Kept at the provider", date: at(-HOUR) });
    await t.server.createRule(t.person, { inboxId: inbox.id, text: "X", match: { domain: "x.example" }, then: [{ kind: "done" }] });
    await t.server.updateInbox(t.person, inbox.id, { guide: "Clients first." });
    const agent = await t.agent([inbox.id, other.id]);
    await t.server.saveDraft(agent.caller, { inboxId: inbox.id, threadId: thread.id, to: [KNOWN], subject: "Re", body: "Draft" });
    await t.server.writeBrief(agent.caller, { from: at(-DAY), to: at(HOUR), sections: [{ inboxId: inbox.id, highlights: [] }, { inboxId: other.id, highlights: [] }] });
    await t.server.whenIdle();
    const written = mailbox.applied.length;

    const otherBefore = (await t.server.listInboxes(t.person)).find((i) => i.id === other.id)!;
    assert.deepEqual([inbox.position, otherBefore.position], [0, 1]);
    const heard = listen(t, agent.caller);
    await t.server.removeInbox(t.person, inbox.id);
    heard.stop();
    // The other inbox moves up: its position closes the gap, with a new version and inbox.changed.
    assert.deepEqual(heard.events.map((e) => e.type), ["inbox.changed", "inbox.removed"]);
    const moved = heard.events[0]!.type === "inbox.changed" ? heard.events[0]!.inbox : undefined;
    assert.deepEqual([moved?.id, moved?.position, moved?.version], [other.id, 0, otherBefore.version + 1]);
    assert.equal(mailbox.applied.length, written, "nothing was written to the mailbox");
    assert.ok(mailbox.messages().some((m) => m.subject === "Kept at the provider"));
    assert.deepEqual((await t.server.me(agent.caller)).inboxIds, [other.id]);
    assert.deepEqual((await t.server.listInboxes(t.person)).map((i) => [i.id, i.position]), [[other.id, 0]]);
    assert.deepEqual((await t.server.listDrafts(t.person, {})).items, []);
    assert.deepEqual((await t.server.latestBrief(t.person))!.sections.map((s) => s.inboxId), [other.id]);
    await assert.rejects(t.server.listRules(t.person, inbox.id), (e) => code(e) === "not_found");
  });
});

describe("pairing", () => {
  test("GET /v1/me names the token's device, a person's or an agent's", async () => {
    const app = createApp(t.server, { scheduler: t.clock, log: t.host.log });
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const agent = await t.agent([inbox.id], "Claude Code");
    const me = async (token: string) => (await app.request("/v1/me", { headers: { authorization: `Bearer ${token}` } })).json() as Promise<{ name: string; kind: string; inboxIds?: string[] }>;
    assert.deepEqual([(await me(t.personToken)).name, (await me(t.personToken)).kind], ["Test Mac", "person"]);
    assert.deepEqual([(await me(agent.token)).name, (await me(agent.token)).kind, (await me(agent.token)).inboxIds], ["Claude Code", "agent", [inbox.id]]);
  });

  test("rate_limited carries Retry-After with the whole seconds to wait", async () => {
    const app = createApp(t.server, { scheduler: t.clock, log: t.host.log });
    const pair = () => app.request("/v1/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "WRNG-0000", name: "Guess" }) });
    for (let i = 0; i < 10; i++) assert.equal((await pair()).status, 401);
    t.clock.advance(90_500);
    const limited = await pair();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "510");
    assert.match(((await limited.json()) as { error: { message: string } }).error.message, /510 seconds/);
  });

  test("a new owner's code whenever no person's device is paired: when it expires unused and when the last one goes", async () => {
    const store = await openDatabase(":memory:");
    const clock = new ManualClock(START);
    const server = await MailServer.create({
      db: store.db, clock, scheduler: clock, random: webRandom, events: new MemoryEventBus(),
      secrets: await aesGcmSecrets(webRandom.bytes(32), webRandom), log: { info: () => {}, error: () => {} },
    }, { providers: new ProviderRegistry(), models: new FakeModels() });
    const heard: Array<PairingCode | null> = [];
    await server.keepOwnerCode((code) => heard.push(code));
    assert.equal(heard.length, 1);
    clock.advance(DAY);
    // The new code is made in the background: wait for it (up to a second of real time) rather than a fixed moment.
    for (let i = 0; i < 100 && heard.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(heard.length, 2, "expired unused: a new one");
    await assert.rejects(server.pair({ code: heard[0]!.code, name: "Late" }), (e) => code(e) === "unauthorized");

    const { token, device } = await server.pair({ code: heard[1]!.code, name: "Mac" });
    assert.equal(heard[2], null, "used: the listener hears null");
    const person = (await server.authenticate(token))!;
    await server.revokeDevice(person, device.id);
    assert.equal(heard.length, 4);
    const fresh = heard[3]!;
    assert.equal(fresh.expiresAt, new Date(clock.now() + DAY).toISOString().replace(".000Z", "Z"));
    assert.equal((await server.pair({ code: fresh.code, name: "Mac again" })).device.kind, "person");
    await server.stop();
    store.close();
  });

  test("a later start keeps the owner's code its host still holds, and says it was made before, so it isn't printed again", async () => {
    const store = await openDatabase(":memory:");
    const clock = new ManualClock(START);
    const host = async () => ({
      db: store.db, clock, scheduler: clock, random: webRandom, events: new MemoryEventBus(),
      secrets: await aesGcmSecrets(webRandom.bytes(32), webRandom), log: { info: () => {}, error: () => {} },
    });
    const start = async () => {
      const server = await MailServer.create(await host(), { providers: new ProviderRegistry(), models: new FakeModels() });
      await server.start();
      return server;
    };
    const heard: Array<{ code: string | null; made: boolean; expiresAt?: string }> = [];
    const listener = (code: PairingCode | null, made: boolean) => heard.push({ code: code?.code ?? null, made, ...(code && { expiresAt: code.expiresAt }) });

    const first = await start();
    await first.keepOwnerCode(listener);
    const made = heard[0]!;
    assert.equal(made.made, true, "the first start makes the code: the host prints it");
    await first.stop();

    // The next start, an hour on, while the code is still valid: the host passes the code from its file.
    clock.advance(HOUR);
    const second = await start();
    await second.keepOwnerCode(listener, { kept: made.code! });
    assert.deepEqual(heard[1], { code: made.code, made: false, expiresAt: made.expiresAt }, "kept, not made again: the host doesn't print it");
    // It still expires when it would have, and the next one is made (and printed) then.
    clock.advance(DAY - HOUR);
    for (let i = 0; i < 100 && heard.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(heard[2]?.made, true);
    assert.notEqual(heard[2]?.code, made.code);
    await second.stop();

    // A code the host holds that is no longer valid (expired, used, or another one) isn't kept: a new one is made.
    const third = await start();
    await third.keepOwnerCode(listener, { kept: made.code! });
    assert.equal(heard[3]?.made, true);
    assert.notEqual(heard[3]?.code, made.code);
    await assert.rejects(third.pair({ code: made.code!, name: "Late" }), (e) => code(e) === "unauthorized");
    await third.stop();

    // The kept code still pairs; once a person's device is paired, a later start hears null whatever the host holds.
    const fourth = await start();
    await fourth.keepOwnerCode(listener, { kept: heard[3]!.code! });
    assert.deepEqual([heard.length, heard[4]!.made, heard[4]!.code], [5, false, heard[3]!.code]);
    await fourth.pair({ code: heard[4]!.code!, name: "Mac" });
    assert.deepEqual(heard[5], { code: null, made: false });
    await fourth.stop();
    const fifth = await start();
    await fifth.keepOwnerCode(listener, { kept: heard[4]!.code! });
    assert.deepEqual(heard[6], { code: null, made: false });
    await fifth.stop();
    store.close();
  });
});

describe("briefs", () => {
  test("each highlight gets its thread's subject from the server", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Contract renewal", date: at(-HOUR) });
    const brief = await t.server.writeBrief(t.person, { from: at(-DAY), to: at(HOUR), sections: [{ inboxId: inbox.id, highlights: [{ threadId: thread.id, line: "Confirm by Friday." }] }] });
    assert.deepEqual(brief.sections[0]!.highlights, [{ threadId: thread.id, subject: "Contract renewal", line: "Confirm by Friday." }]);
    assert.deepEqual(await t.server.latestBrief(t.person), brief);
  });
});

describe("upgrading a store", () => {
  test("a store from the second revision upgrades: new columns get their defaults, piles become categories, connections are described, and the service reads it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usual-mail-upgrade-"));
    try {
      // Migrate a file to 0001 only, with a copy of the migrations that stops there.
      const source = fileURLToPath(new URL("../migrations", import.meta.url));
      const older = join(dir, "migrations");
      await cp(source, older, { recursive: true });
      const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
      journal.entries = journal.entries.filter((entry) => ["0000_init", "0001_revised_contract"].includes(entry.tag));
      await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
      const file = join(dir, "old.db");
      const client = createClient({ url: `file:${file}` });
      await migrate(drizzle(client), { migrationsFolder: older });
      const now = Date.parse(START);
      const secrets = await aesGcmSecrets(webRandom.bytes(32), webRandom);
      const sealed = await secrets.seal(JSON.stringify({ mailbox: "old@acme.example" }), "inb_old");
      await client.batch([
        { sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials) VALUES ('inb_old', 'Old', 'old@acme.example', '#000000', 'imap', 'suggest', 'ok', ?, ?)", args: [now, sealed] },
        { sql: "INSERT INTO rules (id, inbox_id, text, \"match\", \"then\", source, enabled, hits, created_at) VALUES ('rul_old', 'inb_old', 'Old rule', '{\"domain\":\"acme.example\"}', '[{\"kind\":\"done\"}]', 'person', 1, 3, ?)", args: [now] },
        { sql: "INSERT INTO threads (id, inbox_id, thread_key, subject, snippet, participants, last_message_at, message_count, unread, has_attachments, pile, done, come_back_at, triage, created_at) VALUES ('thr_old', 'inb_old', 'k', 'Old thread', '', '[]', ?, 0, 0, 0, 'people', 0, ?, 'by_person', ?)", args: [now, now - DAY, now] },
        { sql: "INSERT INTO actions (id, thread_id, inbox_id, action, kind, actor, actor_kind, state, at, undoable, before) VALUES ('act_old', 'thr_old', 'inb_old', '{\"kind\":\"done\"}', 'done', '{\"kind\":\"agent\",\"agentId\":\"dev_a\",\"name\":\"A\"}', 'agent', 'applied', ?, 1, '{\"threads\":[]}')", args: [now] },
        { sql: "INSERT INTO drafts (id, inbox_id, to_addresses, cc_addresses, bcc_addresses, subject, body, created_by, state, created_at, updated_at) VALUES ('drf_old', 'inb_old', '[]', '[]', '[]', 'Hi', 'Hello', '{\"kind\":\"system\"}', 'draft', ?, ?)", args: [now, now] },
      ], "write");
      client.close();

      const store = await openDatabase(`file:${file}`);
      const clock = new ManualClock(START);
      const providers = new ProviderRegistry();
      providers.register("imap", memoryFactory(new Map(), { kind: "imap" }));
      const server = await MailServer.create({
        db: store.db, clock, scheduler: clock, random: webRandom, events: new MemoryEventBus(), secrets, log: { info: () => {}, error: () => {} },
      }, { providers, models: new FakeModels() });
      const person = (await server.authenticate((await server.pair({ code: (await server.ownerPairingCode())!.code, name: "Mac" })).token))!;
      const [old] = await server.listInboxes(person);
      // The fifth revision's upgrade gives it an icon and a place and raises its version. No AI switch since.
      assert.deepEqual([old!.version, old!.icon, old!.position, "aiProcessing" in old!], [2, "person", 0, false]);
      // The provider describes the stored credentials at start: the connection a form can show again.
      assert.deepEqual(old!.connection, {
        kind: "imap",
        imap: { host: "imap.memory.example", port: 993, secure: true, user: "old@acme.example" },
        smtp: { host: "smtp.memory.example", port: 465, secure: true, user: "old@acme.example" },
        saveSent: true,
      });
      // Who made an older rule wasn't recorded.
      assert.deepEqual((await server.listRules(person, "inb_old")).map((r) => [r.id, r.version, r.createdBy, r.hits]), [["rul_old", 1, { kind: "system" }, 3]]);
      assert.deepEqual((await server.handled(person, {})).items.map((i) => [i.record.id, i.record.silent, i.record.note]), [["act_old", false, undefined]]);
      assert.equal((await server.listDrafts(person, {})).items[0]!.version, 1);
      // A people thread a person had sorted is a conversation the person decided.
      const thread = (await server.thread(person, "thr_old")).thread;
      assert.deepEqual([thread.category, thread.categorizedBy, thread.screened, thread.summary], ["conversation", "person", false, undefined]);
      await server.stop();
      store.close();
      const reader = createClient({ url: `file:${file}` });
      const announced = await reader.execute("SELECT come_back_announced, revision FROM threads WHERE id = 'thr_old'");
      reader.close();
      assert.deepEqual([announced.rows[0]!.come_back_announced, announced.rows[0]!.revision], [1, 0], "a time that passed before the upgrade isn't announced again");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
