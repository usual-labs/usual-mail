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
      reason: "host_setup", words: attention.clientRefused(),
    });
    // On a host that gives the client its own way (Cloudflare's Worker secrets), the words say that way.
    const worker = "the Worker's secrets USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET, in its settings";
    assert.match(classifyFailure(signedIn, named("GoogleTokenError", { kind: "client_refused" }), worker).words, /\(the Worker's secrets USUAL_MAIL_GOOGLE_CLIENT_ID/);
    assert.doesNotMatch(attention.clientMissing(worker), /usual-mail google set/);
    // Connected by hand, the client is the person's own: new credentials fix it, in Google's words.
    assert.deepEqual(classifyFailure(byHand, named("GoogleTokenError", { kind: "client_refused" })), {
      reason: "needs_sign_in", words: "GoogleTokenError said no",
    });
    assert.equal(sorted(signedIn, new InboxAccessError("host_setup", attention.clientMissing())), "host_setup");
    assert.equal(sorted(signedIn, new InboxAccessError("needs_sign_in", attention.otherClient)), "needs_sign_in");
    assert.equal(sorted(signedIn, named("GmailApiError", { status: 401 })), "needs_sign_in");
    // A missing scope, as mail's words and kind say it (by Gmail's reason or its message): a new sign-in fixes it.
    assert.equal(sorted(signedIn, named("GmailApiError", { status: 403, reason: "insufficientPermissions", kind: "scope" })), "needs_sign_in");
    assert.equal(sorted(signedIn, named("GmailApiError", { status: 403, reason: "forbidden", kind: "scope" })), "needs_sign_in");
    // The Gmail API off in the client's project: whoever's client it is turns it on, in the server's words.
    const apiOff = named("GmailApiError", { status: 403, reason: "accessNotConfigured" });
    assert.deepEqual(classifyFailure(signedIn, apiOff), { reason: "host_setup", words: attention.gmailApiOff(true) });
    assert.match(attention.gmailApiOff(true), /^Gmail refused this server's Google client: the Gmail API is turned off .* The host must turn it on there/);
    assert.deepEqual(classifyFailure(byHand, apiOff), { reason: "needs_sign_in", words: attention.gmailApiOff(false) });
    assert.match(attention.gmailApiOff(false), /^Gmail refused this inbox's Google client: .* Turn it on there \(APIs and services, Library, Gmail API, Enable\)/);
    for (const error of [
      named("GmailApiError", { status: 503 }), named("GmailApiError", { status: 429 }),
      // The daily quota passes once Google resets it: its words (mail's) say until when.
      named("GmailApiError", { status: 403, reason: "dailyLimitExceeded", kind: "daily_quota" }), named("GmailUnreachable"),
      named("GoogleRefreshError"), named("TimeoutError"), new Error("getaddrinfo ENOTFOUND imap.acme.example"), "odd",
    ]) {
      assert.equal(sorted(signedIn, error), null, String((error as Error).name ?? error));
    }
  });
});

describe("the grace for failures that may pass", () => {
  const passing: Failure = { reason: null, words: "Connection refused" };
  const GAP = 15 * MINUTE;
  /** An attempt that ended at `end`, begun at `start` (at once, unless said). */
  const attempt = (end: number, start = end) => ({ startedAt: start, endedAt: end });
  const after = (was: InboxRow, failure: Failure, end: number, start = end) => ({ ...was, ...afterFailure(was, failure, attempt(end, start), GAP) });

  test("two failures over ten minutes make provider_error; fewer or sooner leave the status as it was", () => {
    const first = after(row({ lastAttemptAt: 0 }), passing, MINUTE);
    assert.deepEqual([first.status, first.failingSince, first.failures], ["ok", MINUTE, 1]);
    const soon = after(first, passing, 9 * MINUTE);
    assert.deepEqual([soon.status, soon.statusReason, soon.failures], ["ok", null, 2]);
    const late = after(soon, passing, 11 * MINUTE);
    assert.deepEqual([late.status, late.statusReason, late.statusDetail], ["needs_attention", "provider_error", "Connection refused"]);
    // One failure alone never warns, however long ago the last good sync was.
    assert.equal(after(row({ lastAttemptAt: 0, lastSyncedAt: 0 }), passing, 30 * MINUTE).status, "ok");
  });

  test("a long gap before an attempt starts a new run: a stopped server or a sleeping machine isn't failing", () => {
    const failing = row({ lastAttemptAt: 9 * MINUTE, failingSince: MINUTE, failures: 5 });
    const woke = after(failing, passing, 9 * MINUTE + 8 * 60 * MINUTE);
    assert.deepEqual([woke.status, woke.failures, woke.failingSince], ["ok", 1, 9 * MINUTE + 8 * 60 * MINUTE]);
  });

  test("a long attempt is failing time, not a gap: a hang before a failure counts, and slow attempts don't flip", () => {
    // Begun a minute after the last good one, it hung 22 minutes, then failed: failing since it began.
    const hung = after(row({ lastAttemptAt: 0 }), passing, 23 * MINUTE, MINUTE);
    assert.deepEqual([hung.status, hung.failingSince, hung.failures], ["ok", MINUTE, 1]);
    assert.equal(after(hung, passing, 24 * MINUTE, 23 * MINUTE).statusReason, "provider_error", "the next failure: 23 minutes");
    // Attempts of twenty minutes each, one after another: one run, said once the grace is past, and it stays.
    let slow = row({ lastAttemptAt: 0 });
    const said: Array<string | null> = [];
    for (let n = 0; n < 4; n++) {
      slow = after(slow, passing, (n + 1) * 20 * MINUTE, n * 20 * MINUTE);
      said.push(slow.statusReason);
    }
    assert.deepEqual(said, [null, "provider_error", "provider_error", "provider_error"]);
  });

  test("a refused sign-in or the host's setup stays through failures that may pass, past the grace too", () => {
    const refused = after(row(), { reason: "needs_sign_in", words: "Refused." }, MINUTE);
    assert.deepEqual([refused.status, refused.statusReason, refused.statusDetail], ["needs_attention", "needs_sign_in", "Refused."]);
    let offline = refused;
    for (let minute = 2; minute <= 30; minute++) offline = after(offline, passing, minute * MINUTE);
    assert.deepEqual([offline.statusReason, offline.statusDetail, offline.failures], ["needs_sign_in", "Refused.", 30]);
    const host = after(row(), { reason: "host_setup", words: "The host's client." }, MINUTE);
    assert.equal(after(after(host, passing, 2 * MINUTE), passing, 20 * MINUTE).statusReason, "host_setup");
  });

  test("after not_syncing a failure is provider_error at once; a reason-less one from before 0.1.2 starts again", () => {
    const silent = row({ status: "needs_attention", statusReason: "not_syncing", statusDetail: "…", lastAttemptAt: MINUTE });
    const failed = after(silent, passing, 22 * MINUTE, 2 * MINUTE);
    assert.deepEqual([failed.status, failed.statusReason, failed.statusDetail], ["needs_attention", "provider_error", "Connection refused"]);
    // From before 0.1.2: no reason, so it can't be told from a failure that may pass; it waits out the grace again.
    const old = row({ status: "needs_attention", statusDetail: "Connection refused", lastAttemptAt: MINUTE });
    assert.deepEqual([after(old, passing, 2 * MINUTE).status], ["ok"]);
    assert.equal(after({ ...old, lastSyncedAt: null }, passing, 2 * MINUTE).status, "connecting");
  });

  test("the words for an inbox that stopped syncing say when it last synced well, in the server's zone", () => {
    const at = Date.parse("2026-11-25T14:02:00Z");
    assert.equal(
      notSyncingWords(at, 15 * MINUTE, undefined),
      "This inbox hasn't synced since 25 Nov, 14:02 UTC, and none of its syncs has finished for over 15 minutes, " +
        "though the server is running. Try again; if it stays like this, restart the server.",
    );
    assert.match(notSyncingWords(at, 15 * MINUTE, "Europe/Berlin"), /since 25 Nov, 15:02 CET,/);
    assert.match(notSyncingWords(null, 15 * MINUTE, "Not/AZone"), /^This inbox hasn't synced yet, and none of its syncs has finished for over 15 minutes/);
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

  test("nor does it sleeping for hours during an attempt: the attempt's length is the time the machine was awake", async () => {
    t = await makeServer();
    const s = t;
    let lidCloses = false;
    slow(s, () => {
      // The lid closes with a sync in flight: eight hours pass on the wall clock, none on the monotonic one.
      if (!lidCloses) return;
      lidCloses = false;
      s.clock.sleep(8 * 60 * MINUTE);
    });
    const { mailbox } = await s.connect({ address: "me@acme.example" });
    const heard = listen(s);
    mailbox.failSync = "getaddrinfo ENOTFOUND imap.acme.example";
    lidCloses = true;
    await s.tick(MINUTE);
    // Awake, the attempt fails, and so does the next poll's: two failures a minute or so apart, not eight hours.
    await s.tick(2 * MINUTE);
    assert.deepEqual([(await listed(s)).status, changes(heard.events)], ["ok", []]);
    for (let minute = 1; minute <= 10; minute++) await s.tick(MINUTE);
    assert.equal((await listed(s)).statusReason, "provider_error", "ten minutes of failing once awake");
    heard.stop();
  });

  test("but a hang while awake is failing time: the failure after it, a poll later, is said", async () => {
    t = await makeServer();
    const s = t;
    let hangs = false;
    slow(s, () => {
      // Twelve minutes awake inside the attempt, under the watch's fifteen, so only the failures say anything.
      if (!hangs) return;
      hangs = false;
      s.clock.advance(12 * MINUTE);
    });
    const { mailbox } = await s.connect({ address: "me@acme.example" });
    const heard = listen(s);
    mailbox.failSync = "Connection timed out";
    hangs = true;
    await s.tick(MINUTE);
    assert.deepEqual([(await listed(s)).status, changes(heard.events)], ["ok", []], "one failure alone");
    // The next poll's failure: the run began with the hung attempt, thirteen minutes before.
    await s.tick(MINUTE);
    heard.stop();
    assert.deepEqual(changes(heard.events), [["needs_attention", "provider_error"]]);
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
    assert.match(silent.statusDetail ?? "", /^This inbox hasn't synced since \d+ \w+, \d\d:\d\d UTC, and none of its syncs has finished for over 15 minutes/);
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
