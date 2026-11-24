/**
 * How far a Gmail first sync has got (docs/contract-sync.md, "How far a first sync has got"; the owner's decision of
 * 2026-11-23): every batch of the first sync carries `progress`, counted from the cursor, so it goes on across calls,
 * a new provider (a restart) and a smaller window; `onProgress` says it once the window is listed and after each
 * message, since Gmail's quota fetches about one a second.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SyncProgress } from "@usualmail/core";
import { createGmailProvider } from "../../src/index.ts";
import { decodeGmailCursor, encodeGmailCursor } from "../../src/gmail/cursor.ts";
import { FakeGmail, plainMessage, syncAll } from "../../src/testing/index.ts";

const ADDRESS = "me@mail.example";
const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-11-16T09:00:00Z");

function setup() {
  const clock = { now: () => START, sleep: async () => {} };
  const fake = new FakeGmail({ address: ADDRESS, now: clock.now });
  const open = (days?: number) =>
    createGmailProvider(fake.credentials, {
      fetch: fake.fetch,
      clock,
      quotaPerSecond: 1_000_000,
      ...(days !== undefined && { since: new Date(START - days * DAY).toISOString() }),
    });
  return { fake, open };
}

const mail = (subject: string) => plainMessage({ from: "Cy <cy@people.example>", to: ADDRESS, subject }).raw;

describe("Gmail first sync progress", () => {
  it("carries how far it has got on every batch of the first sync, the last included, and on no later batch", async () => {
    const { fake, open } = setup();
    for (let i = 0; i < 7; i++) await fake.deliver(mail(`M${i}`), ["INBOX"], START - (7 - i) * 60_000);
    await fake.deliver(mail("A draft"), ["DRAFT"]);
    const first = await syncAll(open(), null, 3);
    assert.deepEqual(first.log.map((batch) => batch.progress), [{ sent: 3, total: 7 }, { sent: 6, total: 7 }, { sent: 7, total: 7 }],
      "messages, not drafts, counted from the listing");
    await fake.deliver(mail("New mail"));
    const later = await syncAll(open(), first);
    assert.deepEqual(later.log.map((batch) => batch.progress), [undefined], "a later sync says nothing");
  });

  it("counts on from the cursor in a new provider, as after a restart", async () => {
    const { fake, open } = setup();
    for (let i = 0; i < 5; i++) await fake.deliver(mail(`M${i}`), ["INBOX"], START - (5 - i) * 60_000);
    const first = await syncAll(open(), null, { limit: 2, batches: 1 });
    assert.deepEqual(first.log[0]!.progress, { sent: 2, total: 5 });
    const rest = await syncAll(open(), first, 2);
    assert.deepEqual(rest.log.map((batch) => batch.progress), [{ sent: 4, total: 5 }, { sent: 5, total: 5 }]);
  });

  it("says so once the window is listed, then after each message, this batch's included", async () => {
    const { fake, open } = setup();
    for (let i = 0; i < 5; i++) await fake.deliver(mail(`M${i}`), ["INBOX"], START - (5 - i) * 60_000);
    const provider = open();
    const heard: SyncProgress[] = [];
    const onProgress = (progress: SyncProgress) => heard.push({ ...progress });
    const first = await provider.sync(null, { limit: 3, onProgress });
    assert.deepEqual(heard, [{ sent: 0, total: 5 }, { sent: 1, total: 5 }, { sent: 2, total: 5 }, { sent: 3, total: 5 }]);
    assert.deepEqual(first.progress, { sent: 3, total: 5 });
    heard.length = 0;
    const second = await provider.sync(first.cursor, { limit: 3, onProgress });
    assert.deepEqual(heard, [{ sent: 4, total: 5 }, { sent: 5, total: 5 }]);
    assert.deepEqual([second.progress, second.more], [{ sent: 5, total: 5 }, false]);
    heard.length = 0;
    await fake.deliver(mail("New mail"));
    const later = await provider.sync(second.cursor, { onProgress });
    assert.deepEqual([heard, later.progress], [[], undefined], "nothing once the first sync is done");
  });

  it("a smaller window lowers the total; what was sent stays counted; a larger one doesn't raise it", async () => {
    const { fake, open } = setup();
    for (const days of [25, 10, 5, 2, 1]) await fake.deliver(mail(`${days} days old`), ["INBOX"], START - days * DAY + 60_000);
    const first = await syncAll(open(30), null, { limit: 1, batches: 1 });
    assert.deepEqual(first.log[0]!.progress, { sent: 1, total: 5 });
    const smaller = await syncAll(open(7), first, { limit: 1, batches: 1 });
    assert.deepEqual(smaller.log[0]!.progress, { sent: 2, total: 3 }, "the 10 and 25 days old mail is no longer to fetch");
    const rest = await syncAll(open(60), smaller, 1);
    assert.deepEqual(rest.log.map((batch) => batch.progress), [{ sent: 3, total: 3 }]);
  });

  it("a smaller window that leaves nothing to fetch ends the count at what was sent", async () => {
    const { fake, open } = setup();
    for (const days of [25, 10, 1]) await fake.deliver(mail(`${days} days old`), ["INBOX"], START - days * DAY + 60_000);
    const first = await syncAll(open(30), null, { limit: 1, batches: 1 });
    assert.deepEqual(first.log[0]!.progress, { sent: 1, total: 3 });
    const smaller = await syncAll(open(7), first, 1);
    assert.deepEqual(smaller.log.map((batch) => batch.progress), [{ sent: 1, total: 1 }]);
    const cursor = decodeGmailCursor(smaller.cursor);
    assert.deepEqual([cursor.f, cursor.w, cursor.n, cursor.p], [undefined, undefined, undefined, undefined], "the listing's marks are gone");
    await fake.deliver(mail("New mail"));
    const later = await syncAll(open(7), smaller);
    assert.deepEqual(later.log.map((batch) => batch.progress), [undefined]);
  });

  it("an empty window is one batch, 0 of 0", async () => {
    const { open } = setup();
    const heard: SyncProgress[] = [];
    const batch = await open(30).sync(null, { onProgress: (progress) => heard.push(progress) });
    assert.deepEqual([batch.progress, batch.more], [{ sent: 0, total: 0 }, false]);
    assert.deepEqual(heard, [{ sent: 0, total: 0 }]);
  });

  it("a first sync begun by a build that didn't count starts its count from there", async () => {
    const { fake, open } = setup();
    for (let i = 0; i < 4; i++) await fake.deliver(mail(`M${i}`), ["INBOX"], START - (4 - i) * 60_000);
    const first = await open().sync(null, { limit: 1 });
    const uncounted = decodeGmailCursor(first.cursor);
    delete uncounted.n;
    const next = await open().sync(encodeGmailCursor(uncounted), { limit: 1 });
    assert.deepEqual(next.progress, { sent: 1, total: 3 }, "of what was left when it took over");
  });
});
