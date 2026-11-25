// Taking addresses out of a summary request (src/ai/addresses.ts; 0.1.3, after a security review): names
// with combining marks, full-width at signs and ideographic dots, domains of many labels or long labels, each taken out
// whole; and a cut inside a long run of address characters never leaves the start of an address, whether two addresses
// are joined in the run or a local part is made of characters that take two UTF-16 units each.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cutWithoutAddresses, withoutAddresses } from "../src/ai/addresses.ts";

describe("unusual addresses, taken out whole", () => {
  for (const [why, address] of [
    ["Thai, with combining marks", "สมศักดิ์@mail.example"],
    ["Hindi, in its domain too", "राम@डाटामेल.भारत"],
    ["a decomposed é", "émile@mail.example"],
    ["a full-width at sign", "user＠mail.example"],
    ["an ideographic dot", "user@mail。example"],
    ["a full-width dot", "user@mail．example"],
    ["more than eleven labels", "u@a.b.c.d.e.f.g.h.i.j.k.l.m.example"],
    ["a label over 63 characters", `u@${"x".repeat(70)}.example`],
  ] as const) {
    test(why, () => {
      assert.equal(withoutAddresses(`Write to ${address} today.`), "Write to [address] today.");
    });
  }
});

describe("a cut inside a long run of address characters", () => {
  test("two addresses joined in the run: the first one's start isn't left", () => {
    // "uuuuuuuu@x.example_vv@y.example" then letters on past the cut and its room.
    const text = `${"w ".repeat(141)}uuuuuuuu@x.example_vv@y.example${"z".repeat(4_000)}`;
    const out = cutWithoutAddresses(text, 1_000);
    assert.ok(!out.includes("u") && !out.includes("@"), out.slice(-40));
    assert.equal(out, "w ".repeat(141), "cut before both, the run's start included");
  });

  test("an address joined to one whose @ is just past the cut", () => {
    const text = `${"w ".repeat(400)}aa@x.example+bb@y.example${"z".repeat(4_000)}`;
    for (const limit of [800, 803, 806, 812, 815, 818]) {
      const out = cutWithoutAddresses(text, limit);
      assert.ok(!/[ab]+@/.test(out) && !out.includes("@"), `${limit}: ${out.slice(-30)}`);
    }
  });

  test("a local part of characters that take two units each, its @ more than 256 units past the cut", () => {
    const local = "𠀀".repeat(250);
    const text = `w ${local}@mail.example${"𠀀".repeat(2_000)}`;
    const out = cutWithoutAddresses(text, 102);
    assert.ok(!out.includes("𠀀"), `${[...out].length} characters of the local part left`);
    assert.equal(out, "w ");
  });

  test("a long run with no address near the cut keeps its words to the limit, never half a character", () => {
    assert.equal(cutWithoutAddresses("a".repeat(6_000), 3_000), "a".repeat(3_000));
    const halves = cutWithoutAddresses("𠀀".repeat(4_000), 3_001);
    assert.ok(!/[\ud800-\udbff]$/.test(halves), "no half character at the end");
  });
});
