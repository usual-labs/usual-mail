// What the interfaces asked the contract for (docs/contract.md, "Words", "Lists", "REST"): a thread names its sender
// and who decided its category by name, and one category list can merge several categories.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Category, Inbox, Thread } from "@usualmail/core";
import { createApp } from "../src/rest/app.ts";
import { HOUR, historyFromKnown, KNOWN, makeServer, START, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

const ago = (ms: number) => new Date(Date.parse(START) - ms).toISOString();

async function inbox(trust: Inbox["trust"] = "act_with_undo"): Promise<Inbox> {
  return (await t.connect({ address: "me@fields.example", history: [historyFromKnown], trust, agentAccess: true })).inbox;
}

describe("a thread names its sender", () => {
  test("the sender of its oldest incoming message, lower case; none for a thread of the mailbox's own mail only", async () => {
    const box = await inbox();
    const mailbox = t.mailboxes.get(box.address)!;
    mailbox.deliver({ from: { email: box.address }, to: [KNOWN], subject: "I wrote first", outgoing: true, messageId: "first@fields.example", date: ago(2 * HOUR) });
    await t.sync(box);
    const own = await t.threadBySubject("I wrote first");
    assert.equal("sender" in own, false, "only the mailbox's own mail: no sender");
    mailbox.deliver({ from: { name: "Dana", email: "Dana@Lumen.example" }, subject: "Re: I wrote first", inReplyTo: "first@fields.example", date: ago(HOUR) });
    mailbox.deliver({ from: { name: "Someone Else", email: "else@lumen.example" }, subject: "Re: I wrote first", inReplyTo: "first@fields.example", date: ago(0) });
    await t.sync(box);
    assert.equal((await t.threadBySubject("I wrote first")).sender, "dana@lumen.example", "its oldest incoming message's sender, lower case");
  });
});

describe("who decided a category, by name", () => {
  test("the AI with its model, a rule, an agent with its name, the person's device; nobody for the mailbox", async () => {
    const box = await inbox();
    await t.aiOn();
    t.models.choose = () => "newsletter";
    const byAi = await t.receive(box, { from: KNOWN, subject: "By the AI" });
    assert.deepEqual(byAi.categorizedByActor, { kind: "ai", job: "categorize", model: "fake/categorize" });

    const rule = await t.server.createRule(t.person, { inboxId: box.id, text: "Receipts from the shop", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }] });
    const byRule = await t.receive(box, { from: { email: "orders@shop.example" }, subject: "By a rule" });
    assert.deepEqual([byRule.categorizedBy, byRule.categorizedByActor], ["rule", { kind: "rule", ruleId: rule.id }]);

    const agent = await t.agent([box.id], "Sorting Agent");
    const decided = await t.server.decide(agent.caller, [{ threadId: byAi.id, category: "invoice", reason: "It asks to be paid" }]);
    assert.deepEqual(decided.threads[0]!.categorizedByActor, agent.caller.actor);
    assert.equal((agent.caller.actor as { name: string }).name, "Sorting Agent");

    const acted = await t.server.act(t.person, { threadIds: [byRule.id], action: { kind: "categorize", category: "notification" } });
    assert.deepEqual(acted.threads[0]!.categorizedByActor, t.person.actor);
    const undone = await t.server.undo(t.person, acted.records[0]!.id);
    assert.deepEqual([undone.threads[0]!.categorizedBy, undone.threads[0]!.categorizedByActor], ["person", t.person.actor], "undoing decides it: whoever undid it");

    const filed = await t.receive(box, { from: KNOWN, subject: "Filed", placement: { inInbox: false, category: "receipt" } });
    assert.deepEqual([filed.categorizedBy, "categorizedByActor" in filed], ["mailbox", false]);
    const event = await t.server.thread(t.person, byAi.id);
    assert.deepEqual(event.thread.categorizedByActor, agent.caller.actor, "the thread as read carries it too");
  });

  test("a proposal names its proposer, and a refused write-back puts the name back with the category", async () => {
    const box = await inbox("suggest");
    const agent = await t.agent([box.id], "Proposing Agent");
    const thread = await t.receive(box, { from: KNOWN, subject: "Proposed" });
    const proposed = await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } });
    assert.deepEqual([proposed.threads[0]!.categorizedBy, proposed.threads[0]!.categorizedByActor], ["agent", agent.caller.actor]);

    const other = await t.receive(box, { from: KNOWN, subject: "Refused" });
    const mailbox = t.mailboxes.get(box.address)!;
    mailbox.refuse = () => "No";
    const acted = await t.server.act(t.person, { threadIds: [other.id], action: { kind: "categorize", category: "receipt" } });
    assert.deepEqual(acted.threads[0]!.categorizedByActor, t.person.actor);
    await t.server.whenIdle();
    const back = (await t.server.thread(t.person, other.id)).thread;
    assert.deepEqual([back.category, back.categorizedBy, "categorizedByActor" in back], ["unknown", undefined, false]);
  });
});

describe("one list for several categories", () => {
  async function filed(box: Inbox): Promise<Thread[]> {
    const made: Thread[] = [];
    const kinds: Array<[Category, number]> = [["invoice", 5], ["receipt", 4], ["invoice", 3], ["newsletter", 2], ["receipt", 1]];
    for (const [category, hours] of kinds) {
      made.push(await t.receive(box, { from: KNOWN, subject: `${category} ${hours}`, date: ago(hours * HOUR), placement: { inInbox: false, category: category as "invoice" } }));
    }
    return made;
  }

  test("merges them newest first, and its cursors run across all of them", async () => {
    const box = await inbox();
    await filed(box);
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await t.server.category(t.person, ["invoice", "receipt"], { limit: 1, ...(cursor && { cursor }) });
      all.push(...page.items.map((thread) => thread.subject));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(all, ["receipt 1", "invoice 3", "receipt 4", "invoice 5"]);
    const one = await t.server.category(t.person, "invoice", {});
    assert.deepEqual(one.items.map((thread) => thread.subject), ["invoice 3", "invoice 5"], "one category as before");
  });

  test("REST takes them joined by commas; anything not a category is invalid", async () => {
    const box = await inbox();
    await filed(box);
    const app = createApp(t.server, { scheduler: t.clock, log: { info: () => {}, error: () => {} } });
    const get = async (path: string) => {
      const response = await app.request(path, { headers: { authorization: `Bearer ${t.personToken}` } });
      return { status: response.status, body: await response.json() as { items: Thread[]; nextCursor?: string } };
    };
    const first = await get("/v1/categories/invoice,receipt?limit=3");
    assert.deepEqual(first.body.items.map((thread) => thread.subject), ["receipt 1", "invoice 3", "receipt 4"]);
    const rest = await get(`/v1/categories/invoice,receipt?limit=3&cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    assert.deepEqual(rest.body.items.map((thread) => thread.subject), ["invoice 5"]);
    assert.equal((await get("/v1/categories/receipt,newsletter,receipt")).body.items.length, 3, "a category named twice counts once");
    for (const bad of ["invoice,spam", "invoice,", ",receipt", "invoice,,receipt"]) {
      assert.equal((await get(`/v1/categories/${bad}`)).status, 400, bad);
    }
  });
});
