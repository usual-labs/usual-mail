// The AI's settings (docs/contract-ai.md, "Jobs and settings"): there is no per-inbox switch (the owner's decision of
// 2026-11-17, reversing the same day's earlier one). Once a key is set, every inbox's mail is processed, those connected
// and those connected later; another service keeps processing; removing the key stops all of it.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { aiDisclosure, type Inbox, type MailEvent } from "@usualmail/core";
import { dataItems } from "../src/index.ts";
import { createApp } from "../src/rest/app.ts";
import { KNOWN, listen, makeServer, TEST_KEY, type TestServer } from "./helpers.ts";

let t: TestServer;
let a: Inbox;
let b: Inbox;
beforeEach(async () => {
  t = await makeServer();
  a = (await t.connect({ address: "a@settings.example" })).inbox;
  b = (await t.connect({ address: "b@settings.example" })).inbox;
});
afterEach(() => t.close());

const gateway = (apiKey = TEST_KEY) => ({ kind: "gateway" as const, gateway: "vercel" as const, apiKey });
const openai = (apiKey = "sk-proj-made-up-key-0001") => ({ kind: "direct" as const, provider: "openai" as const, apiKey });
/** The subjects the AI was asked to categorize, besides the settings' own test. */
const categorized = () =>
  t.models.sent("choose").map((r) => String(dataItems(r.request.data)[0]?.subject)).filter((subject) => subject !== "A test from Usual Mail");

describe("every inbox's mail, once a key is set", () => {
  test("an inbox has no AI switch: connecting or changing one with it is invalid", async () => {
    assert.ok(!("aiProcessing" in a));
    await assert.rejects(t.server.updateInbox(t.person, a.id, { aiProcessing: true } as never), { code: "invalid" });
    await assert.rejects(t.server.connectInbox(t.person, {
      name: "C", color: "#2F6FED", provider: "imap", credentials: { mailbox: "c@settings.example" }, aiProcessing: true,
    } as never), { code: "invalid" });
  });

  test("a key processes every inbox's mail, those connected later too; another service keeps processing", async () => {
    await t.receive(a, { from: KNOWN, subject: "Waiting in a" });
    await t.receive(b, { from: KNOWN, subject: "Waiting in b" });
    assert.equal(t.models.requests.length, 0, "no key: nothing is sent");
    await t.server.updateAiSettings(t.person, { credentials: gateway() });
    await t.server.whenIdle();
    assert.deepEqual(categorized().sort(), ["Waiting in a", "Waiting in b"], "the key: every inbox's waiting mail is history");
    t.models.requests.length = 0;
    const { inbox: c } = await t.connect({ address: "c@settings.example" });
    await t.receive(c, { from: KNOWN, subject: "In a new inbox" });
    assert.deepEqual(categorized(), ["In a new inbox"], "an inbox connected later too");

    await t.server.updateAiSettings(t.person, { models: { summarize: "anthropic/claude-haiku-5.5" } });
    await t.server.updateAiSettings(t.person, { credentials: gateway("vck_second-made-up-key-77") });
    assert.equal((await t.server.aiSettings(t.person)).jobs[1]!.model, "anthropic/claude-haiku-5.5", "a new key for the same gateway keeps the models");

    const heard = listen(t);
    const before = (await t.server.listInboxes(t.person)).map((inbox) => inbox.version);
    await t.server.updateAiSettings(t.person, { credentials: openai() });
    assert.deepEqual((await t.server.listInboxes(t.person)).map((inbox) => inbox.version), before, "no inbox changes");
    assert.ok(!heard.events.some((e: MailEvent) => e.type === "inbox.changed"));
    const settings = await t.server.aiSettings(t.person);
    assert.deepEqual(settings.connection, { kind: "direct", provider: "openai" });
    assert.deepEqual(settings.jobs.map((job) => job.model), [null, null], "every job back on the new service's default");
    t.models.requests.length = 0;
    await t.receive(a, { from: KNOWN, subject: "After moving" });
    assert.deepEqual(categorized(), ["After moving"], "another service: processing carries on, with that service");
    heard.stop();
  });

  test("moving to another service with models in the same change keeps those models", async () => {
    await t.server.updateAiSettings(t.person, { credentials: gateway(), models: { categorize: "typesafe-ai/jev" } });
    await t.server.updateAiSettings(t.person, { credentials: openai(), models: { categorize: "gpt-6-luna" } });
    assert.deepEqual((await t.server.aiSettings(t.person)).jobs.map((job) => job.model), ["gpt-6-luna", null]);
  });

  test("removing the credentials stops all processing and keeps nothing secret", async () => {
    await t.server.updateAiSettings(t.person, { credentials: gateway() });
    await t.server.whenIdle();
    const settings = await t.server.updateAiSettings(t.person, { credentials: null });
    t.models.requests.length = 0;
    await t.receive(a, { from: KNOWN, subject: "After removal" });
    assert.equal(t.models.requests.length, 0, "nothing more is sent");
    assert.equal(settings.credentialsSet, false);
    assert.equal(settings.connection, undefined);
    assert.deepEqual(settings.jobs.map((job) => job.defaultModel), ["", ""], "no defaults without a connection");
  });
});

describe("the words before a key is saved (GET /v1/ai/disclosure)", () => {
  test("core's words for the service asked, with the models that would do each job; no key needed", async () => {
    const app = createApp(t.server, { scheduler: t.clock, log: t.host.log });
    const call = (query: string, token = t.personToken) => app.request(`/v1/ai/disclosure${query}`, { headers: { authorization: `Bearer ${token}` } });
    const vercel = { kind: "gateway" as const, gateway: "vercel" as const };
    const defaults = t.models.defaults(vercel);
    const fresh = await call("?gateway=vercel");
    assert.equal(fresh.status, 200, "no credentials are needed: it is shown before a key is saved");
    assert.deepEqual(await fresh.json(), aiDisclosure({
      connection: vercel,
      jobs: [{ job: "categorize", model: null, defaultModel: defaults.categorize }, { job: "summarize", model: null, defaultModel: defaults.summarize }],
    }));

    // The service already set: the person's chosen models. Another service: its own defaults, never the chosen ones.
    await t.server.updateAiSettings(t.person, { credentials: gateway(), models: { summarize: "anthropic/claude-haiku-5.5" } });
    const set = await (await call("?gateway=vercel")).json() as { destination: string; history: string; service: string };
    assert.match(set.destination, /^Saving this key sends the mail of every inbox connected to this server, now and later, out of your server to Vercel's AI Gateway, which passes it on to the company that runs each model \(categorize: fake\/categorize; summarize: anthropic\/claude-haiku-5\.5\)\.$/);
    assert.equal(set.history, "It processes new mail as it arrives, then every thread of each inbox's synced mail that isn't done, newest first.");
    const other = await (await call("?provider=openai")).json() as { destination: string; service: string };
    assert.equal(other.service, "OpenAI");
    assert.match(other.destination, /out of your server to OpenAI \(categorize: fake\/categorize; summarize: fake\/summarize\)\.$/);
    assert.equal((await call("?provider=anthropic")).status, 200);

    for (const query of ["", "?gateway=openrouter", "?provider=mistral", "?gateway=vercel&provider=openai", "?gateway="]) {
      const bad = await call(query);
      assert.equal(bad.status, 400, query);
      assert.equal(((await bad.json()) as { error: { code: string } }).error.code, "invalid");
    }
    await t.server.updateInbox(t.person, a.id, { agentAccess: true });
    const agent = await t.agent([a.id]);
    const refused = await call("?gateway=vercel", agent.token);
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "needs_person");
    await assert.rejects(t.server.aiDisclosure(agent.caller, vercel), { code: "needs_person" });
  });
});

describe("the settings", () => {
  test("defaults: no credentials, not paused, and no history setting", async () => {
    const settings = await t.server.aiSettings(t.person);
    assert.deepEqual(settings, {
      credentialsSet: false,
      jobs: [{ job: "categorize", model: null, defaultModel: "" }, { job: "summarize", model: null, defaultModel: "" }],
      paused: false,
      version: 1,
    });
  });

  test("shows the connection and each job's default without the key; versions rise and people hear of it", async () => {
    const heard = listen(t);
    const settings = await t.server.updateAiSettings(t.person, { credentials: gateway() });
    assert.deepEqual(settings.connection, { kind: "gateway", gateway: "vercel" });
    assert.equal(settings.credentialsSet, true);
    assert.deepEqual(settings.jobs.map((job) => job.defaultModel), ["fake/categorize", "fake/summarize"]);
    assert.equal(settings.version, 2);
    assert.ok(!JSON.stringify(settings).includes(TEST_KEY));
    const events = heard.events.filter((e): e is Extract<MailEvent, { type: "ai.settings.changed" }> => e.type === "ai.settings.changed");
    assert.deepEqual(events.map((e) => e.settings.version), [2]);
    const same = await t.server.updateAiSettings(t.person, { paused: false });
    assert.equal(same.version, 2, "a change that changes nothing raises nothing");
    heard.stop();
  });

  test("saving a model tests it at once; pausing doesn't", async () => {
    await t.server.updateAiSettings(t.person, { credentials: gateway() });
    t.models.requests.length = 0;
    await t.server.updateAiSettings(t.person, { paused: true });
    await t.server.updateAiSettings(t.person, { paused: false });
    assert.equal(t.models.requests.length, 0);
    await t.server.updateAiSettings(t.person, { models: { categorize: "typesafe-ai/jev-1.14.0" } });
    assert.deepEqual(t.models.requests.map((r) => r.request.model), ["typesafe-ai/jev-1.14.0", "fake/summarize"]);
  });

  test("only a person reads or changes them, or tests", async () => {
    await t.server.updateInbox(t.person, a.id, { agentAccess: true });
    const agent = await t.agent([a.id]);
    await assert.rejects(t.server.aiSettings(agent.caller), { code: "needs_person" });
    await assert.rejects(t.server.updateAiSettings(agent.caller, { paused: true }), { code: "needs_person" });
    await assert.rejects(t.server.testAi(agent.caller), { code: "needs_person" });
    assert.equal((await t.server.aiStatus(agent.caller)).state, "not_set_up", "anyone reads the status");
  });

  test("over REST: PATCH /v1/ai answers the settings after its test, POST /v1/ai/test the status", async () => {
    const app = createApp(t.server, { scheduler: t.clock, log: t.host.log });
    const headers = { authorization: `Bearer ${t.personToken}`, "content-type": "application/json" };
    const patched = await app.request("/v1/ai", { method: "PATCH", headers, body: JSON.stringify({ credentials: gateway(), paused: false }) });
    assert.equal(patched.status, 200);
    const body = await patched.json() as { credentialsSet: boolean };
    assert.equal(body.credentialsSet, true);
    const status = await (await app.request("/v1/ai/status", { headers })).json() as { state: string };
    assert.equal(status.state, "working", "read straight after, the status includes the test");
    const tested = await app.request("/v1/ai/test", { method: "POST", headers: { authorization: headers.authorization } });
    assert.equal(tested.status, 200);
    assert.equal(((await tested.json()) as { state: string }).state, "working");
    const wrong = await app.request("/v1/ai", { method: "PATCH", headers, body: JSON.stringify({ historyDays: "seven" }) });
    assert.equal(wrong.status, 400);
  });

  test("on the gateway a model that can't do its job fails the test with words that say why, before any request", async () => {
    t.models.kinds = { "anthropic/claude-haiku-5.5": "language", "typesafe-ai/jev": "decision" };
    await t.server.updateAiSettings(t.person, { credentials: gateway() });
    t.models.requests.length = 0;
    await t.server.updateAiSettings(t.person, { models: { categorize: "anthropic/claude-haiku-5.5" } });
    const status = await t.server.aiStatus(t.person);
    assert.deepEqual([status.state, status.job], ["model_not_found", "categorize"]);
    assert.match(status.detail ?? "", /categorizing needs a decision model/);
    assert.match(status.detail ?? "", /anthropic\/claude-haiku-5\.5 is a language model/);
    assert.equal(t.models.requests.length, 0, "nothing sent to a model that can't answer");

    await t.server.updateAiSettings(t.person, { models: { categorize: null, summarize: "typesafe-ai/jev" } });
    const other = await t.server.aiStatus(t.person);
    assert.deepEqual([other.state, other.job], ["model_not_found", "summarize"]);
    assert.match(other.detail ?? "", /summarizing needs a language model/);

    await t.server.updateAiSettings(t.person, { models: { summarize: null } });
    assert.equal((await t.server.aiStatus(t.person)).state, "working", "the defaults fit their jobs");
    await t.server.updateAiSettings(t.person, { credentials: openai(), models: { categorize: "anthropic/claude-haiku-5.5" } });
    assert.equal((await t.server.aiStatus(t.person)).state, "working", "a provider's own key: both jobs use language models");
  });
});
