// The decisions taken after the first milestone's final review: every list in the contract's order (the whole second
// it publishes, then id, descending) also across a page boundary; a draft left `sending` by a stop fails at the next
// start; and a person's own refused write-back is part of what needs a look.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Caller, MailEvent, Page } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { drafts } from "../src/db/index.ts";
import { createApp } from "../src/rest/app.ts";
import { at, HOUR, historyFromKnown, KNOWN, listen, makeServer, START, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => (t = await makeServer()));
afterEach(async () => t.close());

const TOMAS = { name: "Tomas", email: "tomas@brightfield.example" };
const SECOND = Date.parse(START);

/** Every item of a list, read `limit` at a time through its cursors. */
async function everyPage<T>(read: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 50; pages++) {
    const page = await read(cursor);
    items.push(...page.items);
    if (!page.nextCursor) return items;
    cursor = page.nextCursor;
  }
  throw new Error("The list kept going");
}

describe("lists in the contract's order", () => {
  test("Handled orders records made in one second by id, descending, also across pages", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", trust: "suggest", agentAccess: true, history: [historyFromKnown] });
    const agent = await t.agent([inbox.id]);
    const threads = [];
    for (const n of [1, 2, 3]) threads.push(await t.receive(inbox, { from: KNOWN, subject: `Digest ${n}`, date: at(-HOUR + n) }));
    const proposals = [];
    for (const thread of threads) {
      proposals.push((await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" }, reason: "A digest" })).records[0]!);
    }
    // Approved in the reverse order, a tenth of a second apart, all within one second: each record's time becomes its
    // approval time, so the milliseconds run against the ids.
    for (const proposal of [...proposals].reverse()) {
      t.clock.advance(100);
      await t.server.approve(t.person, [proposal.id]);
    }
    const ids = proposals.map((p) => p.id).sort().reverse();
    const handled = await t.server.handled(t.person, {});
    assert.deepEqual(new Set(handled.items.map((i) => i.record.at)).size, 1, "all published in the same second");
    assert.deepEqual(handled.items.map((i) => i.record.id), ids, "equal times by id, descending");
    for (const limit of [1, 2]) {
      const paged = await everyPage((cursor) => t.server.handled(t.person, { limit, ...(cursor && { cursor }) }));
      assert.deepEqual(paged.map((i) => i.record.id), ids, `pages of ${limit}: nothing skipped or repeated`);
    }
  });

  test("Home, a category and search order threads in one second by id, descending, also across pages; the triage queue reverses it", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    // The first thread's newest message is later in the second than the second thread's, so the milliseconds run
    // against the ids.
    const early = await t.receive(inbox, { from: KNOWN, subject: "Late in the second", date: new Date(SECOND - HOUR + 900).toISOString() });
    const late = await t.receive(inbox, { from: KNOWN, subject: "Early in the second", date: new Date(SECOND - HOUR + 100).toISOString() });
    assert.ok(early.id < late.id);
    assert.equal(early.lastMessageAt, late.lastMessageAt, "the same whole second");
    const want = [late.id, early.id];
    const ours = (ids: string[]) => ids.filter((id) => want.includes(id));
    assert.deepEqual(ours((await t.server.home(t.person, {})).items.map((x) => x.id)), want);
    assert.deepEqual(ours((await t.server.category(t.person, "unknown", {})).items.map((x) => x.id)), want);
    assert.deepEqual(ours((await t.server.search(t.person, { q: "in the second" })).items.map((x) => x.id)), want);
    assert.deepEqual(ours(await everyPage(async (cursor) => {
      const page = await t.server.home(t.person, { limit: 1, ...(cursor && { cursor }) });
      return { ...page, items: page.items.map((x) => x.id) };
    })), want, "pages of one: nothing skipped or repeated");
    // The triage queue runs oldest first, so its order is the default one reversed: equal times by id, ascending. (No AI
    // is set up, so these undecided threads wait for an outside agent.)
    assert.deepEqual(ours((await t.server.triageQueue(t.person, {})).map((item) => item.thread.id)), [early.id, late.id]);
  });

  test("the waiting list orders threads coming back in one second by id, ascending, also across pages", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const a = await t.receive(inbox, { from: KNOWN, subject: "Back first", date: at(-2 * HOUR) });
    const b = await t.receive(inbox, { from: KNOWN, subject: "Back second", date: at(-HOUR) });
    const c = await t.receive(inbox, { from: KNOWN, subject: "Back sooner", date: at(-HOUR) });
    // a and b come back in the same whole second (asked with different milliseconds, kept as whole seconds); c comes
    // back a day sooner.
    await t.server.act(t.person, { threadIds: [a.id], action: { kind: "come_back", at: new Date(SECOND + 2 * 24 * HOUR + 900).toISOString() } });
    await t.server.act(t.person, { threadIds: [b.id], action: { kind: "come_back", at: new Date(SECOND + 2 * 24 * HOUR + 100).toISOString() } });
    await t.server.act(t.person, { threadIds: [c.id], action: { kind: "come_back", at: new Date(SECOND + 24 * HOUR).toISOString() } });
    const want = [c.id, a.id, b.id];
    assert.deepEqual((await t.server.waiting(t.person, {})).items.map((x) => x.id), want, "soonest first, equal times by id, ascending");
    const paged = await everyPage((cursor) => t.server.waiting(t.person, { limit: 1, ...(cursor && { cursor }) }));
    assert.deepEqual(paged.map((x) => x.id), want, "pages of one: nothing skipped or repeated");
  });

  test("drafts saved in one second are listed by id, descending, also across pages", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example" });
    const first = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [KNOWN], subject: "First", body: "One" });
    t.clock.advance(100);
    const second = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [KNOWN], subject: "Second", body: "Two" });
    t.clock.advance(100);
    await t.server.saveDraft(t.person, { id: first.id, inboxId: inbox.id, to: [KNOWN], subject: "First", body: "One, changed" });
    const want = [second.id, first.id];
    assert.deepEqual((await t.server.listDrafts(t.person, {})).items.map((d) => d.id), want);
    const paged = await everyPage((cursor) => t.server.listDrafts(t.person, { limit: 1, ...(cursor && { cursor }) }));
    assert.deepEqual(paged.map((d) => d.id), want);
  });
});

describe("a draft left sending by a stop", () => {
  test("fails at the next start, saying it may have gone out, and can be changed, sent or deleted again", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example" });
    const draft = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [KNOWN], subject: "Interrupted", body: "Hello" });
    // As the store holds it when the process stopped between `sending` and the provider's answer.
    await t.host.db.update(drafts).set({ state: "sending", version: draft.version + 1 }).where(eq(drafts.id, draft.id));
    // The next start, on the same store.
    await t.server.stop();
    const heard = listen(t);
    await t.server.start();
    heard.stop();
    const [failed] = (await t.server.listDrafts(t.person, {})).items;
    assert.equal(failed!.id, draft.id);
    assert.equal(failed!.state, "failed");
    assert.match(failed!.error!, /stopped while sending/);
    assert.match(failed!.error!, /may have gone out/);
    assert.match(failed!.error!, /Sent folder/);
    assert.ok(failed!.version > draft.version + 1, "the version rises");
    assert.deepEqual(heard.events.filter((e): e is Extract<MailEvent, { type: "draft.changed" }> => e.type === "draft.changed").map((e) => [e.draft.id, e.draft.state]), [[draft.id, "failed"]]);

    const changed = await t.server.saveDraft(t.person, { id: draft.id, inboxId: inbox.id, to: [KNOWN], subject: "Interrupted", body: "Hello again" });
    assert.equal(changed.state, "draft");
    const sent = await t.server.sendDraft(t.person, draft.id);
    assert.equal(sent.state, "sent");
    assert.equal(mailbox.sent.length, 1);
  });

  test("a failed draft from a stop can be deleted", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example" });
    const draft = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [KNOWN], subject: "Interrupted", body: "Hello" });
    await t.host.db.update(drafts).set({ state: "sending" }).where(eq(drafts.id, draft.id));
    await t.server.stop();
    await t.server.start();
    await t.server.deleteDraft(t.person, draft.id);
    assert.deepEqual((await t.server.listDrafts(t.person, {})).items, []);
  });
});

describe("a person's own refused write-back", () => {
  test("is in Handled with attentionOnly, not in Handled's ordinary list, and an agent sees it only where it may", async () => {
    const { inbox, mailbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const hidden = await t.connect({ address: "private@acme.example", history: [historyFromKnown] });
    const agent = await t.agent([inbox.id, hidden.inbox.id]);
    const news = await t.receive(inbox, { from: KNOWN, subject: "Lumen news", date: at(-HOUR) });
    const secret = await t.receive(hidden.inbox, { from: TOMAS, subject: "Private", date: at(-HOUR) });
    mailbox.refuse = (op) => (op.op === "place" && op.category === "newsletter" ? "Folder is read-only" : undefined);
    hidden.mailbox.refuse = () => "Mailbox is locked";
    const mine = (await t.server.act(t.person, { threadIds: [news.id], action: { kind: "categorize", category: "newsletter" } })).records[0]!;
    const theirs = (await t.server.act(t.person, { threadIds: [secret.id], action: { kind: "categorize", category: "receipt" } })).records[0]!;
    await t.server.whenIdle();

    const attention = await t.server.handled(t.person, { attentionOnly: true });
    assert.deepEqual(attention.items.map((i) => [i.record.id, i.record.state, i.record.error, i.record.actor.kind]).sort(), [
      [mine.id, "failed", "Folder is read-only", "person"],
      [theirs.id, "failed", "Mailbox is locked", "person"],
    ].sort());
    assert.equal(attention.items.find((i) => i.record.id === mine.id)!.thread.category, "unknown", "with its thread put back");
    assert.deepEqual((await t.server.handled(t.person, {})).items, [], "Handled's ordinary list stays rules', agents' and the AI's");
    assert.deepEqual((await t.server.handled(t.person, { states: ["failed"] })).items, []);
    const seen = (caller: Caller) => t.server.handled(caller, { attentionOnly: true }).then((page) => page.items.map((i) => i.record.id));
    assert.deepEqual(await seen(agent.caller), [mine.id], "an agent sees it only in an inbox it may see");

    const app = createApp(t.server, { scheduler: t.clock, log: t.host.log });
    const res = await app.request("/v1/handled?attentionOnly=true", { headers: { authorization: `Bearer ${t.personToken}` } });
    const body = await res.json() as { items: Array<{ record: { id: string } }> };
    assert.deepEqual(body.items.map((i) => i.record.id).sort(), [mine.id, theirs.id].sort());
  });
});
