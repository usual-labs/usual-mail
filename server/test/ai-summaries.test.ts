// What the server keeps of a summarize answer (docs/contract-ai.md, "Mail is untrusted input to a model"): the safety
// checks run on the whole answer and drop it; an answer over the limit is shortened, never dropped for its length;
// naming the sender doesn't drop it; a drop is logged with the thread's id and a reason code only. The prompt aims for
// one short line. And the upgrade of 2026-11-18 asks again for every summary an earlier build dropped.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Inbox } from "@usualmail/core";
import { eq, sql } from "drizzle-orm";
import { threads } from "../src/db/index.ts";
import { acceptSummary, shortenSummary, SUMMARY_AIM, SUMMARY_LIMIT } from "../src/ai/prompt.ts";
import { historyFromKnown, KNOWN, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

async function connected(): Promise<Inbox> {
  return (await t.connect({ address: "me@summaries.example", history: [historyFromKnown] })).inbox;
}

const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(" ");

describe("which answers are kept (acceptSummary)", () => {
  test("an answer that fits is kept as it is, its line breaks turned to spaces", () => {
    assert.deepEqual(acceptSummary("Asks you to confirm the renewal by Friday."), { summary: "Asks you to confirm the renewal by Friday." });
    assert.deepEqual(acceptSummary("Asks you to confirm\nthe renewal\r\nby Friday."), { summary: "Asks you to confirm the renewal by Friday." });
  });

  test("an answer over the limit keeps its first sentence when that fits", () => {
    const first = "Asks you to confirm the renewal by Friday.";
    const answer = `${first} Then ${words(40)}.`;
    assert.ok(answer.length > SUMMARY_LIMIT);
    assert.deepEqual(acceptSummary(answer), { summary: first });
    assert.deepEqual(acceptSummary(`${first}\nThen ${words(40)}.`), { summary: first }, "a line break between sentences too");
  });

  test("otherwise it is cut at the last word that fits, with an ellipsis, never past the limit", () => {
    const answer = `${words(60)}.`;
    const verdict = acceptSummary(answer);
    assert.ok("summary" in verdict);
    const kept = verdict.summary;
    assert.ok(kept.length <= SUMMARY_LIMIT, `${kept.length} characters`);
    assert.ok(kept.endsWith("…"));
    const body = kept.slice(0, -1);
    assert.ok(answer.startsWith(body) && answer[body.length] === " ", "cut where a word ends");
    assert.ok(body.length > SUMMARY_LIMIT / 2);
  });

  test("a sentence ends only before a capital, so an abbreviation doesn't end it", () => {
    const answer = `Lists e.g. the dates and rooms for the offsite, ${words(40)}.`;
    const verdict = acceptSummary(answer);
    assert.ok("summary" in verdict && verdict.summary.startsWith("Lists e.g. the dates") && verdict.summary.endsWith("…"));
    const bank = "U.S. Bank asks you to pay the March bill by Friday.";
    assert.deepEqual(acceptSummary(`${bank} Then ${words(40)}.`), { summary: bank }, "nor a short one before a capital");
  });

  test("one long word is cut at the limit", () => {
    assert.equal(shortenSummary("y".repeat(250)), `${"y".repeat(SUMMARY_LIMIT - 1)}…`);
  });

  test("the safety checks run on the whole answer: what the cut would remove still drops it", () => {
    const head = "Asks you to confirm the renewal by Friday.";
    const cases: Array<[string, string, string]> = [
      ["markup", `${head} ${words(40)} <b>bold</b>`, "markup"],
      ["an entity", `${head} ${words(40)} Terms &amp; conditions.`, "markup"],
      ["a control character", `${head} ${words(40)} \u0007`, "control"],
      ["a zero-width character", `${head} ${words(40)} a\u200bb`, "control"],
      ["the data block's marker", `${head} ${words(40)} usual-mail-data`, "marker"],
    ];
    for (const [what, answer, reason] of cases) {
      assert.ok(answer.length > SUMMARY_LIMIT, what);
      assert.deepEqual(acceptSummary(answer), { dropped: reason }, what);
    }
  });

  test("short answers that fail a check are dropped with their reason", () => {
    assert.deepEqual(acceptSummary(null), { dropped: "no_answer" });
    assert.deepEqual(acceptSummary("   \n "), { dropped: "empty" });
    assert.deepEqual(acceptSummary("A <b>bold</b> request."), { dropped: "markup" });
    assert.deepEqual(acceptSummary("Terms &amp; conditions changed."), { dropped: "markup" });
    assert.deepEqual(acceptSummary("Asks about the renewal.\u0007"), { dropped: "control" });
    assert.deepEqual(acceptSummary("See usual-mail-data for details."), { dropped: "marker" });
  });
});

describe("summaries on threads", () => {
  test("an over-long answer is stored shortened, and the thread isn't asked again", async () => {
    const inbox = await connected();
    await t.aiOn();
    const first = "Asks you to confirm the renewal by Friday.";
    t.models.write = () => `${first} Then ${words(40)}.`;
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Long answer" });
    assert.equal(thread.summary, first);
    const asked = t.models.sent("write").length;
    await t.server.updateAiSettings(t.person, { paused: false });
    await t.server.whenIdle();
    assert.equal(t.models.sent("write").length, asked);
  });

  test("a summary that names the sender is kept", async () => {
    const inbox = await connected();
    await t.aiOn();
    t.models.write = () => "Dana Whitfield asks about the renewal.";
    assert.equal((await t.receive(inbox, { from: KNOWN, subject: "Named" })).summary, "Dana Whitfield asks about the renewal.");
  });

  const dropped: Array<[string, string | null, string]> = [
    ["markup", "A <b>bold</b> request about the renewal.", "markup"],
    ["an entity", "Terms &amp; conditions changed.", "markup"],
    ["a control character", "Asks about the renewal.\u0007", "control"],
    ["the data block's marker", "See usual-mail-data for details.", "marker"],
    ["nothing at all", "   ", "empty"],
    ["no answer", null, "no_answer"],
  ];
  for (const [what, answer, reason] of dropped) {
    test(`a summary with ${what} is dropped, and the log says so with the thread's id and a reason only`, async () => {
      const inbox = await connected();
      await t.aiOn();
      t.models.write = () => answer;
      t.infos.length = 0;
      const thread = await t.receive(inbox, { from: KNOWN, subject: `Summary ${what}`, text: "Private words about the renewal." });
      assert.equal(thread.summary, undefined);
      const lines = t.infos.filter((line) => line.startsWith("AI summary"));
      assert.deepEqual(lines, [`AI summary for ${thread.id} dropped: ${reason}`]);
    });
  }

  test("the prompt aims for one short line", async () => {
    const inbox = await connected();
    await t.aiOn();
    await t.receive(inbox, { from: KNOWN, subject: "Aim" });
    const { instructions } = t.models.sent("write")[0]!.request;
    assert.match(instructions, /in one short line/);
    assert.ok(instructions.includes(`under about ${SUMMARY_AIM} characters`));
    assert.doesNotMatch(instructions, /two/);
  });
});

describe("the upgrade of 2026-11-18 (migration 0006)", () => {
  const upgrade = readFileSync(new URL("../migrations/0006_summaries_again.sql", import.meta.url), "utf8");

  test("asks again for a summary on every thread without one that isn't a one-time code, done, trashed or removed", async () => {
    const inbox = await connected();
    await t.aiOn();
    t.models.write = () => null;
    const subjects = ["Dropped", "Has one", "Code", "Done", "Trashed", "Removed"];
    const ids: Record<string, string> = {};
    for (const subject of subjects) ids[subject] = (await t.receive(inbox, { from: KNOWN, subject })).id;
    const set = (subject: string, values: Partial<typeof threads.$inferInsert>) =>
      t.host.db.update(threads).set(values).where(eq(threads.id, ids[subject]!));
    await set("Has one", { summary: "Asks about Friday." });
    await set("Code", { category: "otp", categorizedBy: "ai" });
    await set("Done", { done: true });
    await set("Trashed", { trashed: true });
    await set("Removed", { removed: true });
    await t.host.db.update(threads).set({ summaryDue: false });

    for (const statement of upgrade.split("--> statement-breakpoint")) await t.host.db.run(sql.raw(statement));

    const due = await t.host.db.select({ id: threads.id, due: threads.summaryDue }).from(threads);
    const dueOf = (subject: string) => due.find((row) => row.id === ids[subject])!.due;
    assert.deepEqual(subjects.map(dueOf), [true, false, false, false, false, false]);
    assert.equal((await t.server.aiStatus(t.person)).pending, 1, "and the status counts it");
  });
});
