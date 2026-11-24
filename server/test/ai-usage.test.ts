// The AI's usage (docs/contract-ai.md, "Usage"; `GET /v1/ai/usage`): every request the server makes counts, by job and
// model, kept by the UTC hour and cut into today, the last 7 days and the last 30 days at the person's midnight. Only
// what the service reported is counted: tokens and cost are null when none was reported, and partial when only some
// requests reported them. Person only. Kept for 90 days.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AiUsageRow, Inbox } from "@usualmail/core";
import { aiUsage } from "../src/db/index.ts";
import { failure } from "../src/index.ts";
import { localMidnight } from "../src/ai/usage.ts";
import { createApp } from "../src/rest/app.ts";
import { DAY, HOUR, historyFromKnown, KNOWN, makeServer, START, TEST_KEY, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

async function connected(): Promise<Inbox> {
  return (await t.connect({ address: "me@usage.example", history: [historyFromKnown] })).inbox;
}

const reports = { inputTokens: 100, outputTokens: 20, costUsd: 0.0005 };
const row = (job: AiUsageRow["job"], model: string, fields: Partial<AiUsageRow>): AiUsageRow => ({
  job, model, requests: 0, failed: 0, inputTokens: null, outputTokens: null, tokensPartial: false, cost: null, costPartial: false, ...fields,
});

describe("what counts", () => {
  test("nothing yet: empty periods, kept since the server's first start, in UTC unless asked", async () => {
    const usage = await t.server.aiUsage(t.person, {});
    assert.deepEqual(usage, { since: START, timeZone: "UTC", periods: { today: [], last7Days: [], last30Days: [] } });
  });

  test("each request, by job and model, with what the service reported; a dropped summary and the key's test count too", async () => {
    const inbox = await connected();
    t.models.usage = () => reports;
    await t.aiOn(); // The key's test: one request per job.
    t.models.write = () => "Has <b>markup</b>, so it is dropped.";
    await t.receive(inbox, { from: KNOWN, subject: "First" });
    const { today } = (await t.server.aiUsage(t.person, {})).periods;
    assert.deepEqual(today, [
      row("categorize", "fake/categorize", { requests: 2, inputTokens: 200, outputTokens: 40, cost: { amount: 0.001, currency: "USD" } }),
      row("summarize", "fake/summarize", { requests: 2, inputTokens: 200, outputTokens: 40, cost: { amount: 0.001, currency: "USD" } }),
    ]);
  });

  test("a service that reports nothing: tokens and cost null, not 0; one that reports only some: partial", async () => {
    const inbox = await connected();
    await t.aiOn();
    await t.receive(inbox, { from: KNOWN, subject: "Nothing reported" });
    let rows = (await t.server.aiUsage(t.person, {})).periods.today;
    assert.deepEqual(rows.map((r) => [r.requests, r.inputTokens, r.outputTokens, r.tokensPartial, r.cost, r.costPartial]), [
      [2, null, null, false, null, false],
      [2, null, null, false, null, false],
    ]);
    t.models.usage = (kind) => (kind === "write" ? { inputTokens: 50, outputTokens: null, costUsd: null } : reports);
    await t.receive(inbox, { from: KNOWN, subject: "Some reported" });
    rows = (await t.server.aiUsage(t.person, {})).periods.today;
    assert.deepEqual(rows, [
      row("categorize", "fake/categorize", { requests: 3, inputTokens: 100, outputTokens: 20, tokensPartial: true, cost: { amount: 0.0005, currency: "USD" }, costPartial: true }),
      row("summarize", "fake/summarize", { requests: 3, inputTokens: 50, outputTokens: null, tokensPartial: true }),
    ]);
  });

  test("a failed request counts inside requests and as failed, with nothing reported", async () => {
    const inbox = await connected();
    t.models.usage = () => reports;
    await t.aiOn();
    t.models.failures.push(failure("unavailable"));
    await t.receive(inbox, { from: KNOWN, subject: "Fails" });
    const [categorize] = (await t.server.aiUsage(t.person, {})).periods.today;
    assert.deepEqual(categorize, row("categorize", "fake/categorize", {
      requests: 2, failed: 1, inputTokens: 100, outputTokens: 20, tokensPartial: true, cost: { amount: 0.0005, currency: "USD" }, costPartial: true,
    }));
  });

  test("a model changed in the period shows as two rows; a model the gateway says can't do the job was sent nothing", async () => {
    const inbox = await connected();
    await t.aiOn();
    await t.receive(inbox, { from: KNOWN, subject: "Before" });
    t.models.kinds = { "example/language": "language" };
    await t.server.updateAiSettings(t.person, { models: { categorize: "example/language" } });
    assert.equal((await t.server.aiStatus(t.person)).state, "model_not_found");
    await t.server.updateAiSettings(t.person, { models: { categorize: "example/decision-2" } });
    await t.receive(inbox, { from: KNOWN, subject: "After" });
    const rows = (await t.server.aiUsage(t.person, {})).periods.today;
    assert.deepEqual(rows.map((r) => [r.job, r.model, r.requests]), [
      ["categorize", "example/decision-2", 2],
      ["categorize", "fake/categorize", 2],
      ["summarize", "fake/summarize", 4],
    ], "the unfit model has no row; its test's summarize request counts");
  });
});

describe("periods", () => {
  test("today is the person's day: cut at midnight in the time zone asked for", async () => {
    const inbox = await connected();
    await t.aiOn(); // At 09:30 UTC on 16 November: 10:30 in Berlin.
    t.clock.advance(14 * HOUR); // 23:30 UTC on the 16th: already 00:30 on the 17th in Berlin.
    await t.receive(inbox, { from: KNOWN, subject: "Late" });
    const utc = await t.server.aiUsage(t.person, {});
    const berlin = await t.server.aiUsage(t.person, { tz: "Europe/Berlin" });
    assert.equal(berlin.timeZone, "Europe/Berlin");
    assert.equal(utc.periods.today.find((r) => r.job === "categorize")!.requests, 2, "in UTC both are today");
    assert.equal(berlin.periods.today.find((r) => r.job === "categorize")!.requests, 1, "in Berlin the test was yesterday");
    assert.equal(berlin.periods.last7Days.find((r) => r.job === "categorize")!.requests, 2);
  });

  test("the last 7 and 30 days start at midnight 6 and 29 days back; hours older than 90 days are dropped", async () => {
    const inbox = await connected();
    await t.aiOn();
    t.clock.advance(10 * DAY);
    await t.receive(inbox, { from: KNOWN, subject: "Ten days later" });
    let usage = await t.server.aiUsage(t.person, {});
    assert.deepEqual([usage.periods.today, usage.periods.last7Days, usage.periods.last30Days].map((rows) => rows[0]!.requests), [1, 1, 2]);
    t.clock.advance(25 * DAY);
    usage = await t.server.aiUsage(t.person, {});
    assert.deepEqual(usage.periods.last30Days.map((r) => r.requests), [1, 1], "35 days after the test, only the later request is inside 30 days");
    t.clock.advance(60 * DAY);
    await t.receive(inbox, { from: KNOWN, subject: "Much later" });
    const kept = await t.host.db.select({ hour: aiUsage.hour }).from(aiUsage);
    assert.ok(kept.every((r) => r.hour >= t.clock.now() - 90 * DAY - HOUR), "hours older than 90 days are gone");
    assert.ok(!kept.some((r) => r.hour <= Date.parse(START)), "the test's hour, 95 days back, among them");
    assert.equal(new Set(kept.map((r) => r.hour)).size, 2, "85 days back and now are kept");
  });

  test("midnight in a zone with a summer-time change, and in one half an hour off", () => {
    // Berlin moved to summer time at 01:00 UTC on 29 March 2026.
    assert.equal(new Date(localMidnight(Date.parse("2026-03-29T12:00:00Z"), "Europe/Berlin", 0)).toISOString(), "2026-03-28T23:00:00.000Z");
    assert.equal(new Date(localMidnight(Date.parse("2026-03-30T12:00:00Z"), "Europe/Berlin", 0)).toISOString(), "2026-03-29T22:00:00.000Z");
    assert.equal(new Date(localMidnight(Date.parse("2026-03-30T12:00:00Z"), "Europe/Berlin", 1)).toISOString(), "2026-03-28T23:00:00.000Z");
    assert.equal(new Date(localMidnight(Date.parse(START), "Asia/Kolkata", 0)).toISOString(), "2026-11-15T18:30:00.000Z");
    assert.equal(new Date(localMidnight(Date.parse(START), "UTC", 29)).toISOString(), "2026-10-18T00:00:00.000Z");
  });
});

describe("who may read it", () => {
  test("a person only; an unknown time zone is invalid", async () => {
    const inbox = await connected();
    await t.server.updateInbox(t.person, inbox.id, { agentAccess: true });
    const agent = await t.agent([inbox.id]);
    await assert.rejects(t.server.aiUsage(agent.caller, {}), { code: "needs_person" });
    for (const tz of ["Mars/Olympus", "x".repeat(65), "+05:00 or so"]) await assert.rejects(t.server.aiUsage(t.person, { tz }), { code: "invalid" });
    const app = createApp(t.server, { scheduler: t.clock, log: t.host.log });
    const asAgent = await app.request("/v1/ai/usage", { headers: { authorization: `Bearer ${agent.token}` } });
    assert.equal(asAgent.status, 403);
    const asPerson = await app.request("/v1/ai/usage?tz=Europe/Berlin", { headers: { authorization: `Bearer ${t.personToken}` } });
    assert.equal(asPerson.status, 200);
    const body = await asPerson.json() as { timeZone: string };
    assert.equal(body.timeZone, "Europe/Berlin");
    assert.ok(!JSON.stringify(body).includes(TEST_KEY));
  });
});
