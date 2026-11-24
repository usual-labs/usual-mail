// Blocked senders as a person's Settings lists them, and letting one in again by address (docs/contract.md, "Blocked
// senders"; the owner's request of 2026-11-20: "showing the blocked senders in a separate tab and unblock them or see
// how many emails they've sent so far which has been blocked"). Made-up mail only.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { BlockedSender, Inbox, MailEvent, Thread } from "@usualmail/core";
import { iso } from "../src/util.ts";
import { HOUR, historyFromKnown, KNOWN, listen, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
let inbox: Inbox;
beforeEach(async () => {
  t = await makeServer();
  inbox = (await t.connect({ address: "me@senders.example", agentAccess: true, history: [historyFromKnown] })).inbox;
});
afterEach(() => t.close());

const DEALS = { name: "BrightBuy Deals", email: "Deals@BrightBuy.example" };
const PITCH = { name: "Growthpipe", email: "sales@growthpipe.example" };
const block = async (thread: Thread) => (await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "block_sender" } })).records[0]!;
const blocked = async (query: Parameters<TestServer["server"]["senders"]>[1] = {}) => (await t.server.senders(t.person, query)).items;
const changes = (events: MailEvent[]) => events.filter((event): event is Extract<MailEvent, { type: "sender.changed" }> => event.type === "sender.changed");

describe("the blocked senders", () => {
  test("are listed for a person with who blocked them, since when, and how many of their messages came since", async () => {
    const first = await t.receive(inbox, { from: DEALS, subject: "Sale" });
    await t.tick(HOUR);
    const blockedAt = t.clock.now();
    await block(first);
    assert.deepEqual(await blocked(), [{
      inboxId: inbox.id, address: "deals@brightbuy.example", name: "BrightBuy Deals", blockedAt: iso(blockedAt), blockedBy: t.person.actor,
      messagesSinceBlocked: 0, lastMessageAt: first.lastMessageAt,
    } satisfies BlockedSender], "nothing since: the mail from before the block isn't counted");
    await t.tick(HOUR);
    const second = await t.receive(inbox, { from: DEALS, subject: "Sale extended" });
    await t.receive(inbox, { from: { email: "deals@brightbuy.example" }, subject: "Last chance" });
    // Into someone else's conversation: stored, shown to nobody, counted.
    const chat = await t.receive(inbox, { from: KNOWN, subject: "Lunch", messageId: "lunch@lumen.example" });
    await t.tick(HOUR);
    t.mailboxes.get(inbox.address)!.deliver({ from: DEALS, subject: "Re: Lunch", text: "Buy now", inReplyTo: "lunch@lumen.example" });
    await t.sync(inbox);
    const [item] = await blocked();
    assert.deepEqual([item!.messagesSinceBlocked, item!.lastMessageAt, item!.name], [3, iso(t.clock.now()), "BrightBuy Deals"]);
    assert.deepEqual([second.done, (await t.server.thread(t.person, chat.id)).thread.messageCount], [true, 1], "blocked mail arrives done, and changes nothing in someone else's thread");
  });

  test("come newest block first, for the inboxes asked, a page at a time; no other state can be listed", async () => {
    const other = (await t.connect({ address: "shop@senders.example", history: [historyFromKnown] })).inbox;
    await block(await t.receive(inbox, { from: DEALS, subject: "Sale" }));
    await t.tick(HOUR);
    await block(await t.receive(other, { from: PITCH, subject: "Quick question" }));
    await t.tick(HOUR);
    await block(await t.receive(inbox, { from: { email: "noreply@spamly.example" }, subject: "Hi" }));
    assert.deepEqual((await blocked()).map((item) => [item.inboxId, item.address, item.name]),
      [[inbox.id, "noreply@spamly.example", undefined], [other.id, "sales@growthpipe.example", "Growthpipe"], [inbox.id, "deals@brightbuy.example", "BrightBuy Deals"]]);
    assert.deepEqual((await blocked({ inboxId: other.id })).map((item) => item.address), ["sales@growthpipe.example"]);
    const page = await t.server.senders(t.person, { state: "blocked", limit: 2 });
    assert.deepEqual([page.items.map((item) => item.address), typeof page.nextCursor], [["noreply@spamly.example", "sales@growthpipe.example"], "string"]);
    const rest = await t.server.senders(t.person, { limit: 2, cursor: page.nextCursor! });
    assert.deepEqual([rest.items.map((item) => item.address), rest.nextCursor], [["deals@brightbuy.example"], undefined]);
    await assert.rejects(t.server.senders(t.person, { state: "known" as never }), { code: "invalid" });
    await assert.rejects(t.server.senders(t.person, { inboxId: "inb_missing" }), { code: "not_found" });
  });

  test("are a person's to see and to let in: an agent is told so, even for an inbox it may read", async () => {
    await block(await t.receive(inbox, { from: DEALS, subject: "Sale" }));
    const agent = await t.agent([inbox.id]);
    await assert.rejects(t.server.senders(agent.caller, {}), { code: "needs_person" });
    await assert.rejects(t.server.allowSender(agent.caller, { inboxId: inbox.id, address: DEALS.email }), { code: "needs_person" });
    assert.equal((await blocked()).length, 1);
  });
});

describe("letting a blocked sender in by address", () => {
  test("does what allow_sender on their thread does: recorded on their newest thread, undoable; done mail stays done, later mail is let in", async () => {
    const first = await t.receive(inbox, { from: DEALS, subject: "Sale" });
    await block(first);
    await t.tick(HOUR);
    const during = await t.receive(inbox, { from: DEALS, subject: "Sale extended" });
    assert.deepEqual([during.done, during.screened], [true, true], "arrived done, its sender not let in");
    const result = await t.server.allowSender(t.person, { inboxId: inbox.id, address: "DEALS@brightbuy.example" });
    const record = result.records[0]!;
    assert.deepEqual([result.records.length, record.action, record.actor, record.state, record.undoable, record.threadId],
      [1, { kind: "allow_sender" }, t.person.actor, "applied", true, during.id]);
    assert.deepEqual(await blocked(), []);
    const after = async (id: string) => (await t.server.thread(t.person, id)).thread;
    assert.deepEqual([(await after(first.id)).done, (await after(during.id)).done, (await after(during.id)).screened], [true, true, false],
      "what the block made done stays done; nothing is screened any more");
    assert.deepEqual((await t.server.home(t.person, {})).items.map((thread) => thread.id), [], "nothing comes back to Home by itself");
    // A person's own action: recorded and undoable like `allow_sender` on a thread, and like it not listed in Handled,
    // which holds what rules, agents and the AI did.
    assert.ok(!(await t.server.handled(t.person, {})).items.some((item) => item.record.id === record.id));
    const later = await t.receive(inbox, { from: DEALS, subject: "New season" });
    assert.deepEqual([later.done, later.screened], [false, false], "mail after it is let in: neither done nor screened");

    await t.tick(HOUR);
    const undone = await t.server.undo(t.person, record.id);
    assert.equal(undone.records[0]!.state, "undone");
    const [again] = await blocked();
    assert.deepEqual([again!.address, again!.blockedAt, again!.blockedBy, again!.messagesSinceBlocked], ["deals@brightbuy.example", iso(t.clock.now()), t.person.actor, 0],
      "blocked again from the undo on: the mail let in meanwhile isn't counted as blocked");
  });

  test("with no thread of theirs left to record it on, they are let in without a record; a sender who isn't blocked is treated as on a thread", async () => {
    const only = await t.receive(inbox, { from: DEALS, subject: "Sale" });
    await block(only);
    await t.server.act(t.person, { threadIds: [only.id], action: { kind: "trash" } });
    const result = await t.server.allowSender(t.person, { inboxId: inbox.id, address: DEALS.email });
    assert.deepEqual([result.records, result.threads], [[], []]);
    assert.deepEqual(await blocked(), []);
    assert.equal((await t.receive(inbox, { from: DEALS, subject: "Again" })).screened, false, "let in");

    const stranger = await t.receive(inbox, { from: PITCH, subject: "Quick question" });
    assert.equal(stranger.screened, true);
    const allowed = await t.server.allowSender(t.person, { inboxId: inbox.id, address: PITCH.email });
    assert.deepEqual([allowed.records[0]!.action.kind, allowed.threads.map((thread) => [thread.id, thread.screened])], ["allow_sender", [[stranger.id, false]]]);
    assert.deepEqual((await t.server.allowSender(t.person, { inboxId: inbox.id, address: PITCH.email })).records, [], "already let in: nothing to do, no record");
    await assert.rejects(t.server.allowSender(t.person, { inboxId: "inb_missing", address: PITCH.email }), { code: "not_found" });
    await assert.rejects(t.server.allowSender(t.person, { inboxId: inbox.id, address: "not an address" }), { code: "invalid" });
  });
});

describe("sender.changed", () => {
  test("tells people's devices when a sender is blocked or let in again, by any way, and when blocked mail arrives; never an agent", async () => {
    const agent = await t.agent([inbox.id]);
    const first = await t.receive(inbox, { from: DEALS, subject: "Sale" });
    const heard = listen(t);
    const overheard = listen(t, agent.caller);
    const blockedAt = t.clock.now();
    await block(first);
    await t.tick(HOUR);
    await t.receive(inbox, { from: DEALS, subject: "Sale extended" });
    const allow = (await t.server.allowSender(t.person, { inboxId: inbox.id, address: DEALS.email })).records[0]!;
    await t.server.undo(t.person, allow.id);
    await t.server.whenIdle();
    heard.stop();
    overheard.stop();
    const told = changes(heard.events);
    assert.deepEqual(told.map((event) => [event.inboxId, event.address, event.blocked, event.sender?.messagesSinceBlocked]), [
      [inbox.id, "deals@brightbuy.example", true, 0],
      [inbox.id, "deals@brightbuy.example", true, 1],
      [inbox.id, "deals@brightbuy.example", false, undefined],
      [inbox.id, "deals@brightbuy.example", true, 0],
    ], "blocked on a thread, blocked mail arriving, let in by address, the letting-in undone");
    assert.deepEqual(told[0]!.sender, {
      inboxId: inbox.id, address: "deals@brightbuy.example", name: "BrightBuy Deals", blockedAt: iso(blockedAt), blockedBy: t.person.actor,
      messagesSinceBlocked: 0, lastMessageAt: first.lastMessageAt,
    });
    assert.deepEqual(changes(overheard.events), []);
  });
});
