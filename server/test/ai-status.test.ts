// The AI's status (docs/contract-ai.md, "Status"): every state, the wait after each failure, the throttled event, and
// the key appearing nowhere a person, an agent or a log could read it, also when a service repeats it in a refusal.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AiStatus, Inbox, MailEvent } from "@usualmail/core";
import { serverState } from "../src/db/index.ts";
import { failure } from "../src/index.ts";
import { createApp } from "../src/rest/app.ts";
import { HOUR, historyFromKnown, KNOWN, listen, makeServer, TEST_KEY, type TestServer } from "./helpers.ts";

let t: TestServer;
let inbox: Inbox;
beforeEach(async () => {
  t = await makeServer();
  inbox = (await t.connect({ address: "me@status.example", history: [historyFromKnown] })).inbox;
});
afterEach(() => t.close());

const MINUTE = 60_000;
const status = () => t.server.aiStatus(t.person);
const setKey = (apiKey = TEST_KEY) => t.server.updateAiSettings(t.person, { credentials: { kind: "gateway", gateway: "vercel", apiKey } });

describe("states and waits", () => {
  test("not_set_up without credentials, working once the test answers, paused and back", async () => {
    assert.equal((await status()).state, "not_set_up");
    assert.ok((await status()).detail);
    await setKey();
    assert.equal((await status()).state, "working", "the settings call answers after its test, so the status already says so");
    assert.equal(t.models.requests.length, 2, "one small request per job");
    for (const request of t.models.requests) assert.ok(!request.request.data.includes("Dana"), "the test sends no mail");
    await t.server.updateAiSettings(t.person, { paused: true });
    assert.equal((await status()).state, "paused");
    await t.server.updateAiSettings(t.person, { paused: false });
    assert.equal((await status()).state, "working");
    await t.server.updateAiSettings(t.person, { credentials: null });
    assert.equal((await status()).state, "not_set_up");
  });

  for (const [kind, job] of [["key_refused", "categorize"], ["out_of_credit", "categorize"], ["model_not_found", "summarize"]] as const) {
    test(`${kind} stops processing for an hour, or until a person tests again`, async () => {
      if (job === "summarize") t.models.failures.push(...[]);
      // The settings' own test: the first job answers, the other fails.
      t.models.write = () => {
        if (job === "summarize") throw failure(kind);
        return "ok";
      };
      if (job === "categorize") t.models.failures.push(failure(kind));
      await setKey();
      const failed = await status();
      assert.equal(failed.state, kind);
      assert.equal(failed.job, kind === "model_not_found" ? "summarize" : undefined, "job only with model_not_found");
      assert.ok(failed.detail);
        const sent = t.models.requests.length;
      await t.receive(inbox, { from: KNOWN, subject: "Waits" });
      await t.tick(59 * MINUTE);
      assert.equal(t.models.requests.length, sent, "nothing sent during the wait");
      t.models.write = () => "A short line.";
      await t.tick(MINUTE);
      assert.ok(t.models.requests.length > sent, "after an hour one request is tried again");
      assert.equal((await status()).state, "working", "any answer makes it working again");
    });
  }

  test("a person testing ends a wait at once", async () => {
    t.models.failures.push(failure("key_refused"));
    await setKey();
    assert.equal((await status()).state, "key_refused");
    const tested = await t.server.testAi(t.person);
    assert.equal(tested.state, "working");
  });

  test("unavailable is tried again after 1, 2, 4, 8 and then 15 minutes", async () => {
    await setKey();
    t.models.failAll = failure("unavailable", "The service couldn't be reached.");
    await t.receive(inbox, { from: KNOWN, subject: "Keeps failing" });
    assert.equal((await status()).state, "unavailable");
    for (const minutes of [1, 2, 4, 8, 15, 15]) {
      const sent = t.models.requests.length;
      await t.tick(minutes * MINUTE - 1_000);
      assert.equal(t.models.requests.length, sent, `nothing within ${minutes} minutes`);
      await t.tick(1_000);
      assert.equal(t.models.requests.length, sent + 1, `one try after ${minutes} minutes`);
    }
    t.models.failAll = null;
    await t.tick(15 * MINUTE);
    assert.equal((await status()).state, "working");
    assert.equal((await status()).pending, 0);
  });

  test("lastRunAt says when a thread was last processed; the settings' test doesn't count", async () => {
    await setKey();
    assert.equal((await status()).lastRunAt, undefined);
    await t.receive(inbox, { from: KNOWN, subject: "Processed" });
    assert.equal((await status()).lastRunAt, "2026-11-16T09:30:00Z");
  });

  test("ai.status.changed goes out at most once a second, with the latest, and its version rises", async () => {
    const heard = listen(t);
    await setKey();
    await t.receive(inbox, { from: KNOWN, subject: "One" });
    await t.receive(inbox, { from: KNOWN, subject: "Two" });
    await t.tick(1_000);
    const events = heard.events.filter((e): e is Extract<MailEvent, { type: "ai.status.changed" }> => e.type === "ai.status.changed");
    assert.ok(events.length >= 1 && events.length <= 2, `throttled: ${events.length} events`);
    const latest = events.at(-1)!.status;
    const now = await status();
    assert.deepEqual(latest, now, "the last event carries the status as it is");
    assert.ok(events.every((e, i) => i === 0 || e.status.version > events[i - 1]!.status.version));
    heard.stop();
  });
});

describe("the key appears nowhere", () => {
  const prefix = TEST_KEY.slice(0, 8);
  const suffix = TEST_KEY.slice(-6);

  test("a refusal that quotes the key, its start and its end leaves none of it in the status", async () => {
    t.models.failures.push(failure("key_refused", `Incorrect API key provided: ${TEST_KEY}. Keys look like ${prefix}… and end ${suffix}; yours ****${suffix}.`));
    await setKey();
    const refused = await status();
    assert.equal(refused.state, "key_refused");
    for (const part of [TEST_KEY, prefix, suffix]) assert.ok(!JSON.stringify(refused).includes(part), `no ${part} in ${refused.detail}`);
    assert.ok((refused.detail ?? "").length <= 300);
  });

  test("not in any response, event, log line or anything an agent can read", async () => {
    const agent = await t.agent([inbox.id]);
    await t.server.updateInbox(t.person, inbox.id, { agentAccess: true });
    const personHeard = listen(t);
    const agentHeard = listen(t, agent.caller);
    const app = createApp(t.server, { scheduler: t.clock, log: t.host.log });
    const call = async (method: string, path: string, token: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
      return { status: res.status, text: await res.text() };
    };
    const responses: string[] = [];
    responses.push((await call("PATCH", "/v1/ai", t.personToken, { credentials: { kind: "gateway", gateway: "vercel", apiKey: TEST_KEY } })).text);
    // Refused bodies don't repeat what they were sent either.
    for (const bad of [
      { credentials: { kind: "gateway", gateway: TEST_KEY, apiKey: TEST_KEY } },
      { credentials: { kind: "direct", provider: "openai", apiKey: TEST_KEY, key: TEST_KEY } },
      { credentials: { kind: TEST_KEY } },
      { [TEST_KEY]: true },
    ]) {
      const res = await call("PATCH", "/v1/ai", t.personToken, bad);
      assert.equal(res.status, 400);
      responses.push(res.text);
    }
    t.models.failures.push(failure("key_refused", `Incorrect API key provided: ${TEST_KEY}`));
    await t.receive(inbox, { from: KNOWN, subject: "Refused" });
    for (const [token, paths] of [[t.personToken, ["/v1/ai", "/v1/ai/status", "/v1/inboxes", "/v1/counts", "/v1/handled?includeSilent=true"]], [agent.token, ["/v1/ai/status", "/v1/inboxes", "/v1/counts", "/v1/me"]]] as const) {
      for (const path of paths) responses.push((await call("GET", path, token)).text);
    }
    responses.push((await call("POST", "/v1/ai/test", t.personToken)).text);
    const agentTried = await call("GET", "/v1/ai", agent.token);
    assert.equal(agentTried.status, 403, "an agent never sees the settings");
    await t.tick(1_000);
    const seen = [
      ...responses,
      ...personHeard.events.map((e) => JSON.stringify(e)),
      ...agentHeard.events.map((e) => JSON.stringify(e)),
      ...t.errors,
      ...t.infos,
    ].join("\n");
    for (const part of [TEST_KEY, prefix, suffix]) assert.ok(!seen.includes(part), `the key's ${part} leaked`);
    assert.ok(personHeard.events.some((e) => e.type === "ai.settings.changed"), "people hear settings changes");
    assert.ok(!agentHeard.events.some((e) => e.type === "ai.settings.changed"), "agents never do");
    assert.ok(agentHeard.events.some((e) => e.type === "ai.status.changed"), "anyone hears the status");
    personHeard.stop();
    agentHeard.stop();
  });

  test("the key is stored sealed, never as text", async () => {
    await setKey();
    const sealed = String((await t.host.db.select({ sealed: serverState.aiCredentials }).from(serverState).get())?.sealed);
    assert.ok(sealed.startsWith("v1."));
    assert.ok(!sealed.includes(TEST_KEY) && !sealed.includes(prefix));
  });
});

/** Narrows a status for readability in failures. */
export function brief(value: AiStatus): string {
  return `${value.state} ${value.pending}`;
}
