/**
 * Whether the mailbox provider's own checker proved the From domain: the topmost Authentication-Results only, from the
 * trusted checker only, read by RFC 8601's grammar; an aligned DMARC pass, or an aligned DKIM pass when there is no
 * DMARC result at all. Made-up `.example` domains only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import PostalMime from "postal-mime";
import {
  fromAuthentication,
  fromCheckOf,
  parseAuthenticationResults,
  type AuthenticationOptions,
  type HeaderField,
} from "../../src/message/auth-results.ts";

/** A stand-in for the Public Suffix List: the last two labels, or three under `co.example`. */
const organisationalDomain = (domain: string): string | null => {
  const labels = domain.split(".");
  const take = labels.slice(-2).join(".") === "co.example" ? 3 : 2;
  return labels.length >= take ? labels.slice(-take).join(".") : null;
};

const GMAIL: AuthenticationOptions = { checker: "mx.google.com", organisationalDomain };

/** Header fields, top first, the way a parser hands them over. */
const fields = (...pairs: Array<[string, string]>): HeaderField[] => pairs.map(([key, value]) => ({ key, value }));

/** Gmail's own header as it writes it, folded the way its parser leaves it (line breaks taken out, spaces kept). */
const gmail = (results: string) => `mx.google.com;\n       ${results}`;

const passing = gmail(
  "dkim=pass header.i=@brand.example header.s=s1 header.b=AbCd1234;\n       spf=pass (google.com: domain of bounce@em.brand.example designates 192.0.2.10 as permitted sender) smtp.mailfrom=bounce@em.brand.example;\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=brand.example",
);

const check = (results: string, from = "Brand <news@brand.example>", options = GMAIL) =>
  fromAuthentication(fields(["authentication-results", results], ["from", from]), options);

describe("the From domain proved by the provider's own checker", () => {
  it("is proved by an aligned DMARC pass in Gmail's own header", () => {
    assert.deepEqual(check(passing), { result: "verified", domain: "brand.example", by: "dmarc" });
  });

  it("is the From address's own domain, a sending subdomain included", () => {
    const results = gmail("dkim=pass header.i=@brand.example; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=news.brand.example");
    assert.deepEqual(check(results, "news@news.brand.example"), { result: "verified", domain: "news.brand.example", by: "dmarc" });
  });

  it("isn't proved when DMARC passed for another domain than the one shown", () => {
    const results = gmail("dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=other.example");
    assert.deepEqual(check(results), { result: "unverified", reason: "not_aligned" });
    const unnamed = gmail("dmarc=pass (p=REJECT sp=REJECT dis=NONE)");
    assert.deepEqual(check(unnamed), { result: "unverified", reason: "not_aligned" });
  });

  it("compares with the address the parser shows, not a name that looks like an address", () => {
    // The display name names brand.example; the address shown is evil.example's.
    assert.deepEqual(check(passing, "news@brand.example <other@evil.example>"), { result: "unverified", reason: "not_aligned" });
    assert.deepEqual(check(passing, `"Brand, Inc. <fake@evil.example>" <news@brand.example>`), { result: "verified", domain: "brand.example", by: "dmarc" });
  });

  it("is never proved when any DMARC result failed, whatever else passed", () => {
    const failed = gmail("dkim=pass header.i=@brand.example; dmarc=fail (p=QUARANTINE sp=QUARANTINE dis=QUARANTINE) header.from=brand.example");
    assert.deepEqual(check(failed), { result: "unverified", reason: "dmarc_failed" });
    const both = gmail("dmarc=pass header.from=brand.example; dmarc=fail header.from=brand.example");
    assert.deepEqual(check(both), { result: "unverified", reason: "dmarc_failed" });
  });

  it("isn't proved by a DMARC result other than pass or fail", () => {
    for (const result of ["none", "temperror", "permerror", "bestguesspass", "neutral"]) {
      assert.deepEqual(check(gmail(`dkim=pass header.i=@brand.example; dmarc=${result} header.from=brand.example`)), { result: "unverified", reason: "no_pass" }, result);
    }
  });
});

describe("the word a provider message carries", () => {
  it("is proved only for the address the parser shows, whatever the header proved", () => {
    const headers = fields(["authentication-results", passing], ["from", "Brand <news@brand.example>"]);
    assert.deepEqual(fromCheckOf(headers, "news@brand.example", GMAIL), { result: "verified", domain: "brand.example" });
    assert.deepEqual(fromCheckOf(headers, "news@other.example", GMAIL), { result: "unverified" });
    assert.deepEqual(fromCheckOf(headers, "", GMAIL), { result: "unverified" });
    assert.deepEqual(fromCheckOf(fields(["from", "news@brand.example"]), "news@brand.example", GMAIL), { result: "no_header" });
  });
});

describe("the DKIM fallback, only when there is no DMARC result at all", () => {
  it("is proved by a DKIM pass whose signing domain shares the From domain's organisation", () => {
    const results = gmail("dkim=pass header.i=@brand.example header.s=s1; spf=pass smtp.mailfrom=bounce@esp.example");
    assert.deepEqual(check(results, "news@mail.brand.example"), { result: "verified", domain: "mail.brand.example", by: "dkim" });
    const byD = gmail("dkim=pass header.d=mail.brand.example");
    assert.deepEqual(check(byD), { result: "verified", domain: "brand.example", by: "dkim" });
  });

  it("uses the organisational domain, not the last two labels, through the given function", () => {
    const same = gmail("dkim=pass header.i=@shop.co.example");
    assert.deepEqual(check(same, "a@news.shop.co.example"), { result: "verified", domain: "news.shop.co.example", by: "dkim" });
    const other = gmail("dkim=pass header.i=@other.co.example");
    assert.deepEqual(check(other, "a@shop.co.example"), { result: "unverified", reason: "no_pass" });
    const suffixOnly = gmail("dkim=pass header.d=co.example");
    assert.deepEqual(check(suffixOnly, "a@shop.co.example"), { result: "unverified", reason: "no_pass" });
  });

  it("isn't proved by a signature from the sending service's own domain, or a failed one, or SPF alone", () => {
    assert.deepEqual(check(gmail("dkim=pass header.i=@esp.example")), { result: "unverified", reason: "no_pass" });
    assert.deepEqual(check(gmail("dkim=fail header.i=@brand.example")), { result: "unverified", reason: "no_pass" });
    assert.deepEqual(check(gmail("spf=pass smtp.mailfrom=bounce@brand.example")), { result: "unverified", reason: "no_pass" });
  });

  it("doesn't apply once there is any DMARC result", () => {
    assert.deepEqual(check(gmail("dkim=pass header.i=@brand.example; dmarc=none header.from=brand.example")), { result: "unverified", reason: "no_pass" });
  });
});

describe("which header counts", () => {
  it("is the topmost Authentication-Results only: a forged pass lower down counts for nothing", () => {
    const forgedBelow = fields(
      ["authentication-results", gmail("dkim=none; dmarc=fail (p=REJECT sp=REJECT dis=REJECT) header.from=brand.example")],
      ["received", "from mail.evil.example by mx.google.com"],
      ["authentication-results", gmail("dmarc=pass header.from=brand.example")],
      ["from", "news@brand.example"],
    );
    assert.deepEqual(fromAuthentication(forgedBelow, GMAIL), { result: "repeated" });
    const silentTop = fields(
      ["authentication-results", gmail("spf=softfail smtp.mailfrom=a@evil.example")],
      ["authentication-results", gmail("dmarc=pass header.from=brand.example")],
      ["from", "news@brand.example"],
    );
    assert.deepEqual(fromAuthentication(silentTop, GMAIL), { result: "repeated" });
  });

  it("is the trusted checker's: another checker on top is no evidence, and a pass of the checker's name below it doesn't help", () => {
    const otherOnTop = fields(
      ["authentication-results", "mx.other.example; dmarc=pass header.from=brand.example"],
      ["authentication-results", gmail("dmarc=pass header.from=brand.example")],
      ["from", "news@brand.example"],
    );
    assert.deepEqual(fromAuthentication(otherOnTop, GMAIL), { result: "other_checker" });
  });

  it("reads the checker's name without regard to case, quoted or with a version", () => {
    assert.equal(check("MX.Google.Com; dmarc=pass header.from=brand.example").result, "verified");
    assert.equal(check(`"mx.google.com"; dmarc=pass header.from=brand.example`).result, "verified");
    assert.equal(check("mx.google.com 1; dmarc=pass header.from=brand.example").result, "verified");
    assert.equal(check("mx.google.com.; dmarc=pass header.from=brand.example").result, "verified");
  });

  it("is missing when there is none, whatever ARC or a Received line say", () => {
    const none = fields(
      ["arc-authentication-results", "i=1; mx.google.com; dmarc=pass header.from=brand.example"],
      ["received-spf", "pass (google.com: domain of a@brand.example designates 192.0.2.10 as permitted sender)"],
      ["from", "news@brand.example"],
    );
    assert.deepEqual(fromAuthentication(none, GMAIL), { result: "no_header" });
  });

  it("matches header names without regard to case, as a parser may hand them over", () => {
    const upper = fields(["Authentication-Results", passing], ["From", "news@brand.example"]);
    assert.equal(fromAuthentication(upper, GMAIL).result, "verified");
  });

  it("ignores a header inside an attached message", async () => {
    const raw = [
      "From: Brand <news@brand.example>",
      "To: someone@inbox.example",
      "Subject: Fwd",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      "See attached.",
      "--b1",
      "Content-Type: message/rfc822",
      "",
      "Authentication-Results: mx.google.com; dmarc=pass header.from=brand.example",
      "From: news@brand.example",
      "Subject: inner",
      "",
      "Inner body.",
      "--b1--",
      "",
    ].join("\r\n");
    const email = await PostalMime.parse(raw);
    assert.deepEqual(fromAuthentication(email.headers, GMAIL), { result: "no_header" });
  });

  it("reads Gmail's header folded over lines, from a whole message", async () => {
    const raw = [
      "Delivered-To: someone@inbox.example",
      "Received: by 2002:a05:0000:0:0:0:0:0 with SMTP id x; Mon, 16 Nov 2026 10:00:00 -0800 (PST)",
      "ARC-Authentication-Results: i=1; mx.google.com;",
      "       dkim=pass header.i=@brand.example header.s=s1 header.b=AbCd1234;",
      "       spf=pass (google.com: domain of bounce@em.brand.example designates 192.0.2.10 as permitted sender) smtp.mailfrom=bounce@em.brand.example;",
      "       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=brand.example",
      "Return-Path: <bounce@em.brand.example>",
      "Received: from mail.brand.example (mail.brand.example. [192.0.2.10])",
      "        by mx.google.com with ESMTPS id y",
      "Received-SPF: pass (google.com: domain of bounce@em.brand.example designates 192.0.2.10 as permitted sender) client-ip=192.0.2.10;",
      "Authentication-Results: mx.google.com;",
      "       dkim=pass header.i=@brand.example header.s=s1 header.b=AbCd1234;",
      "       spf=pass (google.com: domain of bounce@em.brand.example designates 192.0.2.10 as permitted sender) smtp.mailfrom=bounce@em.brand.example;",
      "       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=brand.example",
      "Authentication-Results: relay.other.example; spf=pass smtp.mailfrom=bounce@em.brand.example",
      "From: Brand <news@brand.example>",
      "Subject: Hello",
      "",
      "Body.",
      "",
    ].join("\r\n");
    const email = await PostalMime.parse(raw);
    assert.deepEqual(fromAuthentication(email.headers, GMAIL), { result: "verified", domain: "brand.example", by: "dmarc" });
  });

  it("reads values that still carry their line breaks, as an API may hand them over", () => {
    const value = "mx.google.com;\r\n\tdkim=pass header.i=@brand.example;\r\n\tdmarc=pass\r\n (p=NONE) header.from=brand.example";
    assert.equal(check(value).result, "verified");
  });
});

describe("the From address", () => {
  it("must be one field naming one mailbox", () => {
    const two = fields(["authentication-results", passing], ["from", "news@brand.example"], ["from", "news@brand.example"]);
    assert.deepEqual(fromAuthentication(two, GMAIL), { result: "unverified", reason: "from_unusable" });
    assert.deepEqual(check(passing, "news@brand.example, other@brand.example"), { result: "unverified", reason: "from_unusable" });
    assert.deepEqual(check(passing, "Team: news@brand.example;"), { result: "unverified", reason: "from_unusable" });
    assert.deepEqual(fromAuthentication(fields(["authentication-results", passing]), GMAIL), { result: "unverified", reason: "from_unusable" });
    assert.deepEqual(check(passing, "undisclosed"), { result: "unverified", reason: "from_unusable" });
  });

  it("must have a host name for a domain, not an address literal", () => {
    assert.deepEqual(check(passing, "news@[192.0.2.1]"), { result: "unverified", reason: "from_unusable" });
    assert.deepEqual(check(passing, "news@brand..example"), { result: "unverified", reason: "from_unusable" });
    assert.deepEqual(check(passing, "news@brand.example/x"), { result: "unverified", reason: "from_unusable" });
  });

  it("is compared in its ASCII form, so an international domain matches its xn-- spelling", () => {
    const ascii = new URL("http://bränd.example").hostname;
    assert.match(ascii, /^xn--/);
    assert.deepEqual(check(gmail(`dmarc=pass header.from=${ascii}`), "news@bränd.example"), { result: "verified", domain: ascii, by: "dmarc" });
    assert.deepEqual(check(gmail("dmarc=pass header.from=BRAND.example."), "news@Brand.Example"), { result: "verified", domain: "brand.example", by: "dmarc" });
  });
});

describe("the grammar of Authentication-Results (RFC 8601)", () => {
  it("skips comments, nested ones and ones holding semicolons or escaped parentheses (a quote is refused, below)", () => {
    const parsed = parseAuthenticationResults(`mx.google.com (a (nested) comment; with ; in it); dmarc=pass (p=REJECT; sp=REJECT (x) dis=NONE \\) still) header.from=brand.example`);
    assert.deepEqual(parsed, { checker: "mx.google.com", results: [{ method: "dmarc", result: "pass", properties: [["header.from", "brand.example"]] }] });
  });

  it("reads quoted values, a reason, versions, and spaces around = and .", () => {
    const parsed = parseAuthenticationResults(`mx.google.com 1; dkim/1 = fail reason="bad sig, really" header . d = "brand.example"; DMARC=PASS header.FROM=Brand.Example`);
    assert.deepEqual(parsed, {
      checker: "mx.google.com",
      results: [
        { method: "dkim", result: "fail", properties: [["reason", "bad sig, really"], ["header.d", "brand.example"]] },
        { method: "dmarc", result: "pass", properties: [["header.from", "Brand.Example"]] },
      ],
    });
    assert.equal(check(`mx.google.com; dmarc=pass header.from="brand.example"`).result, "verified");
  });

  it("reads 'none' as no results", () => {
    assert.deepEqual(parseAuthenticationResults("mx.google.com; none"), { checker: "mx.google.com", results: [] });
    assert.deepEqual(check("mx.google.com; none"), { result: "unverified", reason: "no_pass" });
  });

  it("reads a local part before the domain, quoted or not", () => {
    const parsed = parseAuthenticationResults(`mx.google.com; dkim=pass header.i="first last"@brand.example; spf=pass smtp.mailfrom=bounce@brand.example`);
    assert.deepEqual(parsed?.results.map((r) => r.properties), [[["header.i", `"first last"@brand.example`]], [["smtp.mailfrom", "bounce@brand.example"]]]);
    assert.equal(check(gmail(`dkim=pass header.i="first last"@brand.example`)).result, "verified");
  });

  it("refuses what it can't read, without throwing, and proves nothing by it", () => {
    const broken = [
      "",
      ";",
      "mx.google.com; dmarc=pass (unterminated comment header.from=brand.example",
      `mx.google.com; dmarc=pass header.from="unterminated`,
      "mx.google.com; dmarc pass header.from=brand.example",
      "mx.google.com; dmarc=pass header.from",
      "mx.google.com; dmarc=pass header.from=brand.example junk",
      "mx.google.com; dmarc=pass header.from=brand.example)",
      "mx.google.com extra words; dmarc=pass header.from=brand.example",
      "mx.google.com; =pass header.from=brand.example",
      "mx.google.com; dmarc=pass ==brand.example",
      "mx.google.com; dmarc=pass header.from==brand.example",
      `mx.google.com; dmarc=pass header.from=brand.example; dmarc=pass ${"(".repeat(64)}`,
    ];
    for (const value of broken) {
      assert.equal(parseAuthenticationResults(value), null, value);
      assert.deepEqual(check(value), { result: "unverified", reason: "malformed" }, value);
    }
  });

  it("refuses deep nesting, huge values and too many results quickly", () => {
    const deep = `mx.google.com; dmarc=pass ${"(".repeat(100_000)}${")".repeat(100_000)} header.from=brand.example`;
    const huge = `mx.google.com; dmarc=pass header.from=brand.example${" ".repeat(70_000)}`;
    const many = `mx.google.com; ${Array.from({ length: 200 }, () => "dkim=pass header.d=a.example").join("; ")}`;
    const props = `mx.google.com; dmarc=pass ${Array.from({ length: 200 }, (_, i) => `header.x${i}=a`).join(" ")}`;
    const started = Date.now();
    for (const value of [deep, huge, many, props]) assert.equal(parseAuthenticationResults(value), null);
    assert.ok(Date.now() - started < 1_000);
    assert.ok(parseAuthenticationResults("mx.google.com; dmarc=pass (" + "(x)".repeat(10) + ") header.from=brand.example"));
    const nested = (depth: number) => `mx.google.com; dmarc=pass ${"(".repeat(depth)}${")".repeat(depth)} header.from=brand.example`;
    assert.ok(parseAuthenticationResults(nested(16)), "16 levels are read");
    assert.equal(parseAuthenticationResults(nested(17)), null, "17 are refused");
  });

  it("isn't misled by a property that only looks like header.from", () => {
    assert.deepEqual(check(gmail("dmarc=pass header.fromx=brand.example policy.from=brand.example")), { result: "unverified", reason: "not_aligned" });
    assert.deepEqual(check(gmail("dmarc=pass header.from=brand.example header.from=evil.example")), { result: "unverified", reason: "not_aligned" });
  });
});

describe("what a sender can write into Gmail's own header (the review of 2026-11-19)", () => {
  // Gmail echoes the envelope sender (MAIL FROM) inside its SPF comment and in smtp.mailfrom. A quoted local part
  // carrying a ")" would close the comment and add results of the sender's choosing.
  const envelope = (local: string, tail = "") =>
    `mx.google.com; dkim=pass header.i=@evil.example header.s=s1 header.b=AbC; spf=pass (google.com: domain of ${local}@evil.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=${local}@evil.example${tail}`;

  it("the reviewer's injection through the envelope sender proves nothing", () => {
    const one = envelope(`"x) ; dkim=pass header.i=@brand.example ("`);
    assert.equal(parseAuthenticationResults(one), null);
    assert.deepEqual(check(one), { result: "unverified", reason: "malformed" });
    const two = envelope(`"x) ; dkim=pass header.i=@brand.example ; dmarc=pass header.from=brand.example x=("`, "; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=brand.example");
    assert.deepEqual(check(two), { result: "unverified", reason: "malformed" });
  });

  it("any quote inside a comment, escaped or not, nested or not, makes the header unreadable", () => {
    for (const comment of [`(a "b" c)`, `(a \\" b)`, `(a (b "c") d)`, `(google.com: domain of "x"@evil.example designates 192.0.2.1)`, `(")`]) {
      const value = `mx.google.com; dmarc=pass ${comment} header.from=brand.example`;
      assert.equal(parseAuthenticationResults(value), null, comment);
      assert.deepEqual(check(value), { result: "unverified", reason: "malformed" }, comment);
    }
  });

  it("the same injection in other comment positions proves nothing", () => {
    const inDmarc = `mx.google.com; dmarc=fail (p="x) ; dmarc=pass header.from=brand.example (") header.from=brand.example`;
    const inDkim = `mx.google.com; dkim=pass ("x) ; dmarc=pass header.from=brand.example (") header.i=@evil.example`;
    const atTop = `mx.google.com ("x) ; dmarc=pass header.from=brand.example ("); spf=pass smtp.mailfrom=a@evil.example`;
    for (const value of [inDmarc, inDkim, atTop]) assert.deepEqual(check(value), { result: "unverified", reason: "malformed" }, value);
  });

  it("a quoted value holding a semicolon or a parenthesis is refused", () => {
    for (const quoted of [`"a;b"`, `"a(b"`, `"a)b"`, `"x) ; dmarc=pass header.from=brand.example ("`]) {
      const value = `mx.google.com; spf=pass smtp.mailfrom=${quoted}@evil.example; dmarc=pass header.from=brand.example`;
      assert.equal(parseAuthenticationResults(value), null, quoted);
    }
    assert.ok(parseAuthenticationResults(`mx.google.com; dkim=pass header.i="first last"@brand.example`), "other quoted values are read");
    assert.equal(check(`"mx.google.com"; dmarc=pass header.from=brand.example`).result, "verified");
  });

  it("a DKIM or DMARC result carrying an envelope (smtp.*) property is refused: only an injection would write one", () => {
    // The structure a HELO name or an unquoted envelope part closing Gmail's comment would leave behind.
    const helo = `mx.google.com; dkim=pass header.i=@evil.example header.s=s1 header.b=AbC; spf=neutral (google.com: x) ; dkim=pass header.i=@brand.example ( is neither permitted nor denied) smtp.helo=x`;
    assert.deepEqual(check(helo), { result: "unverified", reason: "malformed" });
    const dmarc = `mx.google.com; spf=neutral (google.com: x) ; dmarc=pass header.from=brand.example ( is neither permitted nor denied) smtp.helo=x`;
    assert.deepEqual(check(dmarc), { result: "unverified", reason: "malformed" });
    assert.equal(check(gmail("spf=pass smtp.mailfrom=bounce@brand.example smtp.helo=mail.brand.example; dmarc=pass header.from=brand.example")).result, "verified", "SPF's own envelope properties are fine");
  });
});

describe("more than one result from the provider's own checker (forwarded or imported mail)", () => {
  it("proves nothing, wherever the second one is", () => {
    const twice = fields(["authentication-results", passing], ["received", "by mx.google.com"], ["authentication-results", passing], ["from", "news@brand.example"]);
    assert.deepEqual(fromAuthentication(twice, GMAIL), { result: "repeated" });
    const named = fields(["authentication-results", passing], ["authentication-results", "MX.Google.Com.; none"], ["from", "news@brand.example"]);
    assert.deepEqual(fromAuthentication(named, GMAIL), { result: "repeated" }, "in any case, with a trailing dot, even proving nothing");
    const quoted = fields(["authentication-results", passing], ["authentication-results", `(a comment) "mx.google.com" 1; none`], ["from", "news@brand.example"]);
    assert.deepEqual(fromAuthentication(quoted, GMAIL), { result: "repeated" }, "quoted, after a comment, with a version");
    const unreadable = fields(["authentication-results", passing], ["authentication-results", "mx.google.com; dmarc=pass (never closed"], ["from", "news@brand.example"]);
    assert.deepEqual(fromAuthentication(unreadable, GMAIL), { result: "repeated" }, "one that can't be read counts by the name it starts with");
  });

  it("other checkers' results below don't count", () => {
    const relays = fields(["authentication-results", passing], ["authentication-results", "relay.other.example; spf=pass smtp.mailfrom=a@brand.example"], ["from", "news@brand.example"]);
    assert.equal(fromAuthentication(relays, GMAIL).result, "verified");
  });

  it("another checker on top still says so first", () => {
    const top = fields(["authentication-results", "relay.other.example; none"], ["authentication-results", passing], ["authentication-results", passing], ["from", "news@brand.example"]);
    assert.deepEqual(fromAuthentication(top, GMAIL), { result: "other_checker" });
  });
});

describe("the checker's name (the review of 2026-11-19)", () => {
  it("is compared whole, never by prefix or suffix", () => {
    for (const name of ["mx.google.com.evil", "mx.google.com.evil.example", "evil.mx.google.com", "mx.google.co", "mx.google.comx", "mx-google.com", "mx.google.com..", "xmx.google.com"]) {
      assert.deepEqual(check(`${name}; dmarc=pass header.from=brand.example`), { result: "other_checker" }, name);
    }
  });
});

