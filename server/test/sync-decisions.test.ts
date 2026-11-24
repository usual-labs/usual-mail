// Two sync rules decided after the review (docs/contract-sync.md, "Sync"): a new server reads mail its first sync
// finds filed under a category as not done, so its category lists aren't empty (the whole synced window since
// 2026-11-18, as the AI's history is); and a blocked sender writing into an existing thread changes nothing a person
// sees.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Inbox, MailEvent } from "@usualmail/core";
import { DAY, HOUR, historyFromKnown, KNOWN, makeServer, START, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

const ago = (ms: number) => new Date(Date.parse(START) - ms).toISOString();

describe("a new server and already-filed mail", () => {
  test("a filed thread the first sync takes is not done, however old inside the synced window", async () => {
    await t.connect({
      address: "me@filed.example",
      history: [
        historyFromKnown,
        { from: { email: "news@weekly.example" }, subject: "Recent news", date: ago(2 * DAY), placement: { inInbox: false, category: "newsletter" } },
        { from: { email: "billing@shop.example" }, subject: "Old receipt", date: ago(10 * DAY), placement: { inInbox: false, category: "receipt" } },
        { from: { email: "billing@shop.example" }, subject: "Recent receipt", date: ago(6 * DAY), placement: { inInbox: false, category: "receipt" } },
        { from: KNOWN, subject: "Archived, no label", date: ago(2 * DAY), placement: { inInbox: false } },
        { from: { email: "who@screen.example" }, subject: "Old screened", date: ago(20 * DAY), placement: { inInbox: false, screened: true } },
      ],
    });
    const read = async (subject: string) => {
      const thread = await t.threadBySubject(subject);
      return [thread.category, thread.categorizedBy, thread.done, thread.screened];
    };
    assert.deepEqual(await read("Recent news"), ["newsletter", "mailbox", false, false]);
    assert.deepEqual(await read("Recent receipt"), ["receipt", "mailbox", false, false]);
    assert.deepEqual(await read("Old receipt"), ["receipt", "mailbox", false, false], "older than 7 days, inside the synced window: not done");
    assert.deepEqual(await read("Archived, no label"), ["unknown", undefined, true, false], "archived without a label is done, however recent");
    assert.deepEqual(await read("Old screened"), ["unknown", undefined, false, true], "under Screening: screened and not done, however old");
    assert.deepEqual(
      (await t.server.category(t.person, ["newsletter", "receipt"], {})).items.map((x) => x.subject),
      ["Recent news", "Recent receipt", "Old receipt"],
    );
    const counts = await t.server.counts(t.person);
    assert.deepEqual([counts.all.categories.newsletter, counts.all.categories.receipt], [1, 2]);
  });

  test("a shorter synced window is still the whole of it: the first sync's filed threads are not done", async () => {
    const short = await makeServer({ syncWindowDays: 3 });
    try {
      await short.connect({
        address: "me@short.example",
        history: [historyFromKnown, { from: { email: "news@weekly.example" }, subject: "Two days old", date: ago(2 * DAY), placement: { inInbox: false, category: "newsletter" } }],
      });
      assert.equal((await short.threadBySubject("Two days old")).done, false);
    } finally {
      await short.close();
    }
  });
});

describe("a blocked sender writing into an existing thread", () => {
  const ALICE = { name: "Alice Archer", email: "alice@people.example" };
  const MALLORY = { name: "Mallory", email: "mallory@blocked.example" };

  async function setUp(): Promise<Inbox> {
    const { inbox } = await t.connect({
      address: "me@quiet.example",
      history: [
        historyFromKnown,
        { from: MALLORY, subject: "Mallory's own", date: ago(5 * HOUR), placement: { inInbox: true } },
        { from: ALICE, subject: "Plans", text: "Shall we meet?", messageId: "plans@people.example", date: ago(3 * HOUR), seen: true, placement: { inInbox: true } },
      ],
    });
    const own = await t.threadBySubject("Mallory's own");
    await t.server.act(t.person, { threadIds: [own.id], action: { kind: "block_sender" } });
    return inbox;
  }

  test("changes nothing a person sees: not its place in a list, its snippet, its unread state or its messages", async () => {
    const inbox = await setUp();
    const before = await t.threadBySubject("Plans");
    const homeBefore = (await t.server.home(t.person, {})).items.map((x) => x.id);
    const events: MailEvent[] = [];
    const stop = t.server.subscribe(t.person, (event) => events.push(event));
    t.mailboxes.get(inbox.address)!.deliver({ from: MALLORY, subject: "Re: Plans", text: "Buy my stuff", inReplyTo: "plans@people.example", attachments: [{ id: "a1", filename: "offer.pdf", mimeType: "application/pdf", size: 10, inline: false }] });
    await t.sync(inbox);
    stop();
    const after = await t.threadBySubject("Plans");
    assert.deepEqual(after, before, "the thread is exactly as it was, version included");
    assert.deepEqual((await t.server.home(t.person, {})).items.map((x) => x.id), homeBefore, "its place in Home is the same");
    const detail = await t.server.thread(t.person, after.id);
    assert.deepEqual(detail.messages.map((m) => m.from.email), [ALICE.email], "her message isn't shown");
    assert.ok(!events.some((event) => event.type === "thread.changed" && event.thread.id === after.id), "no change is announced");
  });

  test("doesn't end a come-back-if-no-reply wait", async () => {
    const inbox = await setUp();
    const plans = await t.threadBySubject("Plans");
    const set = (await t.server.act(t.person, { threadIds: [plans.id], action: { kind: "come_back", at: ago(-DAY), ifNoReply: true } })).threads[0]!;
    await t.tick(60_000);
    const mailbox = t.mailboxes.get(inbox.address)!;
    mailbox.deliver({ from: MALLORY, subject: "Re: Plans", text: "Me again", inReplyTo: "plans@people.example" });
    await t.sync(inbox);
    assert.deepEqual(await t.threadBySubject("Plans"), set, "still waiting, exactly as it was");
    assert.deepEqual((await t.server.waiting(t.person, {})).items.map((x) => x.id), [plans.id]);
    // Someone else's reply still ends the wait.
    mailbox.deliver({ from: ALICE, subject: "Re: Plans", text: "Any news?", inReplyTo: "plans@people.example" });
    await t.sync(inbox);
    assert.equal((await t.threadBySubject("Plans")).comeBackAt, undefined, "a reply from someone else ends it");
  });
});
