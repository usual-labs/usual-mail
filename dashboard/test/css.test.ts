// The dashboard's own CSS uses only the design system's variables: no variables, colours, sizes or fonts of its own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const own = readFileSync(new URL("../assets/dashboard.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = readFileSync(new URL("../../design/dist/web/tokens.css", import.meta.url), "utf8");
const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));

/** Each declaration as [property, value], from every rule. */
const declarations = [...own.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)].map((m) => [m[1]!, m[2]!.trim()] as const);

const NAMED_COLOURS =
  /\b(white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|brown|navy|teal|olive|maroon|lime|aqua|fuchsia|gold|beige|ivory|coral|salmon|tomato|crimson|indigo|violet)\b/i;

describe("dashboard.css", () => {
  test("every variable it reads is defined by the design system", () => {
    const used = new Set([...own.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    assert.ok(used.size > 40);
    for (const name of used) assert.ok(defined.has(name), `${name} is not in tokens.css`);
  });

  test("it defines no variables of its own", () => {
    assert.doesNotMatch(own, /(^|[;{\s])--[a-z0-9-]+\s*:/);
  });

  test("it has no colour literals", () => {
    for (const [property, value] of declarations) {
      assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b/i, `${property}: ${value}`);
      assert.doesNotMatch(value, /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i, `${property}: ${value}`);
      if (!/^(display|position|list-style|cursor|user-select|resize|white-space|text-decoration|overflow|font-synthesis|align|justify|flex|clip|transform|transition|-webkit)/.test(property)) {
        assert.doesNotMatch(value, NAMED_COLOURS, `${property}: ${value}`);
      }
    }
  });

  test("it has no lengths of its own: only 0, percentages and multiples of tokens", () => {
    for (const [property, value] of declarations) {
      assert.doesNotMatch(value, /\d(px|rem|em|vh|vw|dvh|svh|vmin|vmax|pt|pc|cm|mm|in|ch|ex|lh)\b/, `${property}: ${value}`);
    }
  });

  test("type comes only from the type roles and font families", () => {
    for (const [property, value] of declarations) {
      if (property === "font") assert.match(value, /^(var\(--type-[a-z]+\)|inherit)$/, value);
      if (property === "font-family") assert.match(value, /^var\(--font-family-[a-z]+\)$/, value);
      if (property === "font-weight") assert.match(value, /^var\(--font-weight-[a-z]+\)$/, value);
      if (property === "font-size" || property === "line-height") assert.fail(`${property} is set directly: ${value}`);
      if (property === "letter-spacing") assert.match(value, /^(var\(--type-[a-z]+-tracking\)|inherit)$/, value);
    }
  });

  test("the hats come from data-hat, not from colours written here", () => {
    assert.match(own, /var\(--hat-fill\)/);
    assert.match(own, /var\(--hat-tint\)/);
    assert.match(own, /var\(--hat-on\)/);
  });
});
