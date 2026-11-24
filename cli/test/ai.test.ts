// `usual-mail ai`: the status in words, setting the key unseen, models, pause, resume and test (history is gone), against the
// stand-in's AI (fifth revision). The key is never printed, stored or taken from the command line.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { AI_SENT_WORDS } from "@usualmail/core";
import { allFiles, run, savedConfig, scratch, type Options } from "./helpers.ts";
import { StandIn } from "./stand-in.ts";
import { KEYS, MISSING_MODEL } from "./stand-in-ai.ts";

const KEY = "vck_Test-Gateway-Key-0123456789";

let home: { dir: string; remove: () => void };
let server: StandIn;
let me: { device: { id: string }; token: string };
let options: Options;

before(() => {
  home = scratch();
});
after(async () => {
  await server.close();
  home.remove();
});
beforeEach(async () => {
  await server?.close();
  server = new StandIn();
  await server.listen();
  me = server.addDevice("person", "usual-mail on test-machine");
  savedConfig(home.dir, { server: server.url, token: me.token, deviceId: me.device.id });
  options = { home: home.dir };
});

/** A key set straight in the stand-in, as if `ai set` had run, and tested. */
function keySet(apiKey = "stored-key-0000", connection: { kind: "gateway"; gateway: "vercel" } | { kind: "direct"; provider: "openai" | "anthropic" } = { kind: "gateway", gateway: "vercel" }) {
  server.ai.credentials = { ...connection, apiKey } as typeof server.ai.credentials;
  server.ai.test();
}

const patches = () => server.calls("updateAiSettings").map((request) => request.body);

/**
 * What must be shown before a key is saved (docs/contract-ai.md): what is sent, from every inbox now and later, to
 * which service, and that its terms apply, in core's words: each sentence whole, however the lines are wrapped.
 */
function assertDisclosure(text: string, service: RegExp): void {
  const flat = text.replace(/\s+/g, " ");
  assert.match(flat, service);
  assert.match(flat, /own terms then apply to what it receives/);
  assert.ok(flat.includes(`To categorize it: ${AI_SENT_WORDS.categorize}`), "the categorize words");
  assert.ok(flat.includes(`To summarize it: ${AI_SENT_WORDS.summarize}`), "the summarize words");
  assert.ok(flat.includes(`Never: ${AI_SENT_WORDS.never}`), "what is never sent");
}

function assertNowhere(secret: string, printed: string): void {
  assert.ok(!printed.includes(secret), "printed");
  for (const file of allFiles(home.dir)) assert.ok(!file.text.includes(secret), `in ${file.path}`);
}

describe("ai status", () => {
  test("not set up: says why there are no summaries and how to set a key; `usual-mail ai` alone says the same", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    const ran = await run(["ai", "status"], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Usual Mail's AI: not set up$/m);
    assert.match(ran.stdout, /Connection\s+none: no key is set/);
    assert.match(ran.stdout, /No AI key is set, so the server doesn't categorize or summarize mail: new mail stays not sorted yet, in Home, with its snippet in place of a summary\./);
    assert.match(ran.stdout, /Set a key with `usual-mail ai set`\./);
    assert.equal((await run(["ai"], options)).stdout, ran.stdout);
    const json = JSON.parse((await run(["ai", "status", "--json"], options)).stdout);
    assert.equal(json.status.state, "not_set_up");
    assert.equal(json.settings.credentialsSet, false);
  });

  test("working: the service, each job's model, what waits, and what it works on", async () => {
    const acme = server.addInbox({ name: "Acme", address: "ana@acme.example" });
    const personal = server.addInbox({ name: "Personal", address: "me@home.example" });
    keySet();
    server.ai.models.summarize = "example/text-small-2";
    server.ai.work = [{ inboxId: acme.id }, { inboxId: acme.id }, { inboxId: acme.id }, { inboxId: personal.id }];
    server.firstSync = { days: 30, setBy: "settings", changeable: true };
    const ran = await run(["ai", "status"], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Usual Mail's AI: working$/m);
    assert.match(ran.stdout, /Connection\s+Vercel's AI Gateway, key set/);
    assert.match(ran.stdout, /Categorize\s+example\/decision-1 \(the server's default\)/);
    assert.match(ran.stdout, /Summarize\s+example\/text-small-2 \(the server's default is example\/text-small-1\)/);
    assert.doesNotMatch(ran.stdout, /on for Acme|off for Personal/, "no per-inbox switch to list");
    assert.match(ran.stdout, /Last run\s+\d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    assert.match(ran.stdout, /Waiting\s+4 threads wait to be categorized or summarized/);
    assert.match(ran.stdout, /Works on\s+all synced mail that isn't done, newest first; a new inbox's first sync takes the last 30 days \(`usual-mail sync-days` changes it\)/);
    assert.doesNotMatch(ran.stdout, /History|Beyond/);
    server.firstSync = { days: 7, setBy: "environment", changeable: false };
    assert.match((await run(["ai", "status"], options)).stdout, /the last 7 days \(USUAL_MAIL_SYNC_DAYS sets it where the server starts\)/);
    assert.ok(!ran.stdout.includes("stored-key-0000"));
  });

  test("each state that stops it says why, with the service's words, and what to do", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    const cases: Array<[() => void, RegExp, RegExp]> = [
      [() => keySet(KEYS.refused), /key refused[\s\S]*Vercel's AI Gateway refused the key[\s\S]*It said: The service refused the key\./, /usual-mail ai set/],
      [() => keySet(KEYS.noCredit), /out of credit[\s\S]*has no credit left or reached its limit[\s\S]*Your account has no credit left/, /Add credit or raise the limit there, then run `usual-mail ai test`/],
      [() => keySet(KEYS.down), /unavailable[\s\S]*usually passes by itself[\s\S]*from a minute up to 15 minutes apart/, /`usual-mail ai test` tries now/],
      [() => { server.ai.models.summarize = MISSING_MODEL; keySet(); }, /model not found[\s\S]*doesn't know the model for summarize \(example\/missing-model\)/, /usual-mail ai models --summarize <model>[\s\S]*--summarize default/],
      [() => { keySet(); server.ai.paused = true; }, /paused[\s\S]*You paused it: nothing is sent to Vercel's AI Gateway/, /`usual-mail ai resume` carries on/],
    ];
    for (const [setUp, why, fix] of cases) {
      server.ai.models = { categorize: null, summarize: null };
      server.ai.paused = false;
      setUp();
      const ran = await run(["ai", "status"], options);
      assert.equal(ran.code, 0, ran.stderr);
      assert.match(ran.stdout, why);
      assert.match(ran.stdout, fix);
    }
  });

  test("the service's words can't move the terminal's cursor", async () => {
    keySet(KEYS.refused);
    server.ai.tested.detail = "Refused\u001b[2J\u001b[31m red";
    const ran = await run(["ai", "status"], options);
    assert.ok(!ran.stdout.includes("\u001b"), "no escape character printed");
  });

  test("an agent's token reads the status but not the settings", async () => {
    const acme = server.addInbox({ name: "Acme", address: "ana@acme.example", agentAccess: true });
    keySet();
    const agent = server.addDevice("agent", "Helper", [acme.id]);
    const env = { USUAL_MAIL_TOKEN: agent.token };
    const ran = await run(["ai", "status"], { ...options, env });
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Usual Mail's AI: working$/m);
    assert.doesNotMatch(ran.stdout, /Connection|Categorize|History/);
    assert.equal(JSON.parse((await run(["ai", "status", "--json"], { ...options, env })).stdout).settings, null);
  });
});

describe("ai set", () => {
  const flags = ["ai", "set", "--gateway", "vercel", "--key-stdin", "--yes"];

  test("shows what is sent and to whom first, sends the key once, and never prints or stores it, plain or --json", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    for (const json of [false, true]) {
      const ran = await run(json ? [...flags, "--json"] : flags, { ...options, stdin: `${KEY}\n` });
      assert.equal(ran.code, 0, ran.stderr);
      assertNowhere(KEY, ran.stdout + ran.stderr);
      if (json) {
        const printed = JSON.parse(ran.stdout);
        assert.equal(printed.settings.credentialsSet, true);
        assert.equal(printed.status.state, "working");
        // With --json the words go to standard error, so the JSON stays clean.
        assertDisclosure(ran.stderr, /out of your server to Vercel's AI Gateway/);
      } else {
        assertDisclosure(ran.stdout, /Saving this key sends the mail of every inbox connected to this server, now and later, out of your server to Vercel's AI Gateway, which passes it on to the company that runs each model \(categorize: example\/decision-1; summarize: example\/text-small-1\)\./);
        assert.ok(ran.stdout.indexOf("Never:") < ran.stdout.indexOf("Saved the key"), "the words come before the key is saved");
        assert.match(ran.stdout, /Saved the key for Vercel's AI Gateway\. The server keeps it sealed; this command kept no copy\./);
        assert.match(ran.stdout, /From now on every inbox's mail goes to Vercel's AI Gateway: new mail as it arrives, then all the synced mail that isn't done, newest first\./);
        assert.match(ran.stdout, /The server tested the key at once:\nUsual Mail's AI: working/);
      }
    }
    assert.deepEqual(patches()[0], { credentials: { kind: "gateway", gateway: "vercel", apiKey: KEY } });
    const carrying = server.requests.filter((request) => request.text.includes(KEY));
    assert.equal(carrying.length, 2, "one request per run carries the key");
    assert.ok(carrying.every((request) => request.route === "updateAiSettings"));
  });

  test("prints the server's words for the service, word for word (GET /v1/ai/disclosure), before anything is sent", async () => {
    for (const [flagName, value, query] of [["--gateway", "vercel", "gateway=vercel"], ["--provider", "openai", "provider=openai"], ["--provider", "anthropic", "provider=anthropic"]] as const) {
      const ran = await run(["ai", "set", flagName, value, "--key-stdin"], { ...options, stdin: `${KEY}\n` });
      assert.equal(ran.code, 2, "without --yes it stops after the words");
      const words = server.ai.disclosure(new URLSearchParams(query));
      const flat = ran.stdout.replace(/\s+/g, " ");
      for (const sentence of [words.destination, words.terms, words.lead, ...words.sent.map((item) => `${item.label}: ${item.words}`), words.history]) {
        assert.ok(flat.includes(sentence), `${query}: ${sentence.slice(0, 50)}`);
      }
      const asked = server.calls("aiDisclosure").at(-1)!;
      assert.equal(asked.path, "/v1/ai/disclosure");
    }
    assert.equal(patches().length, 0);
  });

  test("in a terminal: asks which service, shows what is sent and to whom, asks for a yes, then the key unseen", async () => {
    const ran = await run(["ai", "set"], { ...options, interactive: true, answers: ["3", "y", KEY] });
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(ran.questions, ["Number [1]: ", "Save a key for Anthropic and send every inbox's mail there? [y/N] ", "(secret) Anthropic API key (not shown): "]);
    assert.match(ran.stdout, /Which service is the key for\?\n\s+1\s+Vercel's AI Gateway: one key reaches several companies' models\n\s+2\s+OpenAI: OpenAI's own key\n\s+3\s+Anthropic: Anthropic's own key/);
    assertDisclosure(ran.stdout, /Saving this key sends the mail of every inbox connected to this server, now and later, out of your server to Anthropic \(categorize: example-anthropic-small; summarize: example-anthropic-small\)\. Anthropic's own terms/);
    assert.deepEqual(patches()[0], { credentials: { kind: "direct", provider: "anthropic", apiKey: KEY } });
    assertNowhere(KEY, ran.stdout + ran.stderr);

    // No: nothing is asked further and nothing is sent.
    const no = await run(["ai", "set"], { ...options, interactive: true, answers: ["1", "n"] });
    assert.equal(no.code, 0, no.stderr);
    assert.equal(no.questions.length, 2, "the key isn't asked for");
    assert.match(no.stdout, /Nothing was changed\./);
    assert.equal(patches().length, 1);
  });

  test("a key the service refuses, with words that repeat it, is shown as ••• everywhere", async () => {
    const echo = "echo-Secret-Key-987654321";
    for (const json of [false, true]) {
      const ran = await run(json ? [...flags, "--json"] : flags, { ...options, stdin: `${echo}\n` });
      assert.equal(ran.code, 0, ran.stderr);
      assertNowhere(echo, ran.stdout + ran.stderr);
      assert.match(ran.stdout, /•••/);
      if (!json) assert.match(ran.stdout, /key refused[\s\S]*Incorrect API key provided: •••/);
    }
  });

  test("never takes the key from the command line, and doesn't repeat it when refusing", async () => {
    for (const argv of [
      ["ai", "set", "--gateway", "vercel", KEY],
      ["ai", "set", `--key=${KEY}`],
      ["ai", "set", "--api-key", KEY],
      ["ai", KEY],
    ]) {
      const ran = await run(argv, options);
      assert.equal(ran.code, 2, argv.join(" "));
      assertNowhere(KEY, ran.stdout + ran.stderr);
    }
    const words = await run(["ai", "set", "--gateway", "vercel", KEY], options);
    assert.match(words.stderr, /The key is never taken from the command line, where other users of this machine can see it/);
    assert.equal(patches().length, 0);
  });

  test("without a terminal, or with --json, it names every flag it needs and sends nothing", async () => {
    const ran = await run(["ai", "set"], options);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /This isn't a terminal, so nothing can be asked\. Pass --gateway vercel or --provider openai\|anthropic, --key-stdin and --yes\./);
    const json = await run(["ai", "set", "--gateway", "vercel", "--json"], { ...options, interactive: true });
    assert.equal(json.code, 2);
    const error = JSON.parse(json.stderr).error;
    assert.equal(error.code, "not_a_terminal");
    assert.match(error.message, /^With --json nothing is asked.*Pass --key-stdin and --yes\./);
    assert.equal(json.stdout, "");
    // Without --yes: the words are shown anyway, then it stops, before reading or sending the key.
    const unsaid = await run(["ai", "set", "--gateway", "vercel", "--key-stdin"], { ...options, stdin: `${KEY}\n` });
    assert.equal(unsaid.code, 2);
    assertDisclosure(unsaid.stdout, /out of your server to Vercel's AI Gateway/);
    assert.match(unsaid.stderr, /Pass --yes/);
    assert.equal(patches().length, 0);
  });

  test("refuses an unknown service and both flags at once", async () => {
    assert.match((await run(["ai", "set", "--gateway", "openrouter", "--key-stdin", "--yes"], options)).stderr, /--gateway takes vercel, not "openrouter"/);
    assert.match((await run(["ai", "set", "--provider", "mistral", "--key-stdin", "--yes"], options)).stderr, /--provider takes openai or anthropic/);
    assert.match((await run(["ai", "set", "--gateway", "vercel", "--provider", "openai", "--key-stdin", "--yes"], options)).stderr, /not both/);
    assert.equal(patches().length, 0);
  });

  test("another service shows its own words again, and puts each job on its default; a new key for the same one keeps the models", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    keySet("old-key-0000", { kind: "direct", provider: "openai" });
    server.ai.models.summarize = "example-openai-large";

    const same = await run(["ai", "set", "--provider", "openai", "--key-stdin", "--yes"], { ...options, stdin: "new-openai-key-1111\n" });
    assert.equal(same.code, 0, same.stderr);
    assertDisclosure(same.stdout, /out of your server to OpenAI \(categorize: [^;]+; summarize: example-openai-large\)\./);
    assert.match(same.stdout, /A new key for the same service keeps the models you chose\./);
    assert.equal(server.ai.models.summarize, "example-openai-large");

    const moved = await run(flags, { ...options, stdin: `${KEY}\n` });
    assert.equal(moved.code, 0, moved.stderr);
    assertDisclosure(moved.stdout, /out of your server to Vercel's AI Gateway, which passes it on to the company that runs each model \(categorize: example\/decision-1; summarize: example\/text-small-1\)\./);
    assert.match(moved.stdout, /Moving from OpenAI to Vercel's AI Gateway put each job back on the server's default model\./);
    assert.doesNotMatch(moved.stdout, /turned AI off/);
    assert.equal(server.ai.models.summarize, null);
  });

  test("an agent's token can't set a key, and nothing is read from standard input or sent", async () => {
    const inbox = server.addInbox({ name: "Acme", address: "ana@acme.example", agentAccess: true });
    const agent = server.addDevice("agent", "Helper", [inbox.id]);
    const ran = await run(flags, { ...options, env: { USUAL_MAIL_TOKEN: agent.token }, stdin: `${KEY}\n` });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /Only a person may do this, and the token in use belongs to an agent/);
    assert.equal(patches().length, 0);
  });
});

describe("ai models, pause, resume and test; ai history is gone", () => {
  test("models without flags shows each job's model and the default", async () => {
    keySet();
    server.ai.models.summarize = "example/text-small-2";
    const ran = await run(["ai", "models"], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /Through Vercel's AI Gateway:/);
    assert.match(ran.stdout, /categorize\s+example\/decision-1 \(the server's default\)/);
    assert.match(ran.stdout, /summarize\s+example\/text-small-2 \(the server's default is example\/text-small-1\)/);
    assert.equal(patches().length, 0);
  });

  test("models sets one job's model and puts another back on the default; the server tests it at once", async () => {
    keySet();
    server.ai.models.categorize = "example/decision-2";
    const tests = server.ai.tests;
    const ran = await run(["ai", "models", "--summarize", "example/text-small-2", "--categorize", "default"], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(patches()[0], { models: { categorize: null, summarize: "example/text-small-2" } });
    assert.match(ran.stdout, /Categorize now uses example\/decision-1 \(the server's default\)\./);
    assert.match(ran.stdout, /Summarize now uses example\/text-small-2/);
    assert.match(ran.stdout, /The server tested it at once:/);
    assert.equal(server.ai.tests, tests + 1);
  });

  test("a model the service doesn't know is named, with how to go back to the default", async () => {
    keySet();
    const ran = await run(["ai", "models", "--categorize", MISSING_MODEL], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /model not found[\s\S]*the model for categorize \(example\/missing-model\)[\s\S]*`usual-mail ai models --categorize default`/);
  });

  test("models refuses an empty id or one with spaces", async () => {
    assert.equal((await run(["ai", "models", "--summarize", ""], options)).code, 2);
    assert.match((await run(["ai", "models", "--summarize", "two words"], options)).stderr, /without spaces, or "default"/);
    assert.equal(patches().length, 0);
  });

  test("history is gone: `ai history` says to use sync-days, exits 2 and sends nothing; help doesn't list it", async () => {
    keySet();
    for (const args of [["ai", "history", "30"], ["ai", "history"], ["ai", "history", "3", "--yes", "--json"]]) {
      const ran = await run(args, options);
      assert.equal(ran.code, 2);
      assert.equal(ran.stdout, "");
      assert.match(ran.stderr, /^`usual-mail ai history` is gone: the server's AI works through all the mail it has synced that isn't done, newest first\. How far back that goes is the first sync's window: `usual-mail sync-days`\.\n$/);
    }
    assert.equal(patches().length, 0);
    assert.doesNotMatch((await run(["--help"], options)).stdout, /ai history/);
  });

  test("pause and resume, and test", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    keySet();
    const paused = await run(["ai", "pause"], options);
    assert.equal(paused.code, 0, paused.stderr);
    assert.deepEqual(patches()[0], { paused: true });
    assert.match(paused.stdout, /Paused Usual Mail's AI\. Nothing is sent to the AI service for any inbox until `usual-mail ai resume`\./);
    assert.match(paused.stdout, /Usual Mail's AI: paused/);
    const resumed = await run(["ai", "resume", "--json"], options);
    assert.deepEqual(patches()[1], { paused: false });
    assert.equal(JSON.parse(resumed.stdout).status.state, "working");

    const tests = server.ai.tests;
    const tested = await run(["ai", "test"], options);
    assert.equal(tested.code, 0, tested.stderr);
    assert.equal(server.calls("testAi").length, 1);
    assert.equal(server.ai.tests, tests + 1);
    assert.match(tested.stdout, /Sent one small request per job's model, with no mail in it\.\nUsual Mail's AI: working/);
    assert.equal(JSON.parse((await run(["ai", "test", "--json"], options)).stdout).state, "working");
  });
});

describe("ai remove", () => {
  test("says what removing the key does, asks first, and no changes nothing", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    server.addInbox({ name: "Personal", address: "me@home.example" });
    keySet();
    const no = await run(["ai", "remove"], { ...options, interactive: true, answers: ["n"] });
    assert.equal(no.code, 0, no.stderr);
    assert.match(no.stdout, /Removing the AI key stops all processing: nothing more of any inbox's mail is sent to Vercel's AI Gateway/);
    assert.match(no.stdout, /Threads keep the categories and summaries they have, and new mail stays not sorted yet, in Home\./);
    assert.deepEqual(no.questions, ["Remove the AI key? [y/N] "]);
    assert.match(no.stdout, /Nothing changed\. The key is still set\./);
    assert.deepEqual(patches(), []);

    const yes = await run(["ai", "remove"], { ...options, interactive: true, answers: ["y"] });
    assert.equal(yes.code, 0, yes.stderr);
    assert.deepEqual(patches(), [{ credentials: null }], "removing the key is setting the credentials to nothing");
    assert.match(yes.stdout, /Removed the AI key\. Nothing more is sent, for any inbox; `usual-mail ai set` sets a key again\./);
    assert.match(yes.stdout, /Usual Mail's AI: not set up/);
    assert.equal(server.ai.credentials, null);
  });

  test("without a terminal it needs --yes; --json prints only JSON; with no key set there is nothing to remove", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    keySet();
    const refused = await run(["ai", "remove"], options);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /This isn't a terminal, so nothing can be asked\. Pass --yes to remove the AI key/);
    assert.deepEqual(patches(), []);
    const removed = await run(["ai", "remove", "--yes", "--json"], options);
    assert.equal(removed.code, 0, removed.stderr);
    const body = JSON.parse(removed.stdout);
    assert.deepEqual([body.settings.credentialsSet, body.status.state], [false, "not_set_up"]);
    assert.match(removed.stderr, /Removing the AI key stops all processing/);
    const again = await run(["ai", "remove", "--yes"], options);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /No AI key is set, so there is nothing to remove\./);
    assert.equal(patches().length, 1);
  });

  test("a new key for the same service afterwards keeps the models the person chose, as the server does", async () => {
    keySet();
    server.ai.update({ models: { summarize: "example/text-small-2" } });
    const removed = await run(["ai", "remove", "--yes"], options);
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(server.ai.credentials, null);
    server.ai.update({ credentials: { kind: "gateway", gateway: "vercel", apiKey: "another-key-0000" } });
    assert.equal(server.ai.settings().jobs[1]!.model, "example/text-small-2");
  });
});
