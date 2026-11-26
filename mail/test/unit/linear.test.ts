/**
 * Reading mail stays linear in its length (0.1.3, after a security review). A message is read under the server's lock
 * and never stored when reading it fails or stalls, so a slow read repeats on every sync: a Message-ID of 256 KB of ">"
 * took 25.6 s (`stripBrackets`), and 1 MB of "<b>" 42.6 s in the sanitizer, because htmlparser2 searches every open
 * element at each tag. The server's picture pass reads a message's HTML again each time it's opened. Each piece of
 * work runs in a worker stopped at its limit (test/unit/linear.ts), so a slow one fails rather than hangs the suite.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HTML, MAX_PARSED_HTML, MB, SIGNED, within, type Input } from "./linear.ts";

/** Each reader within 3 seconds; the whole worker is stopped at 30. */
async function fast(input: Input): Promise<void> {
  const took = await within(30_000, "html", input);
  for (const [reader, ms] of Object.entries(took)) assert.ok(ms < 3_000, `${reader}: ${ms.toFixed(0)} ms on ${input.shape}`);
}

const BOTH = new Set(["<b> never closed", "<span> never closed", "<div><span> never closed", "closing tags that close nothing, at the deepest", "<b>, then as many </i>"]);

describe("HTML nested, closed wrongly or full of pictures, at 1 MB and at the most a parser reads", () => {
  for (const shape of Object.keys(HTML)) {
    for (const length of BOTH.has(shape) ? [MB, MAX_PARSED_HTML] : [MAX_PARSED_HTML]) {
      test(`${shape}, ${length === MB ? "1 MB" : "the cap"}`, { timeout: 40_000 }, () => fast({ shape, length }));
    }
  }

  test("three times the cap: read only up to it", { timeout: 40_000 }, () => fast({ shape: "<b> never closed", length: 3 * MAX_PARSED_HTML }));
});

describe("header values", () => {
  test("message ids of a megabyte of \">\", and a whole message's Message-ID, In-Reply-To, References and Content-ID", { timeout: 20_000 }, async () => {
    const { headers } = await within(15_000, "headers");
    assert.ok(headers! < 3_000, `${headers!.toFixed(0)} ms`);
  });

  test("a forwarded message's Content-Transfer-Encoding of a megabyte of \"(\", in the large-message rebuild", { timeout: 20_000 }, async () => {
    const { rebuild } = await within(15_000, "rebuild");
    assert.ok(rebuild! < 3_000, `${rebuild!.toFixed(0)} ms`);
  });
});

describe("headers the screening gate reads, about 1.5 MB or 30,000 lines each, within what the parser reads (0.1.4)", () => {
  for (const shape of Object.keys(SIGNED)) {
    test(shape, { timeout: 40_000 }, async () => {
      const took = await within(30_000, "signed", { shape, length: 0 });
      for (const [reader, ms] of Object.entries(took)) assert.ok(ms < 3_000, `${reader}: ${ms.toFixed(0)} ms on ${shape}`);
    });
  }
});
