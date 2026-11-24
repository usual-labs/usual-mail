// The server's AI in the dashboard (fifth revision): its page (status, the key that is never shown, models with their
// defaults, history with what raising it adds, pause, test), each inbox's AI switch with what is sent and to whom
// shown before it is turned on, the inbox's icon and place, the AI on Home when it needs a person, and the AI as an
// actor in Handled.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AI_SENT_WORDS, ServiceError } from "@usualmail/core";
import { SAMPLE } from "./fake-data.ts";
import { setup } from "./helpers.ts";
import { ICON_NAMES as SPRITE_ICONS } from "../src/generated/assets.ts";

const textOf = (body: string) =>
  body
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .replace(/ ([:,.;])/g, "$1");

const KEY = "vck_Dashboard-Test-Key-0123456789";

describe("the AI page", () => {
  test("says how the AI is, what it works through, each job's model with its default, and offers no history setting", async () => {
    const app = setup();
    const { body, status } = await app.page("/ai");
    assert.equal(status, 200);
    const text = textOf(body);
    assert.match(body, /<a href="\/ai" aria-current="page">/);
    assert.ok(text.includes(`Waiting ${SAMPLE.aiStatus.pending} threads wait`), "the sample's count");
    assert.match(text, /State Working Last run 16 Nov 2026, 09:12 UTC Waiting \d+ threads wait The AI works through all the mail the server has synced that isn't done, newest first; a new inbox's first sync takes the last 30 days of mail \(`usual-mail sync-days` changes that\)\./);
    assert.match(text, /Once a key is set, the server processes every inbox's mail, those you connect later too\./);
    assert.match(text, /Service Vercel's AI Gateway, key set/);
    assert.match(body, /id="ai-model-categorize" name="categorize" value=""/);
    assert.match(text, /Empty uses the server's default: example\/decision-1\./);
    assert.match(body, /id="ai-model-summarize" name="summarize" value="example\/text-small-2"/);
    assert.doesNotMatch(body, /historyDays|ai-history|Older than the history/);
    assert.match(body, /type="password" id="ai-key" name="apiKey" value="" required autocomplete="off"/);
    // The key form shows what saving a key sends, and to whom, before its button: core's words, for the service shown.
    assert.match(text, /Saving this key sends the mail of every inbox connected to this server, now and later, out of your server to Vercel's AI Gateway, which passes it on to the company that runs each model \(categorize: example\/decision-1; summarize: example\/text-small-2\)\. Vercel's AI Gateway's own terms then apply to what it receives\./);
    assert.ok(text.includes(`To categorize it: ${AI_SENT_WORDS.categorize}`), "the categorize words");
    assert.ok(text.includes(`To summarize it: ${AI_SENT_WORDS.summarize}`), "the summarize words");
    assert.ok(text.includes(`Never: ${AI_SENT_WORDS.never}`), "what is never sent");
    assert.match(text, /It processes new mail as it arrives, then every thread of each inbox's synced mail that isn't done, newest first\./);
    const never = body.indexOf("<b>Never:</b>");
    assert.ok(never > 0 && never < body.indexOf('id="ai-key"'), "what is sent is shown before the key is typed");
    assert.match(body, /<input type="hidden" name="service" value="gateway:vercel">/);
    assert.match(body, /<button class="button primary" type="submit">Save the key and send every inbox's mail to Vercel&#39;s AI Gateway<\/button>/);
    assert.match(body, /action="\/ai\/test"/);
    assert.match(body, /name="paused" value="yes"><button class="button" type="submit">Pause/);
  });

  test("without a key it says why there are no summaries, and offers only the key and history", async () => {
    const app = setup();
    Object.assign(app.fake.ai, { credentialsSet: false, connection: undefined });
    app.fake.aiState = { ...app.fake.aiState, state: "not_set_up" };
    const { body } = await app.page("/ai");
    const text = textOf(body);
    assert.match(text, /No AI key is set, so the server doesn't categorize or summarize mail\./);
    assert.match(text, /Service No key is set/);
    assert.doesNotMatch(body, /action="\/ai\/models"/);
    assert.doesNotMatch(body, /action="\/ai\/test"/);
  });

  test("the service's own words are shown as its words, escaped", async () => {
    const app = setup();
    app.fake.aiState = { ...app.fake.aiState, state: "model_not_found", job: "summarize", detail: "<b>No such model</b>" };
    const { body } = await app.page("/ai");
    assert.match(textOf(body), /Vercel's AI Gateway doesn't know the model for summarize\./);
    assert.match(body, /It said: &lt;b&gt;No such model&lt;\/b&gt;/);
  });

  test("a key is sent once, for the service chosen, and never comes back in a page", async () => {
    const app = setup();
    const res = await app.post("/ai/key", { service: "direct:anthropic", apiKey: `  ${KEY}  ` });
    assert.equal(res.headers.get("location"), "/ai?done=ai-key-saved");
    assert.deepEqual(app.fake.callsTo("updateAiSettings").map((args) => args[1]), [{ credentials: { kind: "direct", provider: "anthropic", apiKey: KEY } }]);
    const after = await app.page("/ai?done=ai-key-saved");
    assert.ok(!after.body.includes(KEY));
    assert.match(textOf(after.body), /From now on every inbox's mail goes to the AI, newest first\./);
    assert.match(textOf(after.body), /Service Anthropic, key set/);
  });

  test("an empty key, an unknown service, or a refusal that repeats the key", async () => {
    const app = setup();
    const empty = await app.post("/ai/key", { service: "gateway:vercel", apiKey: "   " });
    assert.equal(empty.status, 400);
    assert.match(await empty.text(), /Type the key\./);
    const unknown = await app.post("/ai/key", { service: "gateway:openrouter", apiKey: KEY });
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /Choose which service the key is for\./);
    assert.deepEqual(app.fake.callsTo("updateAiSettings"), []);

    app.fake.failNext("updateAiSettings", new ServiceError("invalid", `The key ${KEY} is not a key for this service`));
    const refused = await app.post("/ai/key", { service: "gateway:vercel", apiKey: KEY });
    assert.equal(refused.status, 400);
    const body = await refused.text();
    assert.ok(!body.includes(KEY), "the key never comes back");
    assert.match(body, /The key ••• is not a key for this service/);
    assert.match(body, /name="apiKey" value=""/);
  });

  test("models: only what changed is sent, empty means the default, and an id with spaces is refused", async () => {
    const app = setup();
    const same = await app.post("/ai/models", { categorize: "", summarize: "example/text-small-2" });
    assert.equal(same.headers.get("location"), "/ai?done=saved");
    assert.deepEqual(app.fake.callsTo("updateAiSettings"), [], "nothing changed, so nothing is tested");
    const res = await app.post("/ai/models", { categorize: "example/decision-2", summarize: "" });
    assert.equal(res.headers.get("location"), "/ai?done=ai-models-saved");
    assert.deepEqual(app.fake.callsTo("updateAiSettings").map((args) => args[1]), [{ models: { categorize: "example/decision-2", summarize: null } }]);
    const bad = await app.post("/ai/models", { categorize: "two words", summarize: "" });
    assert.equal(bad.status, 400);
    const body = await bad.text();
    assert.match(body, /The model for categorize is an id without spaces, or empty for the default\./);
    assert.match(body, /name="categorize" value="two words"/);
    assert.equal(app.fake.callsTo("updateAiSettings").length, 1);
  });

  test("the first sync's window: named with how to change it, or who sets it; the history form is gone", async () => {
    const app = setup();
    assert.equal((await app.post("/ai/history", { historyDays: "7" })).status, 404, "no history setting since 2026-11-18");
    assert.equal(app.fake.callsTo("updateAiSettings").length, 0);
    app.fake.firstSync = { days: 7, setBy: "environment", changeable: false };
    assert.match(textOf((await app.page("/ai")).body), /first sync takes the last 7 days of mail \(USUAL_MAIL_SYNC_DAYS sets that where the server starts\)\./);
    app.fake.firstSync = { days: 1, setBy: "default", changeable: false };
    assert.match(textOf((await app.page("/ai")).body), /first sync takes the last 1 day of mail\./);
  });

  test("pause, resume and test", async () => {
    const app = setup();
    assert.equal((await app.post("/ai/pause", { paused: "yes" })).headers.get("location"), "/ai?done=ai-paused");
    assert.match(textOf((await app.page("/ai")).body), /State Paused[\s\S]*You paused it: nothing is sent for any inbox/);
    assert.equal((await app.post("/ai/pause", { paused: "no" })).headers.get("location"), "/ai?done=ai-resumed");
    assert.deepEqual(app.fake.callsTo("updateAiSettings").map((args) => args[1]), [{ paused: true }, { paused: false }]);
    assert.equal((await app.post("/ai/test")).headers.get("location"), "/ai?done=ai-tested");
    assert.equal(app.fake.callsTo("testAi").length, 1);
  });
});

describe("removing the AI key", () => {
  test("the AI page offers it while a key is set, on a page of its own that asks first", async () => {
    const app = setup();
    const { body } = await app.page("/ai");
    assert.match(body, /<a class="button danger" href="\/ai\/remove">[^<]*(<[^>]+>[^<]*)*Remove the key<\/a>/);
    const confirm = await app.page("/ai/remove");
    assert.equal(confirm.status, 200);
    const text = textOf(confirm.body);
    assert.match(text, /Remove the AI key\?/);
    assert.match(text, /Removing the key stops all processing: nothing more of any inbox's mail is sent to Vercel's AI Gateway\./);
    assert.match(text, /Threads keep the categories and summaries they have, and new mail stays not sorted yet, in Home\./);
    assert.match(text, /To use AI again, set a key again\./);
    assert.match(confirm.body, /action="\/ai\/remove"/);
    assert.match(confirm.body, /<a class="button large" href="\/ai">Keep it<\/a>/);
    assert.deepEqual(app.fake.callsTo("updateAiSettings"), [], "showing the question changes nothing");
  });

  test("confirming sets the credentials to nothing: nothing more is sent, and the page says so", async () => {
    const app = setup();
    const res = await app.post("/ai/remove");
    assert.equal(res.headers.get("location"), "/ai?done=ai-key-removed");
    assert.deepEqual(app.fake.callsTo("updateAiSettings").map((args) => args[1]), [{ credentials: null }]);
    const after = await app.page("/ai?done=ai-key-removed");
    const text = textOf(after.body);
    assert.match(text, /The AI key is removed\. Nothing more is sent, for any inbox\./);
    assert.match(text, /Service No key is set/);
    assert.doesNotMatch(after.body, /href="\/ai\/remove"/, "nothing left to remove");
    assert.equal(app.fake.ai.jobs[1]!.model, "example/text-small-2", "the models the person chose are kept, as the server keeps them");
  });

  test("without a key there is nothing to remove", async () => {
    const app = setup();
    Object.assign(app.fake.ai, { credentialsSet: false, connection: undefined });
    assert.equal((await app.page("/ai/remove")).res.headers.get("location"), "/ai");
    assert.equal((await app.post("/ai/remove")).headers.get("location"), "/ai");
    assert.deepEqual(app.fake.callsTo("updateAiSettings"), []);
  });
});

describe("choosing the service for a key", () => {
  test("another service's words are shown before its key is saved, exactly as the server builds them", async () => {
    const app = setup();
    const { body } = await app.page("/ai?service=direct:openai");
    const text = textOf(body);
    assert.match(text, /Saving this key sends the mail of every inbox connected to this server, now and later, out of your server to OpenAI \(categorize: example\/openai-default; summarize: example\/openai-default\)\. OpenAI's own terms then apply to what it receives\./);
    assert.doesNotMatch(text, /passes it on/);
    // Word for word what the service answered (GET /v1/ai/disclosure), for the service the page shows.
    const [[, asked]] = app.fake.callsTo("aiDisclosure").slice(-1) as [[unknown, unknown]];
    assert.deepEqual(asked, { kind: "direct", provider: "openai" });
    const words = await app.fake.aiDisclosure({ actor: { kind: "person", deviceId: "dev_web_1" } }, { kind: "direct", provider: "openai" });
    for (const sentence of [words.destination, words.terms, words.lead, ...words.sent.map((item) => `${item.label}: ${item.words}`), words.history]) {
      assert.ok(text.includes(sentence), sentence.slice(0, 50));
    }
    assert.match(body, /<input type="hidden" name="service" value="direct:openai">/);
    assert.match(body, /Save the key and send every inbox's mail to OpenAI/);
    assert.match(body, /<a class="chip-all" href="\/ai\?service=direct:openai" aria-current="page">/);
    // An unknown service falls back to the one set.
    assert.match((await app.page("/ai?service=nope")).body, /name="service" value="gateway:vercel"/);
  });

  test("an inbox's page has no AI switch, and its old form answers not found", async () => {
    const app = setup();
    const { body } = await app.page("/inboxes/inb_personal");
    assert.doesNotMatch(body, /action="\/inboxes\/inb_personal\/ai"/);
    assert.doesNotMatch(body, /Turn AI on/);
    const res = await app.post("/inboxes/inb_northwind/ai", { ai: "off" });
    assert.equal(res.status, 404);
    assert.deepEqual(app.fake.callsTo("updateInbox"), []);
  });
});

describe("an inbox's icon and place", () => {
  test("shows the fourteen icons, each drawn, and the places, and sends only what changed", async () => {
    const app = setup();
    const { body } = await app.page("/inboxes/inb_personal");
    const icons = ["person", "building", "briefcase", "house", "shop", "globe", "plane", "wallet", "family", "rocket", "school", "heart", "star", "leaf"];
    for (const icon of icons) assert.match(body, new RegExp(`name="icon" value="${icon}"`), icon);
    for (const icon of icons) assert.ok(SPRITE_ICONS.includes(icon), `${icon} is drawn: in the served sprite`);
    assert.match(body, /name="icon" value="person" checked/);
    assert.match(body, /<option value="3" selected>3<\/option>/);
    const res = await app.post("/inboxes/inb_personal/place", { icon: "house", position: "1" });
    assert.equal(res.headers.get("location"), "/inboxes/inb_personal?done=saved");
    assert.deepEqual(app.fake.callsTo("updateInbox").map((args) => args.slice(1)), [["inb_personal", { icon: "house", position: 0 }]]);
    assert.deepEqual(app.fake.inboxes.map((inbox) => [inbox.id, inbox.position]), [["inb_personal", 0], ["inb_northwind", 1], ["inb_harbor", 2]]);
    assert.match(textOf((await app.page("/inboxes")).body), /Personal[\s\S]*Northwind Studio[\s\S]*Harbor & Pine/);
  });

  test("an unknown icon or place is refused before anything is sent", async () => {
    const app = setup();
    for (const fields of [{ icon: "castle", position: "1" }, { icon: "house", position: "zero" }]) {
      const res = await app.post("/inboxes/inb_personal/place", fields);
      assert.equal(res.status, 400, JSON.stringify(fields));
    }
    assert.deepEqual(app.fake.callsTo("updateInbox"), []);
  });
});

describe("the AI on Home and in Handled", () => {
  test("Home says when the AI needs the person: a refused key, a missing model, no credit", async () => {
    for (const state of ["key_refused", "model_not_found", "out_of_credit"] as const) {
      const app = setup();
      app.fake.aiState = { ...app.fake.aiState, state, detail: "Words from the service" };
      const text = textOf((await app.page("/")).body);
      assert.match(text, /Usual Mail's AI needs you/, state);
      assert.match(text, /It said: Words from the service/, state);
      assert.match((await app.page("/")).body, /href="\/ai">/);
    }
    for (const state of ["working", "unavailable", "paused", "not_set_up"] as const) {
      const app = setup();
      app.fake.aiState = { ...app.fake.aiState, state };
      assert.doesNotMatch(textOf((await app.page("/")).body), /Usual Mail's AI needs you/, state);
    }
  });

  test("with only the AI needing the person, Home doesn't say nothing needs you", async () => {
    const app = setup();
    app.fake.inboxes.forEach((inbox) => (inbox.status = "ok"));
    app.fake.actions = app.fake.actions.filter((record) => record.state !== "proposed");
    app.fake.rules = app.fake.rules.filter((rule) => rule.enabled);
    app.fake.aiState = { ...app.fake.aiState, state: "out_of_credit" };
    const text = textOf((await app.page("/")).body);
    assert.match(text, /Usual Mail's AI needs you Out of credit: The account at Vercel's AI Gateway has no credit left/);
    assert.doesNotMatch(text, /Nothing needs you right now/);
  });

  test("Handled names Usual Mail's AI with its model, among the silent changes", async () => {
    const app = setup();
    const text = textOf((await app.page("/handled?inbox=inb_harbor&silent=1")).body);
    assert.match(text, /Invoice 2026-118, due 30 November Done silently Usual Mail's AI put it in Invoices, using example\/decision-1 · Yesterday Undo/);
    assert.match(text, /and the categories Usual Mail's AI set\./);
  });

  test("an AI record whose write-back the provider refused is no longer silent and needs a look on Home", async () => {
    const app = setup();
    Object.assign(app.fake.actions.find((record) => record.id === "act_10")!, { silent: false, error: "Gmail refused the label" });
    const text = textOf((await app.page("/")).body);
    assert.match(text, /Usual Mail's AI put it in Invoices, using example\/decision-1 · Yesterday Undo didn't go through: Gmail refused the label/);
  });

  test("the rules form puts mail in a category, never in unknown", async () => {
    const { body } = await setup().page("/inboxes/inb_northwind/rules");
    assert.match(body, /<select id="rule-category" name="category"/);
    for (const category of ["conversation", "newsletter", "invoice", "receipt", "notification", "otp"]) assert.match(body, new RegExp(`<option value="${category}">`), category);
    assert.doesNotMatch(body, /<option value="unknown">/);
  });
});
