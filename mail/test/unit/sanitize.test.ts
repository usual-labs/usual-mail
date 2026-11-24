/**
 * The HTML sanitizer against hostile input. Every output is parsed again and checked against the
 * allow-list, so a vector that slips through in a new shape still fails the test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeHtml } from "../../src/message/sanitize.ts";
import { sanitizeStyleAttribute, sanitizeStylesheet } from "../../src/message/css.ts";
import { assertSafe, HOSTILE } from "./hostile-html.ts";

describe("sanitizeHtml", () => {
  for (const input of HOSTILE) {
    it(`neutralises ${input.slice(0, 70)}`, () => {
      assertSafe(sanitizeHtml(input), input);
    });
  }

  it("keeps the HTML a newsletter needs", () => {
    const input = [
      `<html><head><style>.btn{background:#0a66c2;color:#fff} @media (max-width:600px){.col{width:100%!important}}</style></head>`,
      `<body><table width="600" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#ffffff" style="border-collapse:collapse">`,
      `<tr><td class="col" valign="top" background="https://news.example/bg.png" style="padding:8px 16px;font-family:Georgia,serif">`,
      `<h1 style="margin:0">Hello</h1><p>Read <a href="https://news.example/a?x=1&amp;y=2" title="Article">this</a> or `,
      `<a href="mailto:hi@news.example">write</a>, <a href="#top">top</a>.</p>`,
      `<img src="https://news.example/hero.jpg" alt="Hero" width="600" height="200" style="display:block">`,
      `<img src="cid:logo@news.example" alt="Logo"><font face="Arial" color="#333" size="2">Small print</font>`,
      `</td></tr></table></body></html>`,
    ].join("");
    const out = sanitizeHtml(input)!;
    assertSafe(out, input);
    assert.match(out, /<style>\.btn\{background:#0a66c2;color:#fff\} @media \(max-width:600px\)\{\.col\{width:100%!important\}\}<\/style>/);
    assert.match(out, /<table width="600" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#ffffff" style="border-collapse:collapse">/);
    assert.match(out, /<td class="col" valign="top" background="https:\/\/news\.example\/bg\.png" style="padding:8px 16px;font-family:Georgia,serif">/);
    assert.match(out, /<a href="https:\/\/news\.example\/a\?x=1&amp;y=2" title="Article">this<\/a>/);
    assert.match(out, /<a href="mailto:hi@news\.example">write<\/a>/);
    assert.match(out, /<a href="#top">top<\/a>/);
    assert.match(out, /<img src="https:\/\/news\.example\/hero\.jpg" alt="Hero" width="600" height="200" style="display:block" \/>/);
    assert.match(out, /<img src="cid:logo@news\.example" alt="Logo" \/>/);
    assert.match(out, /<font face="Arial" color="#333" size="2">Small print<\/font>/);
  });

  it("keeps data: pictures and drops other data: URLs", () => {
    const out = sanitizeHtml(`<img src="data:image/png;base64,iVBORw0KGgo="><img src="data:text/plain,hi">`)!;
    assert.equal(out, `<img src="data:image/png;base64,iVBORw0KGgo=" /><img />`);
  });

  it("returns undefined when nothing is left", () => {
    assert.equal(sanitizeHtml("<script>alert(1)</script>"), undefined);
    assert.equal(sanitizeHtml("   "), undefined);
  });
});

describe("CSS filter", () => {
  it("keeps ordinary declarations and drops dangerous ones", () => {
    assert.equal(sanitizeStyleAttribute("color: red; background: url(https://x.example/a.png); width: expression(1)"), "color:red;background:url(https://x.example/a.png)");
    assert.equal(sanitizeStyleAttribute("background-image: url('cid:abc')"), "background-image:url('cid:abc')");
    assert.equal(sanitizeStyleAttribute("background: url(/relative.png)"), undefined);
    assert.equal(sanitizeStyleAttribute("color: red !important"), "color:red !important");
    assert.equal(sanitizeStyleAttribute("not css at all {{{"), undefined);
  });

  it("reads addresses as a browser does: a url() holds one string, and comment markers inside strings are text", () => {
    assert.equal(sanitizeStyleAttribute(`background: url("cid:a" "https://x.example/b.png")`), undefined);
    assert.equal(sanitizeStyleAttribute(`background: url("cid:a/*"), url("ftp://x.example/b"), url("*/")`), undefined);
    assert.equal(sanitizeStyleAttribute(`content: "/* not a comment */"; color: red`), `content:"/* not a comment */";color:red`);
    assert.equal(sanitizeStyleAttribute(`background: image-set("cid:a" 1x, "https://x.example/a).png" 2x)`), `background:image-set("cid:a" 1x, "https://x.example/a).png" 2x)`);
  });

  it("refuses a declaration whose name isn't a name, and reads the whole attribute again", () => {
    assert.equal(sanitizeStyleAttribute(`x"a\n;background:url(javascript:alert(1));b"y: red; color: blue`), "color:blue");
    assert.equal(sanitizeStyleAttribute(`b\\61 ckground: red; --my-var: 1; -webkit-box-shadow: none; mso-line-height-rule: exactly`), "--my-var:1;-webkit-box-shadow:none;mso-line-height-rule:exactly");
    assert.match(sanitizeStylesheet(`p{x"a\n;background:url(javascript:alert(1));b"y: red; color: blue}`)!, /^p\{\s*color: blue\}$/);
  });

  it("writes a value as it was checked, without its comments", () => {
    // postcss keeps such a comment in the value's raw text, which it would otherwise write out.
    assert.equal(sanitizeStylesheet("a{background:url(cid:a)/* y */ red}"), "a{background:url(cid:a) red}");
  });

  it("caps how deep rules nest: deeper ones go, and nothing overflows the stack", () => {
    const deep = (n: number, inner: string) => `${"@media all{".repeat(n)}${inner}${"}".repeat(n)}`;
    for (const n of [3000, 20_000]) assert.doesNotThrow(() => sanitizeStylesheet(deep(n, "p{color:red}")));
    assert.equal(sanitizeStylesheet(deep(8, "p{color:red}")), deep(8, "p{color:red}"));
    assert.equal(sanitizeStylesheet(deep(40, "p{color:red}")), undefined);
  });

  it("drops at-rules that load or hide things, and escapes markup", () => {
    assert.equal(sanitizeStylesheet("@import 'x.css'; @charset 'utf-8'; @font-face{font-family:X;src:url(https://f.example/x.woff)} a{color:red}"), "@font-face{font-family:X;src:url(https://f.example/x.woff)} a{color:red}");
    assert.equal(sanitizeStylesheet(`a::after{content:"<b>"}`), `a::after{content:"\\3c b>"}`);
    assert.equal(sanitizeStylesheet("a{color:red"), undefined, "an unclosed block drops the sheet");
    assert.equal(sanitizeStylesheet(`a{content:"unclosed}`), undefined, "a broken string drops the sheet");
  });
});
