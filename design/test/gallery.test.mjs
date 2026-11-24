// The HTML gallery uses only the generated CSS: every colour is a token variable, every variable exists, every icon
// it draws is in its sprite, and it has no script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DESIGN } from "../scripts/lib/paths.mjs";

const html = readFileSync(join(DESIGN, "gallery/index.html"), "utf8");
const tokensCss = readFileSync(join(DESIGN, "dist/web/tokens.css"), "utf8");
const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n") +
  [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join("\n");

test("the gallery has no colour literals of its own", () => {
  assert.doesNotMatch(styles, /#[0-9a-fA-F]{3,8}\b/, "a hex colour in the gallery's CSS");
  assert.doesNotMatch(styles, /\b(rgba?|hsla?|oklch|oklab|lab|lch)\(/, "a colour function in the gallery's CSS");
  assert.doesNotMatch(styles, /[:\s](white|black|gray|grey|red|green|blue)\s*[;)]/, "a named colour in the gallery's CSS");
});

test("every variable the gallery uses is defined by tokens.css", () => {
  const defined = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
  const used = new Set([...styles.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
  for (const name of used) assert.ok(defined.has(name), `${name} is not in tokens.css`);
});

test("every hat the gallery names exists", () => {
  for (const [, hat] of html.matchAll(/data-hat="([a-z]+)"/g)) assert.match(tokensCss, new RegExp(`\\[data-hat="${hat}"\\]`), hat);
});

test("every icon the gallery draws is in its inline sprite", () => {
  const symbols = new Set([...html.matchAll(/<symbol id="(icon-[a-z0-9-]+)"/g)].map((m) => m[1]));
  for (const [, id] of html.matchAll(/<use href="#(icon-[a-z0-9-]+)"/g)) assert.ok(symbols.has(id), `${id} is not in the sprite`);
});

test("the gallery links only the generated CSS and runs no script", () => {
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(links, ["../dist/web/fonts.css", "../dist/web/tokens.css"]);
  for (const link of links) assert.ok(existsSync(join(DESIGN, "gallery", link)), link);
  assert.doesNotMatch(html, /<script/i);
});

test("the gallery shows the four pieces in light and dark", () => {
  for (const id of ["hat", "brief", "pile-row", "reason"]) {
    const section = html.slice(html.indexOf(`<section class="section" id="${id}">`));
    assert.ok(section.length > 0, `no #${id} section`);
    const own = section.slice(0, section.indexOf("</section>", section.indexOf('data-theme="dark"')));
    assert.match(own, /data-theme="light"[\s\S]*data-theme="dark"/, `#${id} is not shown in both appearances`);
  }
});

test("the inline sprite takes no space on the page", () => {
  const tag = html.match(/<svg xmlns="http:\/\/www.w3.org\/2000\/svg"[^>]*>/)[0];
  assert.match(tag, /class="sprite"/);
  assert.match(tag, /width="0"/);
  assert.match(tag, /height="0"/);
  assert.match(tag, /aria-hidden="true"/);
  const rule = styles.match(/\.sprite \{([^}]*)\}/)?.[1] ?? "";
  for (const declaration of ["position: absolute", "width: 0", "height: 0", "overflow: hidden"]) {
    assert.ok(rule.includes(declaration), `.sprite has no "${declaration}"`);
  }
});

test("the gallery shows each sample inbox with its icon", () => {
  const hat = html.slice(html.indexOf('<section class="section" id="hat">'));
  for (const icon of ["building", "shop", "person"]) assert.match(hat, new RegExp(`<use href="#icon-${icon}"/>`), icon);
});
