/**
 * The picture pass: finding the pictures sanitized mail takes from the web, and writing the HTML again with each one
 * shown from the server, held back or taken out. Made-up mail only; nothing is fetched.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Parser } from "htmlparser2";
import { isTinyOrHidden } from "../../src/message/picture-refs.ts";
import { canonicalPictureUrl, remotePictures, rewritePictures, type PictureDecision, type RemotePicture } from "../../src/message/pictures.ts";
import { sanitizeHtml } from "../../src/message/sanitize.ts";
import { assertSafe, HOSTILE } from "./hostile-html.ts";

const PATH = /^\/v1\/messages\/m1\/pictures\/p\d+$/;

/** A hook that shows every picture from a numbered path, remembering what it was asked. */
function showing(): { seen: RemotePicture[]; hook: (picture: RemotePicture) => PictureDecision } {
  const seen: RemotePicture[] = [];
  return { seen, hook: (picture) => (seen.push(picture), { kind: "show", src: `/v1/messages/m1/pictures/p${seen.length}` }) };
}

/**
 * Fails when anything in the HTML could still load from the web: an attribute, a style attribute or a style block.
 * Read without trusting any CSS reader: CSS escapes are resolved and comment markers left in place, then no
 * "http:", "https:" or "//" may be left once the server's own picture paths are set aside.
 */
function assertNothingRemote(html: string, input: string): void {
  const problems: string[] = [];
  const unescaped = (css: string) => css
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16) || 0xfffd))
    .replace(/\\(.)/g, "$1");
  const remoteCss = (css: string) => /https?:|\/\//i.test(unescaped(css).replace(/\/v1\/messages\/m1\/pictures\/p\d+/g, ""));
  let inStyle = false;
  const parser = new Parser({
    onopentag(name, attribs) {
      if (name === "style") inStyle = true;
      for (const attr of ["src", "background"]) {
        const value = attribs[attr]?.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
        if (value && /^(?:https?:|\/\/|\\)/.test(value)) problems.push(`${name} ${attr}=${value}`);
      }
      if (attribs.style && remoteCss(attribs.style)) problems.push(`style="${attribs.style}"`);
    },
    ontext(text) {
      if (inStyle && remoteCss(text)) problems.push(`style block ${text}`);
    },
    onclosetag(name) {
      if (name === "style") inStyle = false;
    },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();
  assert.deepEqual(problems, [], `for input ${input}\noutput: ${html}`);
}

const NEWSLETTER = sanitizeHtml([
  `<style>.hero{background-image:url('https://news.example/bg.png')} @font-face{font-family:F;src:url(https://fonts.example/f.woff2)}</style>`,
  `<table><tr><td background="//news.example/td.png#frag">`,
  `<img src="https://news.example/hero.png" alt="Hero" width="600">`,
  `<div style="background:url(https://news.example/div.png) #fff no-repeat">x</div>`,
  `<img src="cid:logo@news.example"><img src="data:image/png;base64,AA==">`,
  `<img src="https://open.example/o.gif" width="1" height="1" alt="">`,
  `</td></tr></table>`,
].join(""))!;

describe("finding pictures from the web", () => {
  it("finds every kind in order, style blocks last, without cid: or data: pictures", () => {
    assert.deepEqual(remotePictures(NEWSLETTER), [
      { url: "https://news.example/td.png", site: "background", tiny: false },
      { url: "https://news.example/hero.png", site: "img", tiny: false },
      { url: "https://news.example/div.png", site: "css", tiny: false },
      { url: "https://open.example/o.gif", site: "img", tiny: true },
      { url: "https://news.example/bg.png", site: "css", tiny: false },
    ]);
  });

  it("takes addresses as a browser would, and refuses ones that can't be fetched", () => {
    assert.equal(canonicalPictureUrl(" //NEWS.example/a b.png#x "), "https://news.example/a%20b.png");
    assert.equal(canonicalPictureUrl("http://news.example:80/a.png"), "http://news.example/a.png");
    assert.equal(canonicalPictureUrl("https://user:secret@news.example/a.png"), null);
    assert.equal(canonicalPictureUrl("https://"), null);
    assert.equal(canonicalPictureUrl("ftp://news.example/a.png"), null);
  });
});

describe("writing the HTML again", () => {
  it("points shown pictures at the server and takes fonts from the web out", () => {
    const { seen, hook } = showing();
    const out = rewritePictures(NEWSLETTER, hook);
    assert.equal(seen.length, 5);
    assert.match(out, /<td background="\/v1\/messages\/m1\/pictures\/p1">/);
    assert.match(out, /<img src="\/v1\/messages\/m1\/pictures\/p2" alt="Hero" width="600" \/>/);
    assert.match(out, /style="background:url\(&quot;\/v1\/messages\/m1\/pictures\/p3&quot;\) #fff no-repeat"/);
    assert.match(out, /\.hero\{background-image:url\("\/v1\/messages\/m1\/pictures\/p5"\)\}/);
    assert.match(out, /@font-face\{font-family:F\}/, "the font's source from the web is gone");
    assert.match(out, /<img src="cid:logo@news\.example" \/><img src="data:image\/png;base64,AA==" \/>/);
    assertNothingRemote(out, NEWSLETTER);
  });

  it("holds pictures back: an <img> keeps its place and alt text, a background goes, CSS becomes none", () => {
    const out = rewritePictures(NEWSLETTER, () => ({ kind: "hold" }));
    assert.match(out, /<img alt="Hero" width="600" \/>/);
    assert.match(out, /<td>/);
    assert.match(out, /style="background:none #fff no-repeat"/);
    assert.match(out, /\.hero\{background-image:none\}/);
    assertNothingRemote(out, NEWSLETTER);
  });

  it("takes a removed <img> out whole, alt text and all", () => {
    const html = sanitizeHtml(`<p>a<img src="https://open.example/o.gif" alt="tracker words">b</p>`)!;
    assert.equal(rewritePictures(html, () => ({ kind: "remove" })), "<p>ab</p>");
  });

  it("decides each picture in image-set(), and leaves cid: and data: pictures in CSS alone", () => {
    const html = sanitizeHtml(`<style>a{background-image:-webkit-image-set("https://x.example/a.png" 1x,"https://x.example/b.png" 2x)} b{background:url(cid:c@d)} i{background:url(data:image/png;base64,AA==)}</style>`)!;
    const { hook } = showing();
    const out = rewritePictures(html, hook);
    assert.match(out, /-webkit-image-set\("\/v1\/messages\/m1\/pictures\/p1" 1x,"\/v1\/messages\/m1\/pictures\/p2" 2x\)/);
    assert.match(out, /b\{background:url\(cid:c@d\)\} i\{background:url\(data:image\/png;base64,AA==\)\}/);
    assert.match(rewritePictures(html, () => ({ kind: "hold" })), /a\{background-image:none\}/);
  });

  it("drops a declaration that hides an address behind escapes, without asking the hook", () => {
    const html = `<div style="background:url(ht\\74 ps://x.example/a.png)">x</div>`;
    const { seen, hook } = showing();
    const out = rewritePictures(sanitizeHtml(html)!, hook);
    assert.equal(out, "<div>x</div>");
    assert.equal(seen.length, 0);
  });

  it("holds an address with a user name, and a decision that points back at the web", () => {
    const html = sanitizeHtml(`<img src="https://u:p@x.example/a.png" alt="a"><img src="https://x.example/b.png" alt="b">`)!;
    let asked = 0;
    const out = rewritePictures(html, () => (asked++, { kind: "show", src: "https://elsewhere.example/b.png" }));
    assert.equal(out, `<img alt="a" /><img alt="b" />`);
    assert.equal(asked, 1, "the address with a user name never reaches the hook");
  });

  it("leaves HTML without pictures from the web as it was", () => {
    const html = sanitizeHtml(`<p>Hi <a href="https://x.example/">there</a><img src="cid:a@b"></p>`)!;
    let asked = 0;
    assert.equal(rewritePictures(html, () => (asked++, { kind: "hold" })), html);
    assert.equal(asked, 0);
  });
});

describe("CSS that hides a picture from the web (the security review of 2026-11-18)", () => {
  const cases: Array<[string, string, string[]]> = [
    ["a url() nested in image-set() after a string",
      `<div style='background-image:image-set("data:image/png;base64,AA" 1x, url(//evil.example/a1.png) 2x)'>x</div>`,
      ["https://evil.example/a1.png"]],
    ["a url() nested in image-set() in a style block",
      `<style>.x{background-image:image-set("data:image/png;base64,AA" 1x, url(https://evil.example/a1b.png) 2x)}</style><p class=x>x</p>`,
      ["https://evil.example/a1b.png"]],
    ["a url() nested in -webkit-image-set()",
      `<div style='background-image:-webkit-image-set("data:image/png;base64,AA" 1x, url(https://evil.example/a1c.png) 2x)'>x</div>`,
      ["https://evil.example/a1c.png"]],
    ["a ')' inside a string in image-set()",
      `<div style='background-image:image-set("cid:a" 1x, "https://evil.example/a).png" 2x)'>x</div>`,
      ["https://evil.example/a).png"]],
    ["two url() in cross-fade()",
      `<div style="background:cross-fade(url(https://evil.example/c1.png), url(https://evil.example/c2.png))">x</div>`,
      ["https://evil.example/c1.png", "https://evil.example/c2.png"]],
    // The CSS reader takes the unclosed bracket as broken, so the style goes when the message is read.
    ["an unclosed url() at the end of the attribute",
      `<div style="background:url(https://evil.example/unclosed.png">x</div>`,
      []],
  ];
  for (const [label, input, urls] of cases) {
    it(`finds and decides ${label}`, () => {
      const stored = sanitizeHtml(input)!;
      assert.deepEqual(remotePictures(stored).map((p) => p.url), urls);
      for (const hook of [showing().hook, () => ({ kind: "hold" }) as const, () => ({ kind: "remove" }) as const]) {
        assertNothingRemote(rewritePictures(stored, hook), input);
      }
    });
  }

  const hidden: Array<[string, string]> = [
    ["a layer hidden by comment markers inside strings", `<div style='background:url("cid:a/*"), url("https://evil.example/b1.png"), url("*/")'>x</div>`],
    ["the same in a style block", `<style>p{background:url("cid:a/*"), url("//evil.example/b1b.png"), url("*/")}</style><p>x</p>`],
    ["comment markers inside image-set() strings", `<div style='background-image:image-set("cid:x/*" 1x, "https://evil.example/b2.png" 2x, "*/" 3x)'>x</div>`],
    ["a font hidden by comment markers", `<style>@font-face{font-family:F;src:url("data:font/woff2;base64,AA/*"), url("https://evil.example/b3.woff2"), url("*/")}</style><p>x</p>`],
    ["a font behind a data:image/ decoy", `<style>@font-face{font-family:F;src:url("data:image/png;base64,AA/*"), url("https://evil.example/b4.woff2"), url("*/")}</style><p>x</p>`],
    ["an address in a custom property used by var()", `<div style='--u:"https://evil.example/a3.png";background-image:image-set("cid:a" 1x, var(--u) 2x)'>x</div>`],
    ["an escaped url() name", `<div style="background:\\75 rl(https://evil.example/escaped-name.png)">x</div>`],
  ];
  for (const [label, input] of hidden) {
    it(`loads nothing from the web: ${label}`, () => {
      // As stored by a reader from before the fix too: the served pass must hold on its own.
      for (const stored of [sanitizeHtml(input) ?? "", input]) {
        for (const hook of [showing().hook, () => ({ kind: "hold" }) as const, () => ({ kind: "remove" }) as const]) {
          assertNothingRemote(rewritePictures(stored, hook), input);
        }
      }
    });
  }

  it("drops any declaration with a string that names the web, whatever holds it", () => {
    // A custom property could hand such a string to image-set(); bare tokens like --v's can't load anything.
    const html = `<div style='content:"https://evil.example/x"; --u:"HTTP:x"; --v://evil.example/y; color:red'>x</div><style>p{quotes:"//" "\\201C"; color:blue}</style>`;
    const out = rewritePictures(html, showing().hook);
    assert.match(out, /^<div style="--v:\/\/evil\.example\/y;color:red">x<\/div><style>p\{\s*color:blue\}<\/style>$/);
  });

  it("keeps escapes that load nothing: bullets, icon glyphs, escaped font names, quotes", () => {
    const html = sanitizeHtml([
      `<style>li:before{content:"\\2022"} .i:before{font-family:icons;content:"\\f101"}</style>`,
      `<p style="font-family:'\\5FAE\\8F6F\\96C5\\9ED1',Arial;color:#333">x</p>`,
      `<div style="grid-template-areas:'a b' 'c d';quotes:'\\201C' '\\201D'">y</div>`,
    ].join(""))!;
    assert.equal(rewritePictures(html, showing().hook), html);
  });

  it("drops SVG pictures in CSS, data: ones too: no SVG anywhere", () => {
    for (const svg of ["data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E", "data:image/svg+xml,%3Csvg%3E%3C/svg%3E", "DATA:image/SVG+xml;base64,PHN2Zz4="]) {
      const html = sanitizeHtml(`<div style="background-image:url(&quot;${svg}&quot;);color:red">x</div>`)!;
      assert.equal(rewritePictures(html, showing().hook), `<div style="color:red">x</div>`, svg);
    }
  });

  it("drops a whole style block that would still load something outside a declaration", () => {
    const html = `<style>p:not(url(https://evil.example/s.png)){color:red} a{color:blue}</style><p>x</p>`;
    assert.equal(rewritePictures(html, showing().hook), "<p>x</p>");
  });

  it("drops a declaration whose new address could break out of its CSS string", () => {
    const html = sanitizeHtml(`<div style="background:url(https://x.example/a.png)">x</div>`)!;
    for (const src of [`/v1/a"b`, "/v1/a)b", "/v1/a b", "/v1/a\\b", "/v1/a'b"]) {
      const out = rewritePictures(html, () => ({ kind: "show", src }));
      assert.equal(out, `<div>x</div>`, src);
    }
  });

  it("drops a declaration whose name isn't a name, and reads the whole served attribute again", () => {
    for (const nl of ["\n", "\r", "\f", "&#10;"]) {
      const html = `<div style='x"a${nl};background:url(https://evil.example/p.png);b"y: red;color:blue'>x</div>`;
      assert.equal(rewritePictures(html, showing().hook), `<div style="color:blue">x</div>`, JSON.stringify(nl));
    }
  });

  it("drops a declaration whose address is neither a picture's path nor cid: or data:image/", () => {
    // Stored by an older reader, these would load something other than a picture of the message.
    for (const css of [`background:url("/v1/messages/other/pictures/x")`, `background:url(file:///etc/passwd)`, `background:image-set("a.png" 1x)`]) {
      assert.equal(rewritePictures(`<div style='${css}'>x</div>`, showing().hook), "<div>x</div>", css);
    }
  });
});

describe("tiny or hidden pictures", () => {
  const cases: Array<[Record<string, string>, boolean]> = [
    [{ width: "1", height: "1" }, true],
    [{ width: "1px", height: "1px" }, true],
    [{ width: "1" }, true],
    [{ height: "0", width: "600" }, true],
    [{ style: "display: none" }, true],
    [{ style: "visibility:hidden" }, true],
    [{ style: "opacity: 0" }, true],
    [{ style: "width: 1px; height: 1px" }, true],
    [{ style: "max-height: 0px" }, true],
    [{ width: "1", height: "20" }, false],
    [{ width: "600", height: "200" }, false],
    [{ width: "100%" }, false],
    [{ style: "opacity: 0.5" }, false],
    [{}, false],
  ];
  for (const [attribs, tiny] of cases) {
    it(`${JSON.stringify(attribs)} is ${tiny ? "" : "not "}tiny or hidden`, () => {
      assert.equal(isTinyOrHidden(attribs), tiny);
    });
  }

  it("a width reads as before 0.1.3, when three runs of spaces in the pattern took cubic time", () => {
    for (const [width, tiny] of [[" 1 px ", true], ["1 PX !important", true], ["1 ! important", true], ["\n1\n", true], ["1 x", false], ["1px!importantx", false]] as const) {
      assert.equal(isTinyOrHidden({ width }), tiny, JSON.stringify(width));
    }
    const before = (value: string) => {
      const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*(?:!\s*important)?\s*$/i.exec(value);
      return match !== null && Number(match[1]) <= 1;
    };
    const parts = ["1", "0", ".", " ", "\n", "px", "!", "important", "x", "\u00a0"];
    for (let round = 0; round < 5_000; round++) {
      const width = Array.from({ length: Math.floor(Math.random() * 8) }, () => parts[Math.floor(Math.random() * parts.length)]).join("");
      assert.equal(isTinyOrHidden({ width }), before(width), JSON.stringify(width));
    }
  });
});

describe("hostile mail through the picture pass", () => {
  for (const input of HOSTILE) {
    it(`stays safe and loads nothing from the web: ${input.slice(0, 60)}`, () => {
      const stored = sanitizeHtml(input);
      if (stored === undefined) return;
      for (const hook of [showing().hook, () => ({ kind: "hold" }) as const, () => ({ kind: "remove" }) as const]) {
        const out = rewritePictures(stored, hook);
        assertSafe(out || undefined, input, PATH);
        assertNothingRemote(out, input);
      }
    });
  }
});
