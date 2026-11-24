// `inbox add` and the AI (no per-inbox switch since 2026-11-17: a key processes every inbox's mail), the icon, the
// position, and `doctor`'s AI check, against the stand-in.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { run, savedConfig, scratch, type Options } from "./helpers.ts";
import { StandIn } from "./stand-in.ts";
import { KEYS } from "./stand-in-ai.ts";

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

function keySet(apiKey = "stored-key-0000", connection: { kind: "gateway"; gateway: "vercel" } | { kind: "direct"; provider: "openai" } = { kind: "gateway", gateway: "vercel" }) {
  server.ai.credentials = { ...connection, apiKey } as typeof server.ai.credentials;
  server.ai.test();
}

const updates = () => server.calls("updateInbox").map((request) => request.body);


describe("inbox add and AI", () => {
  const gmail = ["inbox", "add", "--provider", "gmail", "--name", "G", "--color", "plum", "--client-id", "id.example", "--secrets-stdin"];
  const stdin = "secret-1234\ntoken-5678\n";

  test("there is nothing to turn on: with a key it says the new inbox's mail goes to the AI like every inbox's", async () => {
    const without = await run(gmail, { ...options, stdin });
    assert.equal(without.code, 0, without.stderr);
    assert.deepEqual(Object.keys(server.calls("connectInbox")[0]!.body as object).sort(), ["color", "credentials", "name", "provider"]);
    assert.match(without.stdout, /No AI key is set, so its mail isn't categorized or summarized; `usual-mail ai set` sets one\./);
    keySet();
    const withKey = await run(gmail, { ...options, stdin });
    assert.equal(withKey.code, 0, withKey.stderr);
    assert.match(withKey.stdout, /Its mail goes to the AI with Vercel's AI Gateway, as every inbox's does\./);
    for (const flag of ["--ai", "--no-ai"]) {
      const gone = await run([...gmail, flag], { ...options, stdin });
      assert.equal(gone.code, 2, flag);
      assert.match(gone.stderr, /Unknown option/);
    }
    assert.equal(server.calls("connectInbox").length, 2);
  });

  test("--icon sets the new inbox's icon; an unknown icon is refused before connecting", async () => {
    const ran = await run([...gmail, "--icon", "globe"], { ...options, stdin });
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal((server.calls("connectInbox")[0]!.body as { icon?: string }).icon, "globe");
    const bad = await run([...gmail, "--icon", "castle"], { ...options, stdin });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--icon takes person, building, briefcase, house, shop, globe, plane, wallet, family, rocket, school, heart, star, leaf, not "castle"/);
    assert.equal(server.calls("connectInbox").length, 1);
  });
});

describe("inbox icon and move", () => {
  test("icon sets one of the fourteen; anything else is refused", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    const ran = await run(["inbox", "icon", "Acme", "house"], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(updates(), [{ icon: "house" }]);
    assert.match(ran.stdout, /Acme's icon is now house\./);
    for (const icon of ["plane", "wallet", "family", "rocket", "school", "heart", "star", "leaf"]) {
      const set = await run(["inbox", "icon", "Acme", icon], options);
      assert.equal(set.code, 0, `${icon}: ${set.stderr}`);
    }
    const help = await run(["inbox", "icon", "--help"], options);
    assert.match(help.stdout, /one of: person, building, briefcase, house, shop, globe, plane, wallet, family, rocket, school, heart, star, leaf/);
    const unknown = await run(["inbox", "icon", "Acme", "castle"], options);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /The icon is one of person, .*, leaf, not "castle"\./);
    assert.equal(JSON.parse((await run(["inbox", "icon", "Acme", "shop", "--json"], options)).stdout).icon, "shop");
  });

  test("move takes a place counting from 1, and the server renumbers the others", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    server.addInbox({ name: "Personal", address: "me@home.example" });
    server.addInbox({ name: "Shop", address: "shop@acme.example" });
    const ran = await run(["inbox", "move", "Shop", "1"], options);
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(updates(), [{ position: 0 }]);
    assert.match(ran.stdout, /Moved Shop to place 1 of 3\./);
    assert.deepEqual(server.inboxes.map((inbox) => [inbox.name, inbox.position]), [["Shop", 0], ["Acme", 1], ["Personal", 2]]);
    const list = await run(["inbox", "list"], options);
    assert.match(list.stdout.split("\n")[1]!, /^1\s+Shop/);
    assert.match((await run(["inbox", "move", "Shop", "1"], options)).stdout, /already in place 1\. Nothing changed\./);
    for (const place of ["0", "4", "two"]) {
      const bad = await run(["inbox", "move", "Shop", place], options);
      assert.equal(bad.code, 2, place);
      assert.match(bad.stderr, /The place is a whole number from 1 to 3/);
    }
    assert.equal(updates().length, 1);
  });
});

describe("doctor and the AI", () => {
  const aiCheck = async () => {
    const ran = await run(["doctor", "--json"], options);
    return { code: ran.code, check: JSON.parse(ran.stdout).checks.find((c: { name: string }) => c.name === "ai") };
  };

  test("no key: a warning that says what to fix", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    const { check } = await aiCheck();
    assert.equal(check.level, "warn");
    assert.match(check.text, /^not set up: No AI key is set/);
    assert.equal(check.fix, "Set a key with `usual-mail ai set`.");
  });

  test("a refused key fails, with the fix", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    keySet(KEYS.refused);
    const { code, check } = await aiCheck();
    assert.equal(code, 1);
    assert.equal(check.level, "fail");
    assert.match(check.text, /^key refused \(Vercel's AI Gateway\): Vercel's AI Gateway refused the key/);
    assert.match(check.fix, /usual-mail ai set/);
  });

  test("working: ok, with what waits", async () => {
    const acme = server.addInbox({ name: "Acme", address: "ana@acme.example" });
    server.addInbox({ name: "Personal", address: "me@home.example" });
    keySet();
    server.ai.work = [{ inboxId: acme.id }];
    const { check } = await aiCheck();
    assert.equal(check.level, "ok");
    assert.equal(check.text, "working (Vercel's AI Gateway), for every inbox; 1 thread waits to be categorized or summarized");
  });

  test("plain output names the AI check", async () => {
    server.addInbox({ name: "Acme", address: "ana@acme.example" });
    const ran = await run(["doctor"], options);
    assert.match(ran.stdout, /^warn  ai: not set up: /m);
  });
});
