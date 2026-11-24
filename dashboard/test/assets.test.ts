// The embedded copy of design/dist/web is current, is what the handler serves, and covers what the pages use.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ASSET_PATHS, ASSETS, ICON_NAMES } from "../src/generated/assets.ts";
import { HATS, hatFor } from "../src/hats.ts";
import { PAGES, setup } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = fileURLToPath(new URL("../../design/dist/web/", import.meta.url));
const designFile = (name: string) => readFileSync(`${web}${name}`);

async function served(path: string): Promise<Response> {
  return setup().get(path, { token: null });
}

describe("embedded assets", () => {
  test("the generated module is what scripts/embed.mjs would write now", () => {
    const run = spawnSync(process.execPath, ["scripts/embed.mjs", "--check"], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  });

  test("fonts, the icon sprite and the licences are served byte for byte as design/dist/web has them", async () => {
    const pairs: Array<[string, string]> = [
      ["fonts/Geist-Variable.woff2", "fonts/Geist-Variable.woff2"],
      ["fonts/GeistSerif-Regular.woff2", "fonts/GeistSerif-Regular.woff2"],
      ["fonts/Prociono-Regular.ttf", "fonts/Prociono-Regular.ttf"],
      ["icons.svg", "icons.svg"],
      ["licences/Geist-OFL.txt", "fonts/Geist-OFL.txt"],
      ["licences/Prociono-OFL.txt", "fonts/Prociono-OFL.txt"],
      ["licences/icons-LICENSE.md", "icons-LICENSE.md"],
    ];
    for (const [name, source] of pairs) {
      const res = await served(ASSET_PATHS[name]!);
      assert.equal(res.status, 200, name);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), designFile(source), name);
    }
    const font = await served(ASSET_PATHS["fonts/Geist-Variable.woff2"]!);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.equal(font.headers.get("cache-control"), "public, max-age=31536000, immutable");
  });

  test("the stylesheet is fonts.css, tokens.css and dashboard.css, with font links to the served fonts", async () => {
    const res = await served(ASSET_PATHS["app.css"]!);
    assert.equal(res.headers.get("content-type"), "text/css; charset=utf-8");
    const css = await res.text();
    assert.ok(css.includes(designFile("tokens.css").toString("utf8")));
    assert.ok(css.includes(readFileSync(`${root}assets/dashboard.css`, "utf8")));
    const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!);
    assert.equal(urls.length, 3);
    for (const url of urls) {
      const path = new URL(url, `http://x${ASSET_PATHS["app.css"]}`).pathname;
      assert.ok(ASSETS[path], `${url} resolves to an embedded font`);
    }
  });

  test("asset paths carry a content hash; an unknown one is not found, and none needs a session", async () => {
    for (const path of Object.values(ASSET_PATHS)) assert.match(path, /^\/assets\/[\w/-]+\.[0-9a-f]{10}\.\w+$/);
    assert.equal((await served("/assets/app.0000000000.css")).status, 404);
  });

  test("every icon the pages use is in the sprite", async () => {
    const app = setup();
    const used = new Set<string>();
    for (const path of PAGES) for (const m of (await app.page(path)).body.matchAll(/#icon-([a-z-]+)"/g)) used.add(m[1]!);
    assert.ok(used.size > 10);
    for (const name of used) assert.ok(ICON_NAMES.includes(name), `icon-${name}`);
  });
});

describe("hats", () => {
  test("the twelve hats come from tokens.css, keyed by their light fill", () => {
    const light = designFile("tokens.css").toString("utf8").split("@media")[0]!;
    assert.equal(HATS.length, 12);
    for (const hat of HATS) assert.ok(light.includes(`--color-hat-${hat.name}-fill: ${hat.key};`), hat.name);
  });

  test("a stored colour shows as its nearest hat, as the design package matches it", () => {
    // design/docs: the fixture's three colours land on blue, green and orange.
    assert.equal(hatFor("#2F6FED").name, "blue");
    assert.equal(hatFor("#1F8A5B").name, "green");
    assert.equal(hatFor("#C2541D").name, "orange");
    for (const hat of HATS) assert.equal(hatFor(hat.key.toUpperCase()).name, hat.name, "a key matches itself");
    assert.equal(hatFor("not a colour").name, "slate");
  });
});
