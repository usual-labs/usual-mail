// Reading a message stays linear in its length (0.1.3, after a security review): requests are
// built and snippets made under the server's lock, so a 1 MB body built to make a pattern scan back and forth must not
// hold it. The address pattern a summary request removes addresses with was unbounded (128 KB without an "@" took 55
// seconds); the snippet's markdown link read past a "[" ("[](mailto:" over 1 MB took 68 seconds). The sweep that followed
// found the same in the checks of a model's answers (an unclosed tag), a party's name (a run of commas), a List-Id and
// the tracker list. Also: cutting the text before taking addresses out never leaves part of one in what is sent.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SUBJECT_LIMIT } from "@usualmail/core";
import { categorizeRequest, cutWithoutAddresses, summarizeRequest, withoutAddresses } from "../src/ai/prompt.ts";
import { BODIES, within } from "./linear.ts";

describe("in linear time on a 1 MB body", () => {
  // Each in a worker that is stopped at 10 seconds, so a slow pattern fails rather than hangs the suite (test/linear.ts).
  for (const name of Object.keys(BODIES)) {
    test(name, { timeout: 15_000 }, async () => {
      const took = await within(10_000, "requests", name);
      assert.ok(took < 3_000, `${name}: ${took.toFixed(0)} ms`);
    });
  }
});

describe("a model's answers, names, List-Ids and pictures' addresses, on a 1 MB body", () => {
  for (const name of Object.keys(BODIES)) {
    test(name, { timeout: 15_000 }, async () => {
      const took = await within(10_000, "answers", name);
      assert.ok(took < 3_000, `${name}: ${took.toFixed(0)} ms`);
    });
  }
});

describe("the one-time code check and the readers it uses, on a 1 MB body", () => {
  for (const name of Object.keys(BODIES)) {
    test(name, { timeout: 15_000 }, async () => {
      const took = await within(10_000, "gate", name);
      assert.ok(took < 3_000, `${name}: ${took.toFixed(0)} ms`);
    });
  }
});

describe("cutting before taking addresses out", () => {
  test("an address across the limit is taken out whole, never cut and left", () => {
    const text = `${"x".repeat(195)} victim@inbox.example and more`;
    const out = cutWithoutAddresses(text, 200);
    assert.ok(out.length <= 200);
    assert.ok(!out.includes("victim"), out);
  });

  test("no part of an address cut at the window's end comes within the limit once others shrink", () => {
    const out = cutWithoutAddresses("u@d.example ".repeat(100), 200);
    assert.ok(!out.includes("@"), out);
    assert.equal(out, "[address] ".repeat(20));
  });

  test("a long run of letters right before an address keeps its words and loses the address (Thai, Japanese)", () => {
    const out = withoutAddresses(`${"ก".repeat(300)}alice@mail.example ok`);
    assert.ok(!out.includes("alice"), out);
    assert.ok(out.endsWith("[address] ok"));
    assert.ok(out.startsWith("ก".repeat(200)), "the words before it stay");
    assert.equal(withoutAddresses(`${"x".repeat(70)}@y.example`), "[address]", "a local part too long for mail is still taken whole");
  });

  test("an address across the cut, inside a run that goes on past the room, isn't left in part", () => {
    const text = `x ${"ก".repeat(190)}alice@mail.example${"ก".repeat(1_000)}`;
    const out = cutWithoutAddresses(text, 200);
    assert.ok(!out.includes("alice") && !out.includes("@"), out);
    assert.equal(out, "x [address]", "the address taken out whole");
    const long = cutWithoutAddresses(`${"ก".repeat(500)}alice@mail.example${"ก".repeat(1_000)}`, 450);
    assert.ok(!long.includes("alice") && !long.includes("@"), long);
    assert.equal(long, `${"ก".repeat(441)}[address]`, "a run longer than a local part keeps its words up to the address's last 64 characters");
  });

  test("a long run with no address near the cut keeps its words to the limit", () => {
    assert.equal(cutWithoutAddresses("a".repeat(6_000), 3_000), "a".repeat(3_000));
  });

  test("short text is replaced as before", () => {
    assert.equal(cutWithoutAddresses("Write to a@b.example today", 200), "Write to [address] today");
  });

  test("a subject is cut to its limit before it is sent", () => {
    const request = categorizeRequest("m", { subject: "s".repeat(5_000), from: { email: "a@b.example" }, listId: null, automated: false, text: "", html: null }, "id");
    const item = JSON.parse(request.data.split("\n")[1]!) as { subject: string };
    assert.equal(item.subject.length, SUBJECT_LIMIT);
    const summary = summarizeRequest("m", `${"s".repeat(990)} victim@inbox.example`, [], "id");
    assert.ok(!summary.data.includes("victim"));
  });
});
