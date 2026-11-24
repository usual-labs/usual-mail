// Finding a site's icons in its page and its web app manifest: bounded reading (the head only, at most 50 links, a
// size cap on the manifest), `<base>` ignored, SVG and unusable addresses left out, and the order in which the
// candidates are tried. Discovery only names candidates: whether an address may be fetched (a private one, say) is the
// fetcher's address rule's to decide, so discovery hands such addresses on unchanged. Made-up `.example` pages only.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DISCOVERY_LIMITS, fallbackIcons, iconsInManifest, iconsInPage, rankIcons, type IconCandidate } from "../src/avatars/discover.ts";

const PAGE = "https://www.brand.example/home";

const page = (head: string, body = "<p>Hello</p>") => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

describe("icons named by a page", () => {
  test("reads each kind of icon link, with its declared size and type", () => {
    const found = iconsInPage(
      page(`
        <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
        <LINK REL="Shortcut Icon" HREF="/favicon.ico">
        <link rel=apple-touch-icon href=/apple-180.png sizes=180x180>
        <link rel="apple-touch-icon-precomposed" href="https://cdn.brand.example/touch.png">
        <link rel="manifest" href="/site.webmanifest">`),
      PAGE,
    );
    assert.deepEqual(found, {
      icons: [
        { url: "https://www.brand.example/favicon-32.png", kind: "icon", size: 32, type: "image/png" },
        { url: "https://www.brand.example/favicon.ico", kind: "icon", size: 0 },
        { url: "https://www.brand.example/apple-180.png", kind: "touch", size: 180 },
        { url: "https://cdn.brand.example/touch.png", kind: "touch", size: 0 },
      ],
      manifest: "https://www.brand.example/site.webmanifest",
    });
  });

  test("resolves addresses against the page as fetched, ignoring <base>, and decodes entities in them", () => {
    const found = iconsInPage(page(`<base href="https://evil.example/"><link rel="icon" href="icons/a.png?v=1&amp;s=2"><link rel="icon" href="//cdn.brand.example/b.png">`), PAGE);
    assert.deepEqual(found.icons.map((icon) => icon.url), ["https://www.brand.example/icons/a.png?v=1&s=2", "https://cdn.brand.example/b.png"]);
  });

  test("leaves out SVG icons, mask icons, empty and unusable addresses", () => {
    const found = iconsInPage(
      page(`
        <link rel="icon" href="/logo.svg">
        <link rel="icon" href="/logo" type="image/svg+xml">
        <link rel="mask-icon" href="/mask.png">
        <link rel="icon" href="">
        <link rel="icon">
        <link rel="icon" href="javascript:alert(1)">
        <link rel="icon" href="file:///etc/passwd">
        <link rel="icon" href="ftp://brand.example/a.png">
        <link rel="icon" href="data:image/svg+xml;base64,PHN2Zz4=">
        <link rel="icon" href="/ok.png">`),
      PAGE,
    );
    assert.deepEqual(found.icons.map((icon) => icon.url), ["https://www.brand.example/ok.png"]);
  });

  test("keeps a small inline PNG or ICO, and drops one too long", () => {
    const small = `data:image/png;base64,${"A".repeat(100)}`;
    const big = `data:image/png;base64,${"A".repeat(DISCOVERY_LIMITS.dataLength + 1)}`;
    const found = iconsInPage(page(`<link rel="icon" href="${small}"><link rel="icon" href="${big}"><link rel="icon" href="data:image/x-icon;base64,AAABAA==">`), PAGE);
    assert.deepEqual(found.icons.map((icon) => icon.url), [small, "data:image/x-icon;base64,AAABAA=="]);
  });

  test("hands on an address that names a private host: the fetcher's rule decides, not discovery", () => {
    const found = iconsInPage(page(`<link rel="icon" href="http://127.0.0.1/a.png"><link rel="icon" href="http://169.254.169.254/latest"><link rel="manifest" href="http://10.0.0.1/m.json">`), PAGE);
    assert.deepEqual(found.icons.map((icon) => icon.url), ["http://127.0.0.1/a.png", "http://169.254.169.254/latest"]);
    assert.equal(found.manifest, "http://10.0.0.1/m.json");
  });

  test("reads the head only: links after </head> or once the body starts count for nothing", () => {
    assert.deepEqual(iconsInPage(`<html><head></head><link rel="icon" href="/late.png">`, PAGE).icons, []);
    assert.deepEqual(iconsInPage(`<html><body><link rel="icon" href="/late.png">`, PAGE).icons, []);
    assert.equal(iconsInPage(`<html><head><link rel="icon" href="/a.png"></HEAD ><link rel="icon" href="/b.png">`, PAGE).icons.length, 1);
  });

  test("isn't fooled by links inside comments, scripts, styles, titles or templates", () => {
    const found = iconsInPage(
      page(`
        <!-- <link rel="icon" href="/commented.png"> -->
        <!-- a comment with > inside <link rel="icon" href="/commented-too.png"> -->
        <script>document.write('<link rel="icon" href="/scripted.png">'); // </head></script>
        <style>/* <link rel="icon" href="/styled.png"> */</style>
        <title><link rel="icon" href="/titled.png"></title>
        <template><link rel="icon" href="/template.png"></template>
        <SCRIPT type="text/x-template"><link rel="icon" href="/x.png"></SCRIPT>
        <link rel="icon" href="/real.png">`),
      PAGE,
    );
    assert.deepEqual(found.icons.map((icon) => icon.url), ["https://www.brand.example/real.png"]);
  });

  test("reads at most 50 links, and the first manifest only", () => {
    const links = Array.from({ length: 60 }, (_, i) => `<link rel="icon" href="/i${i}.png">`).join("");
    const found = iconsInPage(page(`${links}<link rel="manifest" href="/late.webmanifest">`), PAGE);
    assert.equal(found.icons.length, DISCOVERY_LIMITS.links);
    assert.equal(found.manifest, undefined, "the 61st link isn't read");
    assert.equal(iconsInPage(page(`<link rel="manifest" href="/a.json"><link rel="manifest" href="/b.json">`), PAGE).manifest, "https://www.brand.example/a.json");
  });

  test("takes the largest of the declared sizes, and none for 'any' or nonsense", () => {
    const found = iconsInPage(page(`<link rel="icon" href="/a.png" sizes="16x16 48X48 32x32"><link rel="icon" href="/b.png" sizes="any"><link rel="icon" href="/c.png" sizes="99999x99999 12x"><link rel="icon" href="/d.png" sizes="64x128">`), PAGE);
    assert.deepEqual(found.icons.map((icon) => icon.size), [48, 0, 0, 128]);
  });

  test("copes with broken markup without throwing", () => {
    const broken = [
      `<head><link rel="icon" href="/a.png`,
      `<head><link rel='icon' href='/a.png'`,
      `<head><link`,
      `<head><!-- never closed <link rel="icon" href="/a.png">`,
      `<head><script><link rel="icon" href="/a.png">`,
      `<head><link rel="icon" href="/a.png" href="/b.png" rel="manifest">`,
      "<".repeat(100_000),
      `<head>${"<link ".repeat(10_000)}`,
      `<head><link ${"a=b ".repeat(10_000)} rel="icon" href="/z.png">`,
      "\u0000<head>￿<link rel=\"icon\" href=\"/\u0000.png\">",
    ];
    for (const html of broken) assert.doesNotThrow(() => iconsInPage(html, PAGE), html.slice(0, 40));
    assert.deepEqual(iconsInPage(broken[5]!, PAGE).icons.map((icon) => icon.url), ["https://www.brand.example/a.png"], "the first of a repeated attribute counts");
  });

  test("stays fast however many scripts the head has, and keeps its place past characters whose lower case is longer", () => {
    const scripts = `<html><head>${"<script></script>".repeat(30_000)}<link rel="icon" href="/a.png">`;
    const started = Date.now();
    assert.equal(iconsInPage(scripts, PAGE).icons.length, 1);
    assert.ok(Date.now() - started < 1_000);
    const turkish = `<html><head><title>${"İ".repeat(50)}</title><script>${"İ".repeat(50)}</SCRIPT><link rel="icon" href="/b.png">`;
    assert.deepEqual(iconsInPage(turkish, PAGE).icons.map((icon) => icon.url), ["https://www.brand.example/b.png"]);
    const right = `<html><head><title>${"İ".repeat(100)}</title><link rel="icon" href="/c.png"><link rel="icon" href="/d.png">`;
    assert.deepEqual(iconsInPage(right, PAGE).icons.map((icon) => icon.url), ["https://www.brand.example/c.png", "https://www.brand.example/d.png"], "nothing skipped");
  });

  test("reads a huge page in bounded time and only its first part", () => {
    const filler = "<meta name=x content=y>".repeat(40_000);
    const html = `<html><head>${filler}<link rel="icon" href="/far.png"></head>`;
    const started = Date.now();
    const found = iconsInPage(html, PAGE);
    assert.ok(Date.now() - started < 1_000);
    assert.deepEqual(found.icons, [], "a link beyond the first 512 KB isn't read");
  });
});

describe("icons named by a web app manifest", () => {
  const MANIFEST = "https://www.brand.example/static/site.webmanifest";

  test("reads its icons, resolved against the manifest, with purpose, size and type", () => {
    const icons = iconsInManifest(
      JSON.stringify({
        name: "Brand",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "both.png", sizes: "256x256", purpose: "any maskable" },
          { src: "mono.png", sizes: "512x512", purpose: "monochrome" },
          { src: "logo.svg", sizes: "any", type: "image/svg+xml" },
        ],
      }),
      MANIFEST,
    );
    assert.deepEqual(icons, [
      { url: "https://www.brand.example/static/icon-192.png", kind: "icon", size: 192, type: "image/png" },
      { url: "https://www.brand.example/maskable-512.png", kind: "maskable", size: 512, type: "image/png" },
      { url: "https://www.brand.example/static/both.png", kind: "maskable", size: 256 },
    ]);
  });

  test("hands on icons at private addresses unchanged: the fetcher decides", () => {
    const icons = iconsInManifest(JSON.stringify({ icons: [{ src: "http://192.168.1.1/router.png", sizes: "192x192" }, { src: "http://[::1]/a.png" }] }), MANIFEST);
    assert.deepEqual(icons.map((icon) => icon.url), ["http://192.168.1.1/router.png", "http://[::1]/a.png"]);
  });

  test("gives nothing for a manifest too large, not JSON, or of the wrong shape", () => {
    const tooLarge = JSON.stringify({ icons: [{ src: "a.png" }], pad: "x".repeat(DISCOVERY_LIMITS.manifestLength) });
    for (const text of [tooLarge, "not json", "null", "[]", "42", `{"icons": "a.png"}`, `{"icons": {"src": "a.png"}}`, `{"icons": [null, 1, "a.png", {"src": 5}, {"src": ""}]}`]) {
      assert.deepEqual(iconsInManifest(text, MANIFEST), [], text.slice(0, 30));
    }
  });

  test("reads at most 50 icons, and copes with deep nesting and huge strings", () => {
    const many = JSON.stringify({ icons: Array.from({ length: 80 }, (_, i) => ({ src: `i${i}.png` })) });
    assert.equal(iconsInManifest(many, MANIFEST).length, DISCOVERY_LIMITS.manifestIcons);
    const deep = `{"icons":[${"[".repeat(30_000)}${"]".repeat(30_000)}]}`;
    assert.doesNotThrow(() => iconsInManifest(deep, MANIFEST));
    const longSrc = JSON.stringify({ icons: [{ src: `https://brand.example/${"a".repeat(DISCOVERY_LIMITS.urlLength)}.png` }, { src: "ok.png", sizes: "x".repeat(20_000) }] });
    assert.deepEqual(iconsInManifest(longSrc, MANIFEST).map((icon) => [icon.url, icon.size]), [["https://www.brand.example/static/ok.png", 0]]);
  });
});

describe("the order icons are tried in", () => {
  const icon = (url: string, kind: IconCandidate["kind"], size: number, type?: string): IconCandidate => ({ url, kind, size, ...(type && { type }) });

  test("prefers a sharp icon of a sensible size, then a maskable one, a touch icon, then any other", () => {
    const ranked = rankIcons([
      icon("https://b.example/16.png", "icon", 16),
      icon("https://b.example/unknown.png", "icon", 0),
      icon("https://b.example/192.png", "icon", 192),
      icon("https://b.example/touch-180.png", "touch", 180),
      icon("https://b.example/mask-192.png", "maskable", 192),
      icon("https://b.example/huge.png", "icon", 4096),
      icon("https://b.example/1024.png", "icon", 1024),
      icon("https://b.example/48.png", "icon", 48),
    ]);
    assert.deepEqual(ranked.map((found) => found.url.slice("https://b.example/".length)), [
      "mask-192.png", "touch-180.png", "192.png", // 64 to 512 pixels: maskable, touch, then others
      "1024.png", "huge.png", // larger: the smallest first
      "unknown.png", // unknown size
      "48.png", "16.png", // smaller: the largest first
    ]);
  });

  test("tries an ICO after a PNG of the same standing, and each address once", () => {
    const ranked = rankIcons([
      icon("https://b.example/favicon.ico", "icon", 0),
      icon("https://b.example/x", "icon", 0, "image/x-icon"),
      icon("https://b.example/a.png", "icon", 0),
      icon("https://b.example/a.png", "touch", 180),
    ]);
    assert.deepEqual(ranked.map((found) => found.url.slice("https://b.example/".length)), ["a.png", "favicon.ico", "x"]);
    assert.equal(ranked[0]!.kind, "touch");
  });

  test("falls back to the conventional addresses at the site's root", () => {
    assert.deepEqual(fallbackIcons("https://www.brand.example/some/page?x=1"), [
      { url: "https://www.brand.example/apple-touch-icon.png", kind: "touch", size: 0 },
      { url: "https://www.brand.example/favicon.ico", kind: "icon", size: 0 },
    ]);
  });
});
