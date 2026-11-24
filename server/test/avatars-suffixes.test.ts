// The Public Suffix List, read: a host name's registrable domain (the key a sender's logo is kept under), by the
// list's own algorithm (publicsuffix.org/list: exceptions first, then the longest rule, "*" by default), and the list's
// file read into rules. A made-up list of `.example` rules only; the shipped list is checked where it is loaded.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { asciiHost } from "../src/avatars/host.ts";
import { rulesFromList, SuffixList } from "../src/avatars/suffixes.ts";

const LIST = `// A made-up list in the Public Suffix List's own format.
// Lines outside the sections are the file's header.
ignored-before-sections

// ===BEGIN ICANN DOMAINS===
// example : a made-up top level
example
co.example
// a wildcard and its exception, as the list writes "*.ck" and "!www.ck"
*.wild.example
!www.wild.example
公司.example
org.example   this text after the rule is ignored
// ===END ICANN DOMAINS===

// ===BEGIN PRIVATE DOMAINS===
// A hosting platform whose customers each get a subdomain, like github.io
pages.example
*.cloud.example
// ===END PRIVATE DOMAINS===
`;

const rules = rulesFromList(LIST);
const list = new SuffixList(rules);

describe("reading the list's file", () => {
  test("takes the rules of each section, in ASCII, and leaves out comments, blank lines and the header", () => {
    assert.deepEqual(rules.icann, ["example", "co.example", "*.wild.example", "!www.wild.example", `${new URL("http://公司.example").hostname}`, "org.example"]);
    assert.deepEqual(rules.private, ["pages.example", "*.cloud.example"]);
  });

  test("refuses a file without its ICANN section, or with a rule it can't read", () => {
    assert.throws(() => rulesFromList("com\nnet\n"), /ICANN/);
    assert.throws(() => rulesFromList("// ===BEGIN ICANN DOMAINS===\nbad_rule!\n// ===END ICANN DOMAINS===\n"), /bad_rule/);
    assert.throws(() => rulesFromList("// ===BEGIN ICANN DOMAINS===\n*.*.example\n// ===END ICANN DOMAINS===\n"), /\*\.\*/);
  });
});

describe("a host's registrable domain", () => {
  test("is the public suffix and one label more", () => {
    assert.equal(list.registrableDomain("brand.example"), "brand.example");
    assert.equal(list.registrableDomain("news.mail.brand.example"), "brand.example");
    assert.equal(list.registrableDomain("shop.co.example"), "shop.co.example");
    assert.equal(list.registrableDomain("em.shop.co.example"), "shop.co.example");
  });

  test("is none for a public suffix itself", () => {
    assert.equal(list.registrableDomain("example"), null);
    assert.equal(list.registrableDomain("co.example"), null);
    assert.equal(list.publicSuffix("co.example"), "co.example");
  });

  test("follows a wildcard and its exception", () => {
    assert.equal(list.publicSuffix("a.wild.example"), "a.wild.example");
    assert.equal(list.registrableDomain("a.wild.example"), null);
    assert.equal(list.registrableDomain("shop.a.wild.example"), "shop.a.wild.example");
    assert.equal(list.registrableDomain("www.wild.example"), "www.wild.example", "the exception is registrable");
    assert.equal(list.registrableDomain("x.www.wild.example"), "www.wild.example");
  });

  test("treats a platform's customers as separate sites, unless asked to read the ICANN section alone", () => {
    assert.equal(list.registrableDomain("someone.pages.example"), "someone.pages.example");
    assert.equal(list.registrableDomain("mail.someone.pages.example"), "someone.pages.example");
    assert.equal(list.registrableDomain("b.a.cloud.example"), "b.a.cloud.example");
    const icannOnly = new SuffixList(rules, { private: false });
    assert.equal(icannOnly.registrableDomain("someone.pages.example"), "pages.example");
  });

  test("uses the default rule for a top level the list doesn't know", () => {
    assert.equal(list.registrableDomain("mail.brand.unknown"), "brand.unknown");
    assert.equal(list.registrableDomain("unknown"), null);
  });

  test("reads names in any case, with a trailing dot, or international, as their ASCII form", () => {
    assert.equal(list.registrableDomain("News.Brand.EXAMPLE."), "brand.example");
    const idn = new URL("http://bränd.example").hostname;
    assert.equal(list.registrableDomain("mail.bränd.example"), idn);
    assert.equal(list.registrableDomain("shop.公司.example"), `shop.${new URL("http://公司.example").hostname}`);
  });

  test("is none for what isn't a host name: addresses, empty labels, odd characters, overlong names", () => {
    for (const host of ["192.0.2.1", "[2001:db8::1]", "2001:db8::1", "brand..example", ".brand.example", "brand.example/x", "a@brand.example", "brand example", "", "-brand.example", `${"a".repeat(64)}.example`, `${"a.".repeat(127)}example`, "0x7f.1"]) {
      assert.equal(list.registrableDomain(host), null, host);
    }
  });
});

describe("host names in ASCII", () => {
  test("lower case, without a trailing dot, international names in their xn-- form", () => {
    assert.equal(asciiHost("Brand.Example."), "brand.example");
    assert.match(asciiHost("bränd.example") ?? "", /^xn--/);
    assert.equal(asciiHost("127.0.0.1"), null);
    assert.equal(asciiHost("localhost"), "localhost", "a single label is a host name; the caller decides what it may be");
  });
});
