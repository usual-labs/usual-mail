// The generator is deterministic and what is checked in is what it writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, generate } from "../scripts/lib/outputs.mjs";

const asBuffer = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));

test("two runs produce the same files, byte for byte", async () => {
  const [first, second] = [await generate(), await generate()];
  assert.deepEqual(Object.keys(first).sort(), Object.keys(second).sort());
  for (const path of Object.keys(first)) {
    assert.ok(asBuffer(first[path]).equals(asBuffer(second[path])), `${path} differs between runs`);
  }
});

test("the checked-in files are current: nothing missing, changed or stale", async () => {
  const { missing, changed, extra } = compare(await generate());
  assert.deepEqual({ missing, changed, extra }, { missing: [], changed: [], extra: [] }, "run `npm run build` in design/");
});

test("text output has no timestamps, absolute paths or carriage returns", async () => {
  const out = await generate();
  for (const [path, value] of Object.entries(out)) {
    if (Buffer.isBuffer(value)) continue;
    assert.doesNotMatch(value, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, `${path} has a timestamp`);
    assert.doesNotMatch(value, /\/Users\/|\/home\/|[A-Z]:\\/, `${path} has an absolute path`);
    assert.doesNotMatch(value, /\r/, `${path} has a carriage return`);
    assert.ok(value.endsWith("\n"), `${path} doesn't end with a newline`);
  }
});

test("tokens.css has every colour in light, dark by preference and dark by attribute", async () => {
  const css = (await generate())["dist/web/tokens.css"];
  const blocks = {
    light: css.slice(css.indexOf(':root,\n[data-theme="light"]'), css.indexOf("@media (prefers-color-scheme: dark)")),
    preferred: css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf('[data-theme="dark"] {')),
    attribute: css.slice(css.indexOf('[data-theme="dark"] {'), css.indexOf("/* Values that are the same")),
  };
  for (const [name, block] of Object.entries(blocks)) {
    for (const variable of ["--color-background", "--color-ink", "--color-meta", "--color-hat-blue-fill", "--elevation-raised"]) {
      assert.match(block, new RegExp(`${variable}:`), `${variable} missing from the ${name} block`);
    }
  }
  assert.match(blocks.preferred, /:root:not\(\[data-theme="light"\]\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*--motion-duration-base: 0ms/);
  assert.doesNotMatch(css.slice(css.indexOf("prefers-reduced-motion")), /--motion-duration-fade/, "fades keep their duration");
});
