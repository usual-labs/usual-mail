// Every listed icon exists in Hugeicons' free package and was exported for the web and for Swift, and nothing else was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readIconList, shapesSvg, swiftCase, templateSvg } from "../scripts/lib/icons.mjs";
import { DESIGN, ICONS, PACKAGES, SWIFT_SOURCES } from "../scripts/lib/paths.mjs";

const list = readIconList(ICONS);
const free = await import(pathToFileURL(join(PACKAGES, "@hugeicons", "core-free-icons", "dist", "esm", "index.js")).href);
const read = (path) => readFileSync(join(DESIGN, path), "utf8");
const sprite = read("dist/web/icons.svg");
const catalog = `${SWIFT_SOURCES}/Resources/Icons.xcassets`;

test("the list covers what Usual Mail needs", () => {
  const needed = [
    "now", "handled", "inboxes", "people", "reads", "receipts", "screening", "reply-later", "set-aside", "come-back", "done",
    "undo", "approve", "reject", "search", "settings", "compose", "send", "attachment", "rule", "trust-suggest",
    "trust-act-with-undo", "trust-act-silently", "agent", "brief", "back", "forward", "up", "down", "close",
    // Inbox.icon's fourteen, in INBOX_ICONS's order (the eight after the six: the owner's request of 2026-11-20).
    "person", "building", "briefcase", "house", "shop", "globe", "plane", "wallet", "family", "rocket", "school", "heart", "star", "leaf",
  ];
  const names = new Set(list.map((icon) => icon.name));
  for (const name of needed) assert.ok(names.has(name), `icons.json has no "${name}"`);
});

test("every listed icon is an export of the free package", () => {
  for (const icon of list) assert.ok(Array.isArray(free[icon.hugeicons]), `${icon.name}: ${icon.hugeicons} is not in @hugeicons/core-free-icons`);
});

test("the only Hugeicons package is the free one", () => {
  const pkg = JSON.parse(read("package.json"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => name.startsWith("@hugeicons/"));
  assert.deepEqual(deps, ["@hugeicons/core-free-icons"]);
});

test("the web sprite has exactly the listed icons, drawn from the package", () => {
  const ids = [...sprite.matchAll(/<symbol id="icon-([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.sort(), list.map((icon) => icon.name).sort());
  for (const icon of list) {
    const symbol = sprite.match(new RegExp(`<symbol id="icon-${icon.name}"[^>]*>(.*?)</symbol>`))[1];
    assert.equal(symbol, shapesSvg(free[icon.hugeicons]), `${icon.name} in the sprite isn't the package's ${icon.hugeicons}`);
  }
});

test("the asset catalog has exactly the listed icons, as template SVGs", () => {
  for (const icon of list) {
    const contents = JSON.parse(read(`${catalog}/${icon.name}.imageset/Contents.json`));
    assert.equal(contents.properties["template-rendering-intent"], "template", `${icon.name} is not a template`);
    assert.equal(contents.images[0].filename, `${icon.name}.svg`);
    const svg = read(`${catalog}/${icon.name}.imageset/${icon.name}.svg`);
    assert.equal(svg, templateSvg({ shapes: free[icon.hugeicons] }), `${icon.name}.svg isn't the package's ${icon.hugeicons}`);
    assert.doesNotMatch(svg, /currentColor/, "asset catalog SVGs use a solid colour");
  }
});

test("Swift's UsualIcon has a case for each listed icon and no others", () => {
  const swift = read(`${SWIFT_SOURCES}/Generated/UsualIcon.swift`);
  const cases = [...swift.matchAll(/case (\w+) = "([a-z0-9-]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(cases.map(([, raw]) => raw).sort(), list.map((icon) => icon.name).sort());
  for (const [name, raw] of cases) assert.equal(name, swiftCase(raw));
});

test("the MIT licence ships next to the icons on both sides", () => {
  for (const path of ["dist/web/icons-LICENSE.md", `${SWIFT_SOURCES}/Resources/Hugeicons-LICENSE.md`]) {
    assert.match(read(path), /MIT License[\s\S]*Copyright \(c\) \d{4} Hugeicons/);
  }
});
