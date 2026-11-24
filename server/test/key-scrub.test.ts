// The key in any form (docs/contract-ai.md, "Status"): the AI's status, events, logs and errors never carry it,
// whether a service wrote it out, in base64 (standard or URL-safe, padded or not, at any alignment), in hexadecimal,
// or spaced out and broken across separators, whole or in recognisable parts.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, test } from "node:test";
import { scrubKey } from "../src/ai/models.ts";
import { failure } from "../src/index.ts";
import { KNOWN, historyFromKnown, makeServer, TEST_KEY, type TestServer } from "./helpers.ts";

const KEY = TEST_KEY;
const b64 = (text: string) => Buffer.from(text).toString("base64");
const b64url = (text: string) => Buffer.from(text).toString("base64url");
const hex = (text: string) => Buffer.from(text).toString("hex");

/** Nothing of the key is left that one could recognise: no run of eight of its characters, in any of its forms. */
function assertNoKey(out: string, what: string): void {
  const forms = [KEY, b64(KEY), b64url(KEY), hex(KEY), hex(KEY).toUpperCase(), b64(`x${KEY}`).slice(4, -4), b64(`xy${KEY}`).slice(4, -4)];
  const skeleton = out.replace(/[^A-Za-z0-9]/g, "");
  for (const form of forms) {
    const bare = form.replace(/[^A-Za-z0-9]/g, "");
    for (let start = 0; start + 8 <= bare.length; start++) {
      const piece = bare.slice(start, start + 8);
      assert.ok(!skeleton.includes(piece), `${what}: "${piece}" of the key (as ${form.slice(0, 12)}…) is still there in "${out}"`);
    }
  }
}

describe("scrubKey", () => {
  const cases: Array<[string, string]> = [
    ["written out", `Incorrect key: ${KEY}.`],
    ["in base64, padded", `Authorization: Basic ${b64(KEY)} refused`],
    ["in base64 without padding", `token=${b64(KEY).replace(/=+$/, "")}`],
    ["in URL-safe base64", `key=${b64url(KEY)}`],
    ["in base64 after a user name (Basic auth)", `Basic ${b64(`user:${KEY}`)} was refused`],
    ["in base64 after one byte", `Basic ${b64(`u${KEY}`)}`],
    ["in base64 after two bytes", `Basic ${b64(`us${KEY}`)}`],
    ["in URL-safe base64 at another alignment", `k=${b64url(`ab:${KEY}:cd`)}`],
    ["in hexadecimal", `key hex ${hex(KEY)} unknown`],
    ["in upper-case hexadecimal", `KEY ${hex(KEY).toUpperCase()}`],
    ["in hexadecimal with separators", `bytes ${hex(KEY).match(/../g)!.join(":")}`],
    ["one character at a time", `the key was ${KEY.split("").join(" ")}`],
    ["broken across separators", `key ${KEY.slice(0, 10)}-\n${KEY.slice(10, 20)} / ${KEY.slice(20)}`],
    ["a recognisable part of it", `the key ending ${KEY.slice(-12)} is wrong`],
    ["a part of it in base64", `chunk ${b64(KEY.slice(6, 30))}`],
  ];
  for (const [what, text] of cases) {
    test(`removes the key ${what}`, () => {
      const out = scrubKey(text, KEY);
      assertNoKey(out, what);
      assert.ok(out.includes("[key]"), `says where the key was: ${out}`);
    });
  }

  test("leaves a service's ordinary words alone", () => {
    const words = "The model example/text-small-2 was not found (request req_8f3a2b1c, status 404).";
    assert.equal(scrubKey(words, KEY), words);
  });
});

describe("the key in the AI's status", () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await makeServer();
  });
  afterEach(() => t.close());

  test("a refusal quoting the key in base64 reaches the status, the event and the log without it", async () => {
    const { inbox } = await t.connect({ address: "me@scrub.example", history: [historyFromKnown] });
    await t.aiOn();
    const events: string[] = [];
    const stop = t.server.subscribe(t.person, (event) => events.push(JSON.stringify(event)));
    t.models.failAll = failure("unavailable", `Upstream said: Basic ${b64(`user:${KEY}`)} and hex ${hex(KEY)} rejected`);
    await t.receive(inbox, { from: KNOWN, subject: "After the key leaked" });
    await t.tick(2_000);
    stop();
    const status = await t.server.aiStatus(t.person);
    assert.equal(status.state, "unavailable");
    assertNoKey(status.detail ?? "", "status");
    for (const event of events) assertNoKey(event, "event");
    for (const line of [...t.errors, ...t.infos]) assertNoKey(line, "log");
  });
});
