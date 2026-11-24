// Older mail in the mailbox itself (docs/contract-search.md, "Older mail in the mailbox"), end to end through REST
// with the real Gmail provider against mail's fake of Gmail's API: what the server doesn't hold is found there, never
// stored, opened one conversation at a time, placed as the mailbox has it, and nothing is written to the mailbox.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createGmailProvider } from "@usualmail/mail";
import { FakeGmail } from "@usualmail/mail/testing";
import { eq } from "drizzle-orm";
import { inboxes } from "../src/db/index.ts";
import { REMOTE_PER_MINUTE } from "../src/search/remote.ts";
import { rawMail } from "./e2e/imap-server.ts";
import { DAY, startWorld, type Json, type World } from "./e2e/world.ts";

const ADDRESS = "me@gmail.example";
const DANA = "Dana Whitfield <dana@lumen.example>";
const SHOP = "Kestrel Roasters <billing@kestrel.example>";
let fake: FakeGmail;
let w: World;
let inbox: Json;
let next = 0;
const id = (name: string) => `${name}-${++next}@e2e.example`;

/** Mail the mailbox had long before the server: older than the first sync's 30 days. */
async function old(from: string, subject: string, daysAgo: number, labels: string[], extra: { inReplyTo?: string; messageId?: string; body?: string } = {}) {
  const at = w.clock.now() - daysAgo * DAY;
  await fake.deliver(rawMail({ from, to: ADDRESS, subject, messageId: extra.messageId ?? id("old"), date: new Date(at), ...extra }), labels, at);
}

beforeEach(async () => {
  fake = new FakeGmail({ address: ADDRESS });
  w = await startWorld({ gmail: (credentials, options) => createGmailProvider(credentials, { ...options, fetch: fake.fetch, quotaPerSecond: 1_000_000, maxRetries: 0 }) });
  await old(SHOP, "Receipt for your beans", 90, [], { body: "Kestrel coffee beans, 18.60 EUR, paid." });
  await old(DANA, "Question about the lease", 60, ["INBOX"], { body: "Could you look at the lease before Friday?" });
  await old("Spammy <win@junk.example>", "Kestrel prize", 70, ["SPAM"]);
  const start = id("start");
  await old(DANA, "Long project", 45, [], { messageId: start, body: "Kestrel offsite planning." });
  inbox = await w.ok("POST", "/v1/inboxes", { body: { name: "Gmail", color: "#1F8A5B", provider: "gmail", credentials: fake.credentials } });
  await w.idle();
  // A reply in the first sync's window: the server holds that conversation.
  await fake.deliver(rawMail({ from: DANA, to: ADDRESS, subject: "Re: Long project", messageId: id("reply"), inReplyTo: start, body: "Kestrel again." }), ["INBOX"]);
  await w.sync(inbox.id);
});
afterEach(async () => {
  await w.close();
});

const remote = (query: string, token?: string) => w.call("GET", `/v1/search/remote?${query}`, token === undefined ? {} : { token });

describe("searching the mailbox for older mail", () => {
  test("finds what the server doesn't hold, with stable ids, leaving out spam and what is held; stores nothing", async () => {
    assert.deepEqual((await w.ok("GET", "/v1/search?q=kestrel")).items.map((t: Json) => t.subject), ["Re: Long project"], "only the held conversation is local (its reply; its start is older than the window)");
    const answer = await w.ok("GET", "/v1/search/remote?q=kestrel");
    assert.deepEqual(answer.inboxes, [{ inboxId: inbox.id, state: "ok" }]);
    assert.deepEqual(answer.understood, { text: "kestrel" });
    assert.deepEqual(answer.items.map((hit: Json) => [hit.subject, hit.archived, hit.messageCount]), [["Receipt for your beans", true, 1]]);
    const [hit] = answer.items;
    assert.deepEqual(hit.from, { name: "Kestrel Roasters", email: "billing@kestrel.example" });
    assert.match(hit.lastMessageAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(hit.snippet, "Kestrel coffee beans, 18.60 EUR, paid.");
    assert.equal(hit.inboxId, inbox.id);
    const again = await w.ok("GET", "/v1/search/remote?q=beans&from=billing@kestrel.example");
    assert.equal(again.items[0].id, hit.id, "the same id for the same conversation, whatever the search");
    assert.deepEqual((await w.ok("GET", "/v1/search?q=beans")).items, [], "nothing was stored");
  });

  test("operators and filters go to Gmail in its own words, and pages carry on", async () => {
    await w.ok("GET", `/v1/search/remote?q=${encodeURIComponent('lease from:dana@lumen.example -"spam words" has:attachment')}&kinds=done`);
    const q = fake.requests.filter((r) => r.path === "/threads").at(-1)!.query.get("q");
    assert.equal(q, 'lease -"spam words" from:dana@lumen.example has:attachment -in:inbox -in:drafts -in:chats');
    for (let i = 0; i < 3; i++) await old(SHOP, `Weekly beans ${i}`, 100 + i, []);
    const first = await w.ok("GET", "/v1/search/remote?q=beans&limit=2");
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = await w.ok("GET", `/v1/search/remote?q=beans&limit=2&cursor=${first.nextCursor}`);
    const seen = [...first.items, ...second.items].map((hit: Json) => hit.subject);
    assert.equal(new Set(seen).size, seen.length, "nothing repeated");
  });

  test("opening brings the conversation in as the mailbox has it; again answers the same; nothing is written back", async () => {
    const before = await w.host.db.select({ cursor: inboxes.syncCursor }).from(inboxes).where(eq(inboxes.id, inbox.id)).get();
    const [archived] = (await w.ok("GET", "/v1/search/remote?q=beans")).items;
    fake.requests.length = 0;
    const opened = await w.ok("POST", `/v1/search/remote/${archived.id}/open`);
    assert.equal(opened.thread.subject, "Receipt for your beans");
    assert.equal(opened.thread.done, true, "archived there: done here, so only search shows it and the AI leaves it");
    assert.equal(opened.thread.screened, false, "an old thread isn't pushed into Screening");
    assert.deepEqual(opened.messages.map((m: Json) => m.text?.trim()), ["Kestrel coffee beans, 18.60 EUR, paid."]);
    assert.ok(fake.requests.every((r) => r.method === "GET"), "read-only at the mailbox");
    const twice = await w.ok("POST", `/v1/search/remote/${archived.id}/open`);
    assert.equal(twice.thread.id, opened.thread.id, "the same thread");
    await w.idle();
    assert.deepEqual((await w.ok("GET", "/v1/search?q=beans")).items.map((t: Json) => t.id), [opened.thread.id], "now held, and found locally");
    assert.deepEqual((await w.ok("GET", "/v1/search/remote?q=beans")).items, [], "and no longer remote");
    const after = await w.host.db.select({ cursor: inboxes.syncCursor }).from(inboxes).where(eq(inboxes.id, inbox.id)).get();
    assert.equal(after!.cursor, before!.cursor, "the sync's cursor untouched");
    await w.sync(inbox.id);
    assert.ok(!fake.requests.some((r) => r.method === "POST"), "a later sync writes nothing for it either");
  });

  test("an old thread still in the mailbox's inbox arrives not done, in Home, and its sender isn't let in by opening it", async () => {
    const [question] = (await w.ok("GET", "/v1/search/remote?q=lease")).items;
    assert.equal(question.archived, false);
    const opened = await w.ok("POST", `/v1/search/remote/${question.id}/open`);
    assert.deepEqual([opened.thread.done, opened.thread.screened, opened.thread.category], [false, false, "unknown"]);
    assert.ok((await w.ok("GET", "/v1/home")).items.some((t: Json) => t.id === opened.thread.id));
    // Dana was let in by the first sync's history (the reply); a stranger's old thread leaves its sender unknown.
    await old("Nobody <nobody@far.example>", "Very old hello", 200, ["INBOX"]);
    const [stranger] = (await w.ok("GET", "/v1/search/remote?q=hello")).items;
    const theirs = await w.ok("POST", `/v1/search/remote/${stranger.id}/open`);
    assert.deepEqual([theirs.thread.done, theirs.thread.screened], [false, false]);
    await fake.deliver(rawMail({ from: "Nobody <nobody@far.example>", to: ADDRESS, subject: "New mail", messageId: id("new") }), ["INBOX", "UNREAD"]);
    await w.sync(inbox.id);
    assert.equal((await w.thread("New mail")).screened, true, "their next new thread is screened as any stranger's");
  });

  test("person only; a rate limit per device; the mailbox refusing; a sign-in Google no longer accepts", async () => {
    const agent = await w.agent([inbox.id]);
    for (const res of [await remote("q=beans", agent), await w.call("POST", "/v1/search/remote/rem_x/open", { token: agent })]) {
      assert.deepEqual([res.status, res.body?.error?.code], [403, "needs_person"], JSON.stringify(res.body));
    }
    assert.deepEqual((await w.call("POST", "/v1/search/remote/made-up/open")).status, 404);
    fake.failNext(1, { status: 400, reason: "invalidArgument", message: "Invalid query", match: (_m, path) => path === "/threads" });
    const refused = await w.ok("GET", "/v1/search/remote?q=beans");
    assert.deepEqual(refused.inboxes, [{ inboxId: inbox.id, state: "provider_error", message: "Gmail: Invalid query" }]);
    fake.revokeGrant();
    const expired = await w.ok("GET", "/v1/search/remote?q=beans");
    assert.equal(expired.inboxes[0].state, "needs_sign_in");
    assert.match(expired.inboxes[0].message, /Connect the Gmail inbox again/);
    // Two asked above; the rest of the minute's allowance, then one more.
    for (let i = 2; i < REMOTE_PER_MINUTE; i++) assert.equal((await remote("q=beans")).status, 200);
    const limited = await remote("q=beans");
    assert.deepEqual([limited.status, limited.body.error.code], [429, "rate_limited"]);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    w.clock.advance(61_000);
    assert.equal((await remote("q=beans")).status, 200, "a minute later");
  });
});
