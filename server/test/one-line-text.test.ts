// One line of text (schemas.ts): prose an agent or a person writes (decisions' and actions' reasons, a brief's
// highlights, a rule's text) is made one line, its control characters and line separators turned into spaces, so one
// reason with a line break doesn't refuse a whole batch; what names a device or an inbox, or matches mail, is still
// refused; and a teach prompt stored before names were cleaned still makes its rule.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ServiceError } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { teachPrompts } from "../src/db/index.ts";
import { asOneLine, check, prose } from "../src/service/schemas.ts";
import { at, HOUR, historyFromKnown, KNOWN, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => (t = await makeServer()));
afterEach(async () => t.close());

const code = (error: unknown) => (error instanceof ServiceError ? error.code : String(error));
/** Every kind of character `line()` refuses: C0, tab, DEL, C1 (NEL), the line and paragraph separators. */
const BREAKS = "\n\r\t\u0000\u001b\u007f\u0085  ";

describe("prose is made one line, not refused", () => {
  test("asOneLine turns control characters and separators into spaces, collapses runs and trims", () => {
    assert.equal(asOneLine(`  Looks${BREAKS}like\r\n\r\nnews  `), "Looks like news");
    assert.equal(asOneLine("Ünïcødé — “quotes” 🙂"), "Ünïcødé — “quotes” 🙂");
    assert.equal(check(prose(500), "two\nlines", "Reason"), "two lines");
    assert.throws(() => check(prose(500), BREAKS, "Reason"), (e) => code(e) === "invalid", "nothing left is empty, as before");
    // The limit counts the one line that is stored.
    assert.equal(check(prose(5), "a\n\nb\n\nc", "Reason"), "a b c");
    assert.throws(() => check(prose(4), "a\n\nb\n\nc", "Reason"), (e) => code(e) === "invalid");
  });

  test("a batch of decisions with one reason holding a line break is applied whole", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const threads = [];
    for (let i = 0; i < 3; i++) threads.push(await t.receive(inbox, { from: KNOWN, subject: `News ${i}`, date: at(-(i + 1) * HOUR) }));
    const agent = await t.agent([inbox.id]);
    const { threads: decided } = await t.server.decide(agent.caller, [
      { threadId: threads[0]!.id, category: "newsletter", reason: "A newsletter" },
      { threadId: threads[1]!.id, category: "newsletter", reason: "A weekly\nnewsletter from them" },
      { threadId: threads[2]!.id, category: "newsletter", reason: "News\t\u0000again" },
    ]);
    assert.deepEqual(decided.map((x) => [x.category, x.reason]), [
      ["newsletter", "A newsletter"],
      ["newsletter", "A weekly newsletter from them"],
      ["newsletter", "News again"],
    ]);
  });

  test("an action's reason, a brief's highlight and a rule's text are made one line too", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] });
    const news = await t.receive(inbox, { from: KNOWN, subject: "News", date: at(-HOUR) });
    const agent = await t.agent([inbox.id]);
    const moved = await t.server.act(agent.caller, { threadIds: [news.id], action: { kind: "categorize", category: "newsletter" }, reason: "Looks\r\nlike\u0085news" });
    assert.equal(moved.threads[0]!.reason, "Looks like news");

    const brief = await t.server.writeBrief(agent.caller, {
      from: at(-HOUR), to: at(HOUR),
      sections: [{ inboxId: inbox.id, highlights: [{ threadId: news.id, line: "Worth\na read. " }] }],
    });
    assert.equal(brief.sections[0]!.highlights[0]!.line, "Worth a read.");

    const rule = await t.server.createRule(t.person, { inboxId: inbox.id, text: "Shop\nreceipts", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }] });
    assert.equal(rule.text, "Shop receipts");
    assert.equal((await t.server.updateRule(t.person, rule.id, { text: "Shop\treceipts,\u007fdone" })).text, "Shop receipts, done");
  });
});

describe("names and what matches mail are still refused", () => {
  test("an inbox's name, a device's name and a rule's list id or subject words with a line break are invalid", async () => {
    await assert.rejects(t.connect({ address: "me@acme.example", name: "Work\nx" }), (e) => code(e) === "invalid");
    const { inbox } = await t.connect({ address: "me@acme.example" });
    await assert.rejects(t.server.updateInbox(t.person, inbox.id, { name: "Work x" }), (e) => code(e) === "invalid");
    const pairing = await t.server.createPairingCode(t.person, { kind: "person" });
    await assert.rejects(t.server.pair({ code: pairing.code, name: "Phone\rx" }), (e) => code(e) === "invalid");
    for (const match of [{ listId: "news.example\tx" }, { subjectContains: "sale\nnow" }]) {
      await assert.rejects(
        t.server.createRule(t.person, { inboxId: inbox.id, text: "Lists", match, then: [{ kind: "categorize", category: "newsletter" }] }),
        (e) => code(e) === "invalid",
        JSON.stringify(match),
      );
    }
  });
});

describe("teach prompts", () => {
  test("a sender's name with a line break is one line in a new prompt's question and rule", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: { name: "Tomas Brightfield\nNews", email: "tomas@brightfield.example" }, subject: "Hello", date: at(-HOUR) });
    const { teach } = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } });
    assert.match(teach!.question, /^Always treat mail from Tomas Brightfield News \(tomas@brightfield\.example\) as /);
    assert.equal((await t.server.answerTeach(t.person, teach!.id, true))!.text, teach!.rule.text);
  });

  test("a prompt stored before names were cleaned, with a control character in the name, still makes its rule", async () => {
    const { inbox } = await t.connect({ address: "me@acme.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: { name: "Tomas", email: "tomas@brightfield.example" }, subject: "Hello", date: at(-HOUR) });
    const { teach } = await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } });
    // As an earlier version stored it: the sender's name as it came, line break and all.
    const stored = { ...teach!.rule, text: teach!.rule.text.replace("Tomas", "Tomas\nEvil\u0085Corp") };
    await t.host.db.update(teachPrompts).set({ rule: stored, question: teach!.question.replace("Tomas", "Tomas\nEvil\u0085Corp") }).where(eq(teachPrompts.id, teach!.id));
    const rule = await t.server.answerTeach(t.person, teach!.id, true);
    assert.equal(rule!.text, teach!.rule.text.replace("Tomas", "Tomas Evil Corp"));
    assert.deepEqual(rule!.match, { from: "tomas@brightfield.example" });
  });
});
