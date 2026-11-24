// The cost in the AI's usage (docs/contract-ai.md, "Usage"): for a request made through Vercel's AI Gateway that came
// back with a generation id, the server looks the cost up apart from the mail work, a little later, and adds the
// gateway's own figure to that hour's row. A lookup that fails or isn't ready is tried again with growing pauses, then
// given up: that request's cost stays unreported. Lookups aren't requests, send only the id, and survive a restart.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AiUsageRow, Caller, Inbox } from "@usualmail/core";
import { aesGcmSecrets, FakeModels, MailServer, MemoryEventBus, ProviderRegistry, webRandom, type Host } from "../src/index.ts";
import { openDatabase } from "../src/node/db.ts";
import { ManualClock } from "../src/testing/index.ts";
import { historyFromKnown, KNOWN, makeServer, START, TEST_KEY, type TestServer } from "./helpers.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

async function connected(): Promise<Inbox> {
  return (await t.connect({ address: "me@costs.example", history: [historyFromKnown] })).inbox;
}

/** Each answered request gets a new made-up generation id, as the gateway gives one. */
function generations(models: FakeModels): void {
  let next = 0;
  models.generation = () => `gen_FAKE${String(++next).padStart(4, "0")}`;
}

const costs = async (period: "today" | "last7Days" = "today", caller: Caller = t.person) =>
  (await t.server.aiUsage(caller, {})).periods[period].map((row: AiUsageRow) => [row.job, row.requests, row.cost, row.costPartial]);

describe("looking costs up", () => {
  test("a request with a generation id gets the gateway's own cost a little later; the lookup isn't a request", async () => {
    const inbox = await connected();
    generations(t.models);
    t.models.costOf = () => 0.0002;
    await t.aiOn();
    await t.receive(inbox, { from: KNOWN, subject: "Costs" });
    const sent = t.models.requests.length;
    assert.deepEqual(await costs(), [["categorize", 2, null, false], ["summarize", 2, null, false]], "not looked up yet");
    assert.deepEqual(t.models.lookups, [], "the mail work never waits for a lookup");
    await t.tick(10 * SECOND);
    assert.deepEqual(t.models.lookups.length, 4, "one lookup per generation id: the key's tests and the thread's two");
    assert.ok(t.models.lookups.every((id) => /^gen_FAKE\d{4}$/.test(id)), "a lookup sends the id and nothing else");
    assert.equal(t.models.requests.length, sent, "lookups aren't requests to a model");
    assert.deepEqual(await costs(), [
      ["categorize", 2, { amount: 0.0004, currency: "USD" }, false],
      ["summarize", 2, { amount: 0.0004, currency: "USD" }, false],
    ]);
  });

  test("one that isn't ready is tried again later; one that keeps failing is given up and stays unreported", async () => {
    const inbox = await connected();
    await t.aiOn();
    generations(t.models);
    const tries = new Map<string, number>();
    t.models.costOf = (id) => {
      const n = (tries.get(id) ?? 0) + 1;
      tries.set(id, n);
      // The categorize request's id is ready on its third try; the summarize request's never is.
      if (id === "gen_FAKE0001" && n >= 3) return 0.001;
      return new Error("The generation wasn't found");
    };
    await t.receive(inbox, { from: KNOWN, subject: "Late" });
    for (const wait of [10 * SECOND, MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE]) await t.tick(wait);
    assert.deepEqual([tries.get("gen_FAKE0001"), tries.get("gen_FAKE0002")], [3, 5], "five tries at most, with growing pauses");
    await t.tick(24 * 60 * MINUTE);
    assert.equal(tries.get("gen_FAKE0002"), 5, "given up: not tried again");
    assert.deepEqual(await costs("last7Days"), [
      ["categorize", 2, { amount: 0.001, currency: "USD" }, true],
      ["summarize", 2, null, false],
    ], "a day later; the key's tests came back with no id, so their costs are unreported too");
    assert.deepEqual(t.infos.filter((line) => line.startsWith("AI cost")), ["AI cost lookup given up after 5 tries: no cost for 1 request"]);
  });

  test("no generation id, or a provider's own key: nothing is looked up, and the cost is not reported", async () => {
    const inbox = await connected();
    await t.aiOn();
    t.models.costOf = () => 0.5;
    await t.receive(inbox, { from: KNOWN, subject: "No id" });
    await t.tick(10 * MINUTE);
    assert.deepEqual(t.models.lookups, []);
    generations(t.models);
    await t.server.updateAiSettings(t.person, { credentials: { kind: "direct", provider: "openai", apiKey: TEST_KEY } });
    await t.receive(inbox, { from: KNOWN, subject: "Own key" });
    await t.tick(10 * MINUTE);
    assert.deepEqual(t.models.lookups, [], "only Vercel's AI Gateway has lookups");
    assert.ok((await t.server.aiUsage(t.person, {})).periods.today.every((row) => row.cost === null));
  });

  test("paused, nothing is looked up until it resumes; the key removed, what waited is dropped", async () => {
    const inbox = await connected();
    generations(t.models);
    t.models.costOf = () => 0.0001;
    await t.aiOn();
    await t.server.updateAiSettings(t.person, { paused: true });
    await t.tick(10 * MINUTE);
    assert.deepEqual(t.models.lookups, [], "paused: nothing is sent, ids included");
    await t.server.updateAiSettings(t.person, { paused: false });
    await t.tick(10 * SECOND);
    assert.equal(t.models.lookups.length, 2);
    await t.receive(inbox, { from: KNOWN, subject: "Then removed" });
    await t.server.updateAiSettings(t.person, { credentials: null });
    await t.tick(10 * MINUTE);
    assert.equal(t.models.lookups.length, 2, "no key: the waiting lookups were dropped");
  });
});

describe("a restart", () => {
  test("lookups waiting when the server stops are made after it starts again", async () => {
    const store = await openDatabase(":memory:");
    const clock = new ManualClock(START);
    const secrets = await aesGcmSecrets(webRandom.bytes(32), webRandom);
    const host = (): Host => ({ db: store.db, clock, scheduler: clock, random: webRandom, events: new MemoryEventBus(), secrets, log: { info: () => {}, error: () => {} } });
    const before = new FakeModels();
    generations(before);
    before.costOf = () => new Error("Not ready");
    const first = await MailServer.create(host(), { providers: new ProviderRegistry(), models: before });
    await first.start();
    const person = (await first.authenticate((await first.pair({ code: (await first.ownerPairingCode())!.code, name: "Mac" })).token))!;
    await first.updateAiSettings(person, { credentials: { kind: "gateway", gateway: "vercel", apiKey: TEST_KEY } });
    await first.whenIdle();
    await first.stop();
    assert.deepEqual(before.lookups, [], "stopped before any lookup was due");

    const after = new FakeModels();
    after.costOf = () => 0.003;
    const second = await MailServer.create(host(), { providers: new ProviderRegistry(), models: after });
    await second.start();
    try {
      clock.advance(10 * SECOND);
      await second.whenIdle();
      assert.deepEqual(after.lookups, ["gen_FAKE0001", "gen_FAKE0002"]);
      const rows = (await second.aiUsage(person, {})).periods.today;
      assert.deepEqual(rows.map((row) => [row.job, row.cost]), [
        ["categorize", { amount: 0.003, currency: "USD" }],
        ["summarize", { amount: 0.003, currency: "USD" }],
      ]);
    } finally {
      await second.stop();
      store.close();
    }
  });
});
