/**
 * Gmail cases beyond the shared contract, against the fake API: token refresh, history, changes without
 * downloads, the reset after history expired, label creation, sending into threads, untrash, rate-limit
 * backoff, paging, drafts and the `since` window.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MailProvider } from "@usualmail/core";
import { createGmailProvider, GoogleTokenError, type GmailProviderOptions } from "../../src/index.ts";
import { FakeGmail, destinations, plainMessage, syncAll } from "../../src/testing/index.ts";
import { decodeGmailCursor } from "../../src/gmail/cursor.ts";

const ADDRESS = "me@mail.example";
const DAY = 24 * 60 * 60 * 1000;

function setup(options: GmailProviderOptions = {}, start = Date.parse("2026-11-16T09:00:00Z")) {
  let now = start;
  const sleeps: number[] = [];
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  const fake = new FakeGmail({ address: ADDRESS, now: clock.now });
  const provider = createGmailProvider(fake.credentials, { fetch: fake.fetch, clock, quotaPerSecond: 1_000_000, ...options });
  return { fake, provider, clock, sleeps, advance: (ms: number) => (now += ms) };
}

function mail(subject: string, extra: Partial<Parameters<typeof plainMessage>[0]> = {}) {
  return plainMessage({ from: "Cy <cy@people.example>", to: ADDRESS, subject, ...extra });
}

/** Merges every history page's records into one record, as Gmail does for a bulk change. */
function oneRecordPerPage(fetch: typeof FakeGmail.prototype.fetch): typeof FakeGmail.prototype.fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.pathname.endsWith("/history") || !response.ok) return response;
    const page = (await response.json()) as { history?: Array<Record<string, unknown[] | string>> };
    if (page.history && page.history.length > 1) {
      const merged: Record<string, unknown[] | string> = { id: page.history.at(-1)!.id as string };
      for (const record of page.history) {
        for (const [key, value] of Object.entries(record)) if (Array.isArray(value)) merged[key] = [...((merged[key] as unknown[]) ?? []), ...value];
      }
      page.history = [merged];
    }
    return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function subjects(provider: MailProvider, cursor: string | null, limit?: number) {
  const result = await syncAll(provider, cursor, limit);
  return { result, subjects: [...result.messages.values()].map((m) => m.subject).sort() };
}

describe("Gmail tokens", () => {
  it("refreshes once, reuses the token, and refreshes again when Gmail rejects it", async () => {
    const { fake, provider } = setup();
    await fake.deliver(mail("One").raw);
    await provider.verify();
    await syncAll(provider, null);
    assert.equal(fake.tokenRequests.length, 1, "one refresh for several calls");
    fake.expireAccessTokens();
    await fake.deliver(mail("Two").raw);
    const { subjects: got } = await subjects(provider, null);
    assert.deepEqual(got, ["One", "Two"]);
    assert.equal(fake.tokenRequests.length, 2, "a 401 led to exactly one more refresh");
  });

  it("refreshes before the token runs out", async () => {
    const { fake, provider, advance } = setup();
    await provider.verify();
    advance(3599 * 1000 - 30_000);
    await provider.sync(null);
    assert.equal(fake.tokenRequests.length, 2);
  });

  it("explains a revoked refresh token or a wrong client", async () => {
    const revoked = setup();
    revoked.fake.refreshToken = "something-else";
    await assert.rejects(revoked.provider.verify(), /invalid_grant.*Connect the Gmail inbox again/);
    const wrongClient = new FakeGmail({ address: ADDRESS });
    const provider = createGmailProvider({ ...wrongClient.credentials, clientSecret: "nope" }, { fetch: wrongClient.fetch });
    await assert.rejects(provider.verify(), /refused the OAuth client/);
  });

  it("says which kind of refusal it was, so the server can say what to do", async () => {
    const revoked = setup();
    revoked.fake.refreshToken = "something-else";
    await assert.rejects(revoked.provider.verify(), (error: Error) => {
      assert.equal(error.name, "GoogleTokenError");
      assert.equal((error as GoogleTokenError).kind, "token_refused");
      return true;
    });
    const wrongClient = new FakeGmail({ address: ADDRESS });
    const provider = createGmailProvider({ ...wrongClient.credentials, clientSecret: "nope" }, { fetch: wrongClient.fetch });
    await assert.rejects(provider.verify(), (error: Error) => error instanceof GoogleTokenError && error.kind === "client_refused");
  });
});

describe("Gmail history", () => {
  it("continues from history and stops between records when the batch is full", async () => {
    const { fake, provider } = setup();
    await fake.deliver(mail("Old").raw);
    const first = await syncAll(provider, null);
    for (const s of ["N1", "N2", "N3", "N4", "N5"]) await fake.deliver(mail(s).raw);
    const { result, subjects: got } = await subjects(provider, first.cursor, 2);
    assert.deepEqual(got, ["N1", "N2", "N3", "N4", "N5"]);
    assert.equal(result.batches, 3);
    assert.equal(decodeGmailCursor(result.cursor).h, String(fake.mailbox.historyId));
  });

  it("lists its window again after history expired, sending only recent mail whole, and drops what is gone", async () => {
    const { fake, provider, advance, clock } = setup({ since: "2026-10-01T00:00:00Z" });
    await fake.deliver(mail("Before the window").raw, ["INBOX"], clock.now() - 60 * DAY);
    const archived = await fake.deliver(mail("Old, archived").raw, [], clock.now() - 20 * DAY);
    const filed = await fake.deliver(mail("Old, filed").raw, ["INBOX", "UNREAD"], clock.now() - 15 * DAY);
    const deleted = await fake.deliver(mail("Old, deleted while away").raw, ["INBOX"], clock.now() - 12 * DAY);
    let state = await syncAll(provider, null);
    assert.equal(state.view.size, 3);
    await provider.apply([{ op: "place", ref: filed.id, inInbox: false, category: "newsletter", screened: false, stack: "reply_later" }]);
    state = await syncAll(provider, state);
    advance(10 * DAY);
    fake.mailbox.modify(archived, ["INBOX"], []);
    fake.mailbox.delete(deleted.id);
    const early = await fake.deliver(mail("While away, early").raw, ["INBOX"], clock.now() - 5 * DAY);
    const late = await fake.deliver(mail("While away, late").raw, ["INBOX", "UNREAD"]);
    fake.expireHistory();
    const mark = fake.requests.length;
    const result = await syncAll(provider, state, 2);
    assert.equal(result.resets, 1, "the first batch said reset");
    assert.equal(result.log[0]?.reset, true);
    assert.deepEqual(result.dropped, [deleted.id], "what the listing left out was dropped");
    assert.deepEqual([...result.upserted].sort(), [early.id, late.id].sort(), "mail from two days before the last good sync on is sent whole");
    assert.deepEqual([...result.changed].sort(), [archived.id, filed.id].sort(), "older mail comes as changes");
    assert.deepEqual(result.unknownChanged, []);
    const raw = fake.requests.slice(mark).filter((r) => r.method === "GET" && r.query.get("format") === "raw");
    assert.equal(raw.length, 2, "only the two recent messages were downloaded");
    assert.deepEqual(result.view.get(archived.id)?.placement, { inInbox: true, category: null, screened: false, stack: null, trashed: false, spam: false }, "moved back to the inbox elsewhere");
    assert.equal(result.view.get(archived.id)?.seen, true);
    assert.deepEqual(result.view.get(filed.id)?.placement, { inInbox: false, category: "newsletter", screened: false, stack: "reply_later", trashed: false, spam: false });
    assert.equal(result.view.get(filed.id)?.seen, false);
    assert.equal(decodeGmailCursor(result.cursor).h, String(fake.mailbox.historyId));
    await fake.deliver(mail("Afterwards").raw);
    const after = await syncAll(provider, result);
    assert.deepEqual([...after.messages.values()].map((m) => m.subject), ["Afterwards"], "history works again from the new id");
  });

  it("keeps to the limit when one history record names more messages than the limit", async () => {
    const { fake, provider } = setup();
    const messages = [];
    for (const s of ["B1", "B2", "B3", "B4", "B5"]) messages.push(await fake.deliver(mail(s).raw));
    const first = await syncAll(provider, null);
    // Another app archives all five at once: Gmail can record that as one history record.
    for (const message of messages) fake.mailbox.modify(message, [], ["INBOX"]);
    const bulk = createGmailProvider(fake.credentials, { fetch: oneRecordPerPage(fake.fetch), quotaPerSecond: 1_000_000 });
    const next = await syncAll(bulk, first, 2);
    for (const batch of next.log) assert.ok(batch.upserted.length + batch.changed.length <= 2, JSON.stringify(batch));
    assert.deepEqual([...next.changed].sort(), messages.map((m) => m.id).sort(), "each archived message came once, as a change");
    assert.deepEqual(next.upserted, []);
    for (const message of messages) assert.equal(next.view.get(message.id)?.placement.inInbox, false);
    assert.equal(decodeGmailCursor(next.cursor).h, String(fake.mailbox.historyId));
    const quiet = await syncAll(bulk, next);
    assert.equal(quiet.changed.length + quiet.upserted.length, 0, "nothing is sent twice");
  });

  it("sends a label change made elsewhere as a change, without downloading the message", async () => {
    const { fake, provider } = setup();
    const message = await fake.deliver(mail("Archive me elsewhere").raw);
    const state = await syncAll(provider, null);
    fake.mailbox.modify(message, [], ["INBOX", "UNREAD"]);
    const mark = fake.requests.length;
    const next = await syncAll(provider, state);
    assert.deepEqual(next.changed, [message.id]);
    assert.deepEqual(next.upserted, []);
    assert.deepEqual(next.view.get(message.id)?.placement, { inInbox: false, category: null, screened: false, stack: null, trashed: false, spam: false });
    assert.equal(next.view.get(message.id)?.seen, true);
    assert.deepEqual(fake.requests.slice(mark).map((r) => r.path).sort(), ["/history", "/labels"], "history alone was enough");
  });

  it("asks for the labels when history leaves them out", async () => {
    const { fake, provider } = setup();
    const message = await fake.deliver(mail("Label me").raw);
    const state = await syncAll(provider, null);
    fake.historyLabelIds = false;
    await provider.apply([{ op: "place", ref: message.id, inInbox: false, category: "receipt", screened: false }]);
    const mark = fake.requests.length;
    const next = await syncAll(provider, state);
    assert.deepEqual(next.changed, [message.id]);
    assert.deepEqual(next.view.get(message.id)?.placement, { inInbox: false, category: "receipt", screened: false, stack: null, trashed: false, spam: false });
    const gets = fake.requests.slice(mark).filter((r) => r.path === `/messages/${message.id}`);
    assert.deepEqual(gets.map((r) => r.query.get("format")), ["minimal"], "one cheap request, not a download");
  });

  it("reports deletions from history and skips drafts", async () => {
    const { fake, provider } = setup();
    const keep = await fake.deliver(mail("Keep").raw);
    const first = await syncAll(provider, null);
    await fake.deliver(mail("A draft").raw, ["DRAFT"]);
    fake.mailbox.delete(keep.id);
    const next = await syncAll(provider, first.cursor);
    assert.deepEqual(next.removed, [keep.id]);
    assert.equal(next.messages.size, 0, "the draft isn't upserted");
  });
});

describe("Gmail first sync", () => {
  it("lists only mail after `since`, across pages, newest first", async () => {
    const { fake, provider, clock } = setup({ since: "2026-11-01T00:00:00Z" });
    await fake.deliver(mail("Before the window").raw, ["INBOX"], Date.parse("2026-10-01T00:00:00Z"));
    for (let i = 0; i < 520; i++) await fake.deliver(mail(`M${String(i).padStart(3, "0")}`).raw, ["INBOX"], clock.now() - (520 - i) * 1000);
    const first = await provider.sync(null, { limit: 3 });
    assert.deepEqual(first.upserted.map((m) => m.subject), ["M519", "M518", "M517"], "newest first");
    const listCalls = fake.requests.filter((r) => r.path === "/messages" && r.method === "GET").length;
    assert.equal(listCalls, 2, "two pages of 500");
    const all = await syncAll(provider, first.cursor, 200);
    assert.equal(all.messages.size, 517);
    assert.equal(all.log[0]?.upserted.length, 200);
    assert.ok(![...all.messages.values()].some((m) => m.subject === "Before the window"));
  });

  it("a smaller window takes effect for a first sync in progress; a larger one doesn't widen it; nothing fetched is dropped", async () => {
    const { fake, clock, advance } = setup();
    const start = clock.now();
    for (const days of [25, 10, 5, 2, 1]) await fake.deliver(mail(`${days} days old`).raw, ["INBOX"], start - days * DAY + 60_000);
    // The server opens the provider with the window as it is set when the provider is made.
    const opened = (days: number) =>
      createGmailProvider(fake.credentials, { fetch: fake.fetch, clock, quotaPerSecond: 1_000_000, since: new Date(start - days * DAY).toISOString() });
    const first = await syncAll(opened(30), null, { limit: 1, batches: 1 });
    assert.deepEqual(names(first), ["1 days old"]);

    // The window goes down to 7 days while the first sync is still being sent: mail older than that isn't fetched.
    const smaller = await syncAll(opened(7), first, { limit: 1, batches: 1 });
    assert.deepEqual(names(smaller), ["2 days old"]);
    // Up to 60 later: the first sync doesn't widen again. What was fetched stays; nothing is reported removed.
    const rest = await syncAll(opened(60), smaller, 1);
    assert.deepEqual(names(rest), ["5 days old"]);
    assert.deepEqual([rest.removed, rest.dropped], [[], []]);
    const raw = fake.requests.filter((r) => r.method === "GET" && r.query.get("format") === "raw").length;
    assert.equal(raw, 3, "only the three messages inside the window were downloaded");
    assert.deepEqual([...rest.view.values()].map((m) => m.subject).sort(), ["1 days old", "2 days old", "5 days old"]);

    // Mail that arrives later is taken whatever its date, as before.
    await fake.deliver(mail("Imported, 20 days old").raw, ["INBOX"], start - 20 * DAY);
    const later = await syncAll(opened(7), rest);
    assert.deepEqual(names(later), ["Imported, 20 days old"]);

    // History lost later: the listing still covers the window the first sync began with, so nothing it fetched is
    // dropped. As in any reset, only recent mail is sent whole; what the first sync left out comes as changes to refs
    // the server doesn't hold, which it ignores.
    advance(DAY);
    await fake.deliver(mail("While away").raw);
    fake.expireHistory();
    const reset = await syncAll(opened(7), later);
    assert.equal(reset.resets, 1);
    assert.deepEqual(reset.dropped, [], "nothing the first sync fetched is dropped");
    assert.deepEqual(reset.upserted.map((ref) => reset.view.get(ref)!.subject).sort(), ["1 days old", "2 days old", "While away"]);
    assert.equal(reset.unknownChanged.length, 2, "the 10 and 25 days old mail, never fetched, isn't sent whole");
  });
});

function names(result: Awaited<ReturnType<typeof syncAll>>): string[] {
  return [...result.messages.values()].map((m) => m.subject).sort();
}

describe("Gmail sending", () => {
  it("calls mail outgoing only when Gmail labels it SENT, never because From names the mailbox", async () => {
    const { fake, provider } = setup();
    await fake.deliver(mail("Forged", { from: `Me <${ADDRESS}>`, to: "deals@spam.example" }).raw, ["INBOX", "UNREAD"]);
    await fake.deliver(mail("Really sent", { from: `Me <${ADDRESS}>`, to: "bo@people.example" }).raw, ["SENT"]);
    await fake.deliver(mail("Sent to myself", { from: `Me <${ADDRESS}>`, to: ADDRESS }).raw, ["SENT", "INBOX"]);
    const state = await syncAll(provider, null);
    const bySubject = new Map([...state.messages.values()].map((m) => [m.subject, m.outgoing]));
    assert.deepEqual(Object.fromEntries(bySubject), { Forged: false, "Really sent": true, "Sent to myself": true });
  });

  it("puts a reply in the thread its threadKey names, without searching", async () => {
    const { fake, provider } = setup();
    const parent = await fake.deliver(mail("Question").raw);
    const state = await syncAll(provider, null);
    const mark = fake.requests.length;
    const sent = await provider.send({
      from: { email: ADDRESS }, to: [{ email: "cy@people.example" }], cc: [], bcc: [], subject: "Re: Question", text: "Answer",
      inReplyTo: parent.messageId!, references: [parent.messageId!], threadKey: parent.threadId,
    });
    assert.ok(!fake.requests.slice(mark).some((r) => r.path === "/messages" && r.method === "GET"), "no search for the thread");
    const after = await syncAll(provider, state);
    const reply = [...after.messages.values()].find((m) => m.messageId === sent.messageId);
    assert.equal(reply?.threadKey, parent.threadId);
    assert.notEqual(sent.messageId, undefined);
  });

  it("finds the thread by the parent's Message-ID when no threadKey is given", async () => {
    const { fake, provider } = setup();
    const parent = await fake.deliver(mail("Question").raw);
    const state = await syncAll(provider, null);
    const sent = await provider.send({
      from: { email: ADDRESS }, to: [{ email: "cy@people.example" }], cc: [], bcc: [], subject: "Re: Question", text: "Answer",
      inReplyTo: parent.messageId!, references: [parent.messageId!],
    });
    const after = await syncAll(provider, state);
    assert.equal([...after.messages.values()].find((m) => m.messageId === sent.messageId)?.threadKey, parent.threadId);
  });
});

describe("Gmail trash", () => {
  it("puts an untrashed message where the op says, also where trashing keeps INBOX", async () => {
    for (const trashRemovesInbox of [true, false]) {
      const { fake, provider } = setup();
      fake.mailbox.trashRemovesInbox = trashRemovesInbox;
      const message = await fake.deliver(mail("Bin and restore").raw);
      let state = await syncAll(provider, null);
      for (const wanted of destinations()) {
        const what = `${JSON.stringify(wanted)} (trashing removes INBOX: ${trashRemovesInbox})`;
        await provider.apply([{ op: "trash", ref: message.id }]);
        const [result] = await provider.apply([{ op: "untrash", ref: message.id, ...wanted }]);
        assert.deepEqual(result, { ok: true, ref: message.id }, what);
        state = await syncAll(provider, state);
        const expected = { inInbox: wanted.inInbox, category: wanted.category, screened: wanted.screened, stack: wanted.stack ?? null, trashed: false, spam: false };
        assert.deepEqual(state.view.get(message.id)?.placement, expected, what);
      }
    }
  });
});

describe("Gmail labels", () => {
  it("creates category, Screening and stack labels once, on demand", async () => {
    const { fake, provider } = setup();
    const { raw, messageId } = mail("Label me");
    await fake.deliver(raw);
    const state = await syncAll(provider, null);
    const ref = [...state.messages.values()].find((m) => m.messageId === messageId)!.ref;
    await provider.apply([{ op: "place", ref, inInbox: false, category: "newsletter", screened: false, stack: "reply_later" }]);
    await provider.apply([{ op: "place", ref, inInbox: false, category: "newsletter", screened: true, stack: "set_aside" }]);
    const created = fake.requests.filter((r) => r.method === "POST" && r.path === "/labels").length;
    assert.equal(created, 4, "Newsletters, Screening, Reply Later and Set Aside, each once");
    const names = [...fake.mailbox.labels.values()].filter((l) => l.type === "user").map((l) => l.name).sort();
    assert.deepEqual(names, ["Usual Mail/Newsletters", "Usual Mail/Reply Later", "Usual Mail/Screening", "Usual Mail/Set Aside"]);
    const labels = fake.mailbox.messages.get(ref)!.labelIds;
    assert.ok(!labels.has("INBOX"));
    assert.equal([...labels].filter((id) => id.startsWith("Label_")).length, 3, "the category's label, Screening's and one stack's");
    await provider.apply([{ op: "place", ref, inInbox: true, category: null, screened: false }]);
    assert.deepEqual([...fake.mailbox.messages.get(ref)!.labelIds].filter((id) => id.startsWith("Label_")), [], "back in the inbox, under no label of ours");
  });

  it("takes a placed message out of spam, as IMAP takes it out of Junk", async () => {
    const { fake, provider } = setup();
    const spam = await fake.deliver(mail("Not spam after all").raw, ["SPAM", "UNREAD"]);
    const state = await syncAll(provider, null);
    assert.equal(state.messages.get(spam.id)?.placement.spam, true);
    const [result] = await provider.apply([{ op: "place", ref: spam.id, inInbox: true, category: null, screened: false }]);
    assert.ok(result?.ok, result?.error);
    const next = await syncAll(provider, state);
    assert.deepEqual(next.view.get(spam.id)?.placement, { inInbox: true, category: null, screened: false, stack: null, trashed: false, spam: false });
    // Out of spam, a message is sent whole, also when this provider moved it: the server ignored it while it was in
    // spam, so it may not hold it (docs/contract.md, "Providers").
    assert.deepEqual([next.upserted, next.changed], [[spam.id], []], "out of spam, so sent whole");
  });

  it("uses a label someone else created between listing and creating it", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    const fetchRacing = async (input: string, init: RequestInit) => {
      if (init.method === "POST" && input.endsWith("/labels")) fake.mailbox.createLabel("Usual Mail/Receipts", {});
      return fake.fetch(input, init);
    };
    const provider = createGmailProvider(fake.credentials, { fetch: fetchRacing });
    const message = await fake.deliver(mail("Race").raw);
    const [result] = await provider.apply([{ op: "place", ref: message.id, inInbox: false, category: "receipt", screened: false }]);
    assert.ok(result?.ok, result?.error);
    const receipts = [...fake.mailbox.labels.values()].find((l) => l.name === "Usual Mail/Receipts")!;
    assert.ok(fake.mailbox.messages.get(message.id)!.labelIds.has(receipts.id));
  });
});

describe("Gmail rate limits", () => {
  it("backs off on 429 and on 403 rate-limit reasons, honouring Retry-After", async () => {
    const { fake, provider, sleeps } = setup();
    await fake.deliver(mail("Slow down").raw);
    fake.failNext(1, { status: 429, reason: "rateLimitExceeded", message: "Too many requests" });
    fake.failNext(1, { status: 403, reason: "userRateLimitExceeded", message: "User Rate Limit Exceeded", retryAfter: "7" });
    fake.failNext(1, { status: 503, reason: "backendError", message: "Backend Error" });
    const { subjects: got } = await subjects(provider, null);
    assert.deepEqual(got, ["Slow down"]);
    assert.equal(sleeps.length, 3);
    assert.ok(sleeps[0]! >= 1000 && sleeps[0]! < 2000, `first wait ${sleeps[0]}`);
    assert.ok(sleeps[1]! >= 7000, `Retry-After honoured: ${sleeps[1]}`);
    assert.ok(sleeps[2]! >= 4000 && sleeps[2]! < 5000, `third wait doubles: ${sleeps[2]}`);
  });

  it("gives up after the retries, and doesn't retry what waiting can't fix", async () => {
    const { fake, provider, sleeps } = setup({ maxRetries: 2 });
    fake.failNext(3, { status: 429, reason: "rateLimitExceeded" });
    await assert.rejects(provider.sync(null), /Gmail/);
    assert.equal(sleeps.length, 2);
    fake.failNext(1, { status: 403, reason: "dailyLimitExceeded", message: "Daily Limit Exceeded" });
    await assert.rejects(provider.sync(null), /daily Gmail quota/);
    assert.equal(sleeps.length, 2, "no wait for a daily limit");
  });

  it("spends quota units at the configured pace", async () => {
    const { fake, provider, sleeps } = setup({ quotaPerSecond: 100 });
    for (let i = 0; i < 20; i++) await fake.deliver(mail(`Q${i}`).raw);
    await syncAll(provider, null);
    // 20 raw gets at 60 units, plus a profile, a label list and a message list: about 1,207 units.
    // The bucket starts with 750 and refills 100 a second, so about 4.6 seconds of waiting.
    const waited = sleeps.reduce((sum, ms) => sum + ms, 0);
    assert.ok(waited >= 4000 && waited <= 6000, `waited ${waited} ms`);
  });
});
