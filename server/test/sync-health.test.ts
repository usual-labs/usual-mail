// When an inbox needs attention (docs/contract-sync.md, "When an inbox needs attention"; 0.1.2): failures sorted by
// what fixes them, the grace for failures that may pass, and the watch on syncs that never finish, which neither a
// restart nor a sleeping machine sets off.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { SIGN_IN_REFUSED, type Inbox, type MailEvent } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { inboxes, type InboxRow } from "../src/db/index.ts";
import { InboxAccessError } from "../src/google/credentials.ts";
import { attention } from "../src/google/words.ts";
import { MailServer } from "../src/service/server.ts";
import { afterFailure, classifyFailure, notSyncingWords, type Failure } from "../src/sync/health.ts";
import { history, slow } from "./first-sync-helpers.ts";
import { listen, makeServer, type TestServer } from "./helpers.ts";

const MINUTE = 60_000;
let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A row as the store keeps it, with what a case needs. */
function row(fields: Partial<InboxRow> = {}): InboxRow {
  return {
    status: "ok", statusDetail: null, statusReason: null, lastAttemptAt: null, failingSince: null, failures: 0,
    lastSyncedAt: 0, connection: { kind: "imap", imap: { host: "imap.acme.example", port: 993, secure: true, user: "me" } },
    ...fields,
  } as InboxRow;
}

const signedIn = row({ connection: { kind: "gmail", clientId: "client.example", signIn: "google" } });
const byHand = row({ connection: { kind: "gmail", clientId: "client.example" } });
const named = (name: string, fields: Record<string, unknown> = {}) => Object.assign(new Error(`${name} said no`), { name, ...fields });

describe("sorting a failed sync", () => {
  test("a refused sign-in needs the person; the host's setup, the host; the rest may pass", () => {
    const sorted = (inbox: InboxRow, error: unknown) => classifyFailure(inbox, error).reason;
    assert.equal(sorted(row(), named(SIGN_IN_REFUSED)), "needs_sign_in", "IMAP's refused login");
    assert.deepEqual(classifyFailure(signedIn, named("GoogleTokenError", { kind: "token_refused" })), {
      reason: "needs_sign_in", words: attention.tokenRefused,
    });
    assert.deepEqual(classifyFailure(signedIn, named("GoogleTokenError", { kind: "client_refused" })), {
      reason: "host_setup", words: attention.clientRefused,
    });
    // Connected by hand, the client is the person's own: new credentials fix it, in Google's words.
    assert.deepEqual(classifyFailure(byHand, named("GoogleTokenError", { kind: "client_refused" })), {
      reason: "needs_sign_in", words: "GoogleTokenError said no",
    });
    assert.equal(sorted(signedIn, new InboxAccessError("host_setup", attention.clientMissing)), "host_setup");
    assert.equal(sorted(signedIn, new InboxAccessError("needs_sign_in", attention.otherClient)), "needs_sign_in");
    assert.equal(sorted(signedIn, named("GmailApiError", { status: 401 })), "needs_sign_in");
    assert.equal(sorted(signedIn, named("GmailApiError", { status: 403, reason: "insufficientPermissions" })), "needs_sign_in");
    assert.equal(sorted(signedIn, named("GmailApiError", { status: 403, reason: "accessNotConfigured" })), "host_setup");
    assert.equal(sorted(byHand, named("GmailApiError", { status: 403, reason: "accessNotConfigured" })), "needs_sign_in");
    for (const error of [
      named("GmailApiError", { status: 503 }), named("GmailApiError", { status: 429 }),
      named("GmailApiError", { status: 403, reason: "dailyLimitExceeded" }), named("GmailUnreachable"),
      named("GoogleRefreshError"), named("TimeoutError"), new Error("getaddrinfo ENOTFOUND imap.acme.example"), "odd",
    ]) {
      assert.equal(sorted(signedIn, error), null, String((error as Error).name ?? error));
    }
  });
});

describe("the grace for failures that may pass", () => {
  const passing: Failure = { reason: null, words: "Connection refused" };
  const GAP = 15 * MINUTE;

  test("two failures over ten minutes make provider_error; fewer or sooner leave the status as it was", () => {
    const first = afterFailure(row({ lastAttemptAt: 0 }), passing, MINUTE, GAP);
    assert.deepEqual([first.status, first.failingSince, first.failures], ["ok", MINUTE, 1]);
    const soon = afterFailure({ ...row(), ...first }, passing, 9 * MINUTE, GAP);
    assert.deepEqual([soon.status, soon.statusReason, soon.failures], ["ok", null, 2]);
    const late = afterFailure({ ...row(), ...soon }, passing, 11 * MINUTE, GAP);
    assert.deepEqual([late.status, late.statusReason, late.statusDetail], ["needs_attention", "provider_error", "Connection refused"]);
    // One failure alone never warns, however long ago the last good sync was.
    const once = afterFailure(row({ lastAttemptAt: 0, lastSyncedAt: 0 }), passing, 30 * MINUTE, GAP);
    assert.equal(once.status, "ok");
  });

  test("a long gap since the last attempt starts a new run: a stopped server or a sleeping machine isn't failing", () => {
    const failing = row({ lastAttemptAt: 9 * MINUTE, failingSince: MINUTE, failures: 5 });
    const after = afterFailure(failing, passing, 9 * MINUTE + 8 * 60 * MINUTE, GAP);
    assert.deepEqual([after.status, after.failures, after.failingSince], ["ok", 1, 9 * MINUTE + 8 * 60 * MINUTE]);
  });

  test("a refused sign-in is at once and stays through failures that may pass; a finished attempt ends not_syncing", () => {
    const refused = afterFailure(row(), { reason: "needs_sign_in", words: "Refused." }, MINUTE, GAP);
    assert.deepEqual([refused.status, refused.statusReason, refused.statusDetail], ["needs_attention", "needs_sign_in", "Refused."]);
    const thenOffline = afterFailure({ ...row(), ...refused }, passing, 2 * MINUTE, GAP);
    assert.deepEqual([thenOffline.statusReason, thenOffline.statusDetail], ["needs_sign_in", "Refused."]);
    const silent = row({ status: "needs_attention", statusReason: "not_syncing", statusDetail: "…", lastAttemptAt: MINUTE });
    assert.deepEqual(afterFailure(silent, passing, 2 * MINUTE, GAP).status, "ok");
    assert.deepEqual(afterFailure({ ...silent, lastSyncedAt: null }, passing, 2 * MINUTE, GAP).status, "connecting");
    // From before 0.1.2: no reason, so it can't be told from a failure that may pass; it waits out the grace again.
    const old = row({ status: "needs_attention", statusDetail: "Connection refused", lastAttemptAt: MINUTE });
    assert.deepEqual([afterFailure(old, passing, 2 * MINUTE, GAP).status], ["ok"]);
  });

  test("the words for an inbox that stopped syncing say since when, in the server's zone", () => {
    const at = Date.parse("2026-11-25T14:02:00Z");
    assert.match(notSyncingWords(at, 15 * MINUTE, undefined), /^No sync of this inbox has finished since 25 Nov, 14:02 UTC, /);
    assert.match(notSyncingWords(at, 15 * MINUTE, "Europe/Berlin"), /since 25 Nov, 15:02 CET/);
    assert.match(notSyncingWords(null, 15 * MINUTE, "Not/AZone"), /finished for over 15 minutes, though the server is running/);
  });
});

/** inbox.changed events: status and reason. */
const changes = (events: MailEvent[]) =>
  events.flatMap((e) => (e.type === "inbox.changed" ? [[e.inbox.status, e.inbox.statusReason ?? null]] : []));
const listed = async (s: TestServer): Promise<Inbox> => (await s.server.listInboxes(s.person))[0]!;
/** Lets queued work run without waiting for idle, which a held sync never reaches. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe("a sync that keeps failing", () => {
  test("polled every minute, a failure that may pass is said after ten minutes, once, and a good sync ends it", async () => {
    t = await makeServer();
    const s = t;
    const { mailbox } = await s.connect({ address: "me@acme.example" });
    const heard = listen(s);
    mailbox.failSync = "Connection refused";
    for (let minute = 1; minute <= 10; minute++) await s.tick(MINUTE);
    assert.deepEqual([(await listed(s)).status, changes(heard.events)], ["ok", []], "nine minutes of failing: nothing yet");
    await s.tick(MINUTE);
    const failing = await listed(s);
    assert.deepEqual([failing.status, failing.statusReason, failing.statusDetail], ["needs_attention", "provider_error", "Connection refused"]);
    await s.tick(MINUTE);
    mailbox.failSync = null;
    await s.tick(MINUTE);
    heard.stop();
    assert.deepEqual(changes(heard.events), [["needs_attention", "provider_error"], ["ok", null]]);
    assert.equal((await listed(s)).statusReason, undefined);
  });

  test("a refused login is said at once, with its reason, and new credentials start afresh", async () => {
    t = await makeServer();
    const s = t;
    const { inbox, mailbox } = await s.connect({ address: "me@acme.example" });
    Object.assign(mailbox, { failSync: "The IMAP server refused the user name or password.", signInRefused: true });
    await s.sync(inbox);
    assert.deepEqual([(await listed(s)).status, (await listed(s)).statusReason], ["needs_attention", "needs_sign_in"]);
    mailbox.failSync = null;
    const changed = await s.server.updateInbox(s.person, inbox.id, { credentials: { mailbox: inbox.address } });
    assert.deepEqual([changed.status, changed.statusReason], ["connecting", undefined]);
    const [stored] = await s.host.db.select({ failures: inboxes.failures, since: inboxes.failingSince }).from(inboxes);
    assert.deepEqual(stored, { failures: 0, since: null });
  });

  test("the machine sleeping between two failures doesn't make them ten minutes of failing", async () => {
    t = await makeServer();
    const s = t;
    const { mailbox } = await s.connect({ address: "me@acme.example" });
    const heard = listen(s);
    mailbox.failSync = "getaddrinfo ENOTFOUND imap.acme.example";
    await s.tick(MINUTE);
    s.clock.sleep(8 * 60 * MINUTE);
    // Awake: the poll that was due comes, fails again, and starts a new run; nothing has stopped syncing either.
    await s.tick(2 * MINUTE);
    assert.deepEqual([(await listed(s)).status, changes(heard.events)], ["ok", []]);
    for (let minute = 1; minute <= 10; minute++) await s.tick(MINUTE);
    assert.equal((await listed(s)).statusReason, "provider_error", "ten minutes of failing once awake");
    heard.stop();
  });
});

describe("a sync that never finishes", () => {
  test("is said after the larger of fifteen minutes and five polls, and settled when it finishes", async () => {
    t = await makeServer();
    const s = t;
    let hold = false;
    let release = () => {};
    slow(s, async () => {
      if (hold) await new Promise<void>((resolve) => (release = resolve));
    });
    await s.connect({ address: "me@acme.example" });
    const synced = await listed(s);
    const heard = listen(s);
    hold = true;
    for (let minute = 1; minute <= 15; minute++) {
      s.clock.advance(MINUTE);
      await settle();
    }
    assert.equal((await listed(s)).status, "ok", "fifteen minutes since the last sign of life: not yet");
    for (let minute = 16; minute <= 21; minute++) {
      s.clock.advance(MINUTE);
      await settle();
    }
    const silent = await listed(s);
    assert.deepEqual([silent.status, silent.statusReason], ["needs_attention", "not_syncing"]);
    assert.match(silent.statusDetail ?? "", /^No sync of this inbox has finished since \d+ \w+, \d\d:\d\d UTC, though the server is running\./);
    assert.equal(silent.version, synced.version + 1);
    hold = false;
    release();
    await s.server.whenIdle();
    heard.stop();
    assert.deepEqual(changes(heard.events), [["needs_attention", "not_syncing"], ["ok", null]]);
  });

  test("hours the machine slept don't count: only the minutes it was awake", async () => {
    t = await makeServer();
    const s = t;
    let hold = false;
    let release = () => {};
    slow(s, async () => {
      if (hold) await new Promise<void>((resolve) => (release = resolve));
    });
    await s.connect({ address: "me@acme.example" });
    hold = true;
    const awake = async (minutes: number) => {
      for (let minute = 0; minute < minutes; minute++) {
        s.clock.advance(MINUTE);
        await settle();
      }
    };
    // Five minutes held, eight hours asleep, five more awake: ten minutes the server waited, not eight hours.
    await awake(5);
    s.clock.sleep(8 * 60 * MINUTE);
    await awake(5);
    assert.equal((await listed(s)).status, "ok");
    // Awake long enough, it is said.
    await awake(12);
    assert.equal((await listed(s)).statusReason, "not_syncing");
    hold = false;
    release();
    await s.server.whenIdle();
  });

  test("a long first sync that keeps fetching isn't, in batches or in one long batch that says how far it got", async () => {
    t = await makeServer({ limits: { syncBatch: 2 } });
    const s = t;
    let calls = 0;
    slow(s, async (call, options) => {
      calls = call;
      // Only the first sync is slow: a later poll's sync moving the clock would make the next poll due at once.
      if (!options?.onProgress) return;
      // Nine batches of four minutes each; the third one alone runs 32 minutes, saying how far it got as it goes.
      // Each step lets the server's own work run, as time passing would (the watch looks again once it has looked).
      for (let step = 0; step < (call === 3 ? 8 : 1); step++) {
        s.clock.advance(4 * MINUTE);
        options.onProgress({ sent: call * 2, total: 18 });
        await settle();
      }
    });
    const heard = listen(s);
    await s.connect({ address: "me@slow.example", history: history(18) });
    heard.stop();
    assert.ok(calls >= 9);
    assert.ok(!changes(heard.events).some(([, reason]) => reason === "not_syncing"), "nothing said it stopped syncing");
    assert.equal((await listed(s)).status, "ok");
  });

  test("a restart settles what the last run said, and begins the watch afresh", async () => {
    t = await makeServer();
    const s = t;
    const { inbox } = await s.connect({ address: "me@acme.example" });
    await s.host.db.update(inboxes).set({ status: "needs_attention", statusReason: "not_syncing", statusDetail: "…" })
      .where(eq(inboxes.id, inbox.id));
    await s.server.stop();
    // Hours later, a new run on the same store: what the last one said is settled before anything is opened.
    s.clock.sleep(5 * 60 * MINUTE);
    const again = await MailServer.create(s.host, { providers: s.providers, models: s.models, pollIntervalMs: MINUTE });
    await again.start();
    await again.whenIdle();
    const settled = (await again.listInboxes(s.person))[0]!;
    assert.deepEqual([settled.status, settled.statusReason], ["ok", undefined]);
    await again.stop();
  });

  test("a paused inbox is never said to have stopped", async () => {
    t = await makeServer();
    const s = t;
    const { inbox } = await s.connect({ address: "me@acme.example" });
    await s.server.updateInbox(s.person, inbox.id, { paused: true });
    await s.tick(2 * 60 * MINUTE);
    assert.deepEqual([(await listed(s)).status, (await listed(s)).statusReason], ["paused", undefined]);
  });
});
