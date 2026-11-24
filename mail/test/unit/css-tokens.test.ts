/**
 * The CSS reader, token by token, against what CSS Syntax Level 3 says a browser reads: every rule the picture pass
 * and the sanitizer rely on has a test here, so a weakened reader fails (the security review of 2026-11-18).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cssAddresses, cssTokens, decodeCss, MAX_ADDRESSES_PER_VALUE } from "../../src/message/css-tokens.ts";

const types = (css: string) => cssTokens(css).map((t) => t.type);
const urls = (css: string) => cssAddresses(css)?.map((a) => a.value) ?? null;

describe("strings", () => {
  it("a newline, carriage return or form feed ends a string unclosed, and marks it bad", () => {
    for (const nl of ["\n", "\r", "\f"]) {
      const tokens = cssTokens(`"a${nl}b"`);
      assert.equal(tokens[0]!.type, "string");
      assert.equal((tokens[0] as { bad: boolean }).bad, true, JSON.stringify(nl));
      assert.equal((tokens[0] as { value: string }).value, "a");
    }
  });

  it("an escaped newline continues a string; comment markers inside are text", () => {
    const [token] = cssTokens(`"a\\\nb/*c*/"`);
    assert.deepEqual({ type: token!.type, value: (token as { value: string }).value, bad: (token as { bad: boolean }).bad }, { type: "string", value: "ab/*c*/", bad: false });
  });

  it("escapes resolve, a bad code point becomes U+FFFD", () => {
    assert.equal((cssTokens(`"\\2022 x"`)[0] as { value: string }).value, "•x");
    assert.equal((cssTokens(`"\\D800"`)[0] as { value: string }).value, "�");
  });
});

describe("url tokens and functions", () => {
  it("url( in any case and through escapes is a url", () => {
    assert.deepEqual(urls(`url(a.png) URL(b.png) Url("c.png") u\\72l(d.png) \\75 RL(e.png)`), ["a.png", "b.png", "c.png", "d.png", "e.png"]);
  });

  it("an unquoted url( broken by whitespace, a quote or a bracket is bad", () => {
    for (const css of [`url(a b)`, `url(a"b)`, `url(a(b)`, `url(a\u0001b)`]) {
      const token = cssTokens(css).find((t) => t.type === "url");
      assert.equal((token as { bad: boolean } | undefined)?.bad, true, css);
      assert.equal(urls(css), null, css);
    }
    assert.equal((cssTokens(`url(  a.png  )`)[0] as { bad: boolean }).bad, false, "spaces around the address are fine");
  });

  it("an unclosed url( runs to the end, as a browser closes it", () => {
    assert.deepEqual(urls(`url(https://x.example/a.png`), ["https://x.example/a.png"]);
  });

  it("src() is a loading function like url(), and holds one string", () => {
    assert.deepEqual(urls(`src("a.png")`), ["a.png"]);
    assert.equal(urls(`src(a.png)`), null);
    assert.equal(urls(`url("a" "b")`), null);
  });

  it("strings are addresses only directly inside image-set(), image() and cross-fade(), in any case", () => {
    assert.deepEqual(urls(`IMAGE-SET("a.png" 1x, url(b.png) 2x) -webkit-image-set("c.png" 1x) image("d.png") cross-fade("e.png", "f.png")`), ["a.png", "b.png", "c.png", "d.png", "e.png", "f.png"]);
    assert.deepEqual(urls(`content: "g.png"; font-family: "h"; format("woff2") local("i")`), []);
    assert.deepEqual(urls(`image-set(type("image/png") "j.png" 1x)`), ["j.png"]);
  });

  it("a bad string anywhere makes the value unreadable", () => {
    assert.equal(urls(`color: red; content: "a\nb"`), null);
  });

  it(`more than ${MAX_ADDRESSES_PER_VALUE} addresses in one value is too many to read`, () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `url(a${i}.png)`).join(",");
    assert.equal(urls(many(MAX_ADDRESSES_PER_VALUE))?.length, MAX_ADDRESSES_PER_VALUE);
    assert.equal(urls(many(MAX_ADDRESSES_PER_VALUE + 1)), null);
    assert.equal(cssAddresses(many(MAX_ADDRESSES_PER_VALUE + 1), { max: Infinity })?.length, MAX_ADDRESSES_PER_VALUE + 1);
  });
});

describe("comments and decoding", () => {
  it("comments go only outside strings and url tokens", () => {
    assert.equal(decodeCss(`a/* x */b "c/*d*/" url(e/*f*/)`), `ab "c/*d*/" url(e/*f*/)`);
    assert.deepEqual(types(`/* x */a`), ["comment", "ident"]);
  });
});
