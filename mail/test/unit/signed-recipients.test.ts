/**
 * Which recipient fields the sender's own DKIM signature vouches for (src/message/signed-recipients.ts; the screening
 * gate's security review of 2026-11-25): a field given once and named in the h= of every aligned signature the checker
 * passed. A real alert to someone else, sent on with a To or Cc naming the victim added on top, has none of its added
 * field; nor does a message giving To or Cc twice. Through the parser too. Made-up `.example` domains only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuthenticationOptions, HeaderField } from "../../src/message/auth-results.ts";
import { parseMessage } from "../../src/message/parse.ts";
import { headerBlockReadable, signedRecipients } from "../../src/message/signed-recipients.ts";

const organisationalDomain = (domain: string): string | null => domain.split(".").slice(-2).join(".") || null;
const GMAIL: AuthenticationOptions = { checker: "mx.google.com", organisationalDomain };

/** Gmail's result for a passing signature whose b= starts AbCd1234, with DMARC for brand.example. */
const RESULT = "mx.google.com; dkim=pass header.i=@brand.example header.s=s1 header.b=AbCd1234; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=brand.example";
const signature = (h: string, b = "AbCd1234wxyz", d = "brand.example") => `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${d}; s=s1;\n h=${h}; bh=abc=; b=${b.slice(0, 6)}\n ${b.slice(6)}`;

const fields = (...pairs: Array<[string, string]>): HeaderField[] => pairs.map(([key, value]) => ({ key, value }));
const signed = (...pairs: Array<[string, string]>) => signedRecipients(fields(["Authentication-Results", RESULT], ...pairs), "brand.example", GMAIL);

describe("recipient fields the sender's signature vouches for", () => {
  it("To and Cc, each given once and signed", () => {
    assert.deepEqual(signed(["DKIM-Signature", signature("from:to:cc:subject:date")], ["To", "me@inbox.example"], ["Cc", "a@b.example"]), ["to", "cc"]);
    assert.deepEqual(signed(["DKIM-Signature", signature("From : To : Subject")], ["To", "me@inbox.example"]), ["to"], "names in any case, spaces between");
  });

  it("a Cc added after signing: its signature didn't name it", () => {
    assert.deepEqual(signed(["Cc", "me@inbox.example"], ["DKIM-Signature", signature("from:to:subject:date")], ["To", "attacker@elsewhere.example"]), ["to"]);
  });

  it("a second To or Cc added on top: nothing, whatever was signed", () => {
    assert.deepEqual(signed(["To", "me@inbox.example"], ["DKIM-Signature", signature("from:to:cc:subject")], ["To", "attacker@elsewhere.example"]), []);
    assert.deepEqual(signed(["Cc", "me@inbox.example"], ["DKIM-Signature", signature("from:to:cc:subject")], ["To", "a@b.example"], ["Cc", "c@d.example"]), []);
  });

  it("a signature added by whoever passed it on can only take a field away", () => {
    const forged = signature("from:to:cc:subject", "AbCd1234forged");
    assert.deepEqual(signed(["DKIM-Signature", forged], ["DKIM-Signature", signature("from:to:subject")], ["To", "x@y.example"], ["Cc", "me@inbox.example"]), ["to"]);
  });

  it("only aligned signatures the checker passed count", () => {
    assert.deepEqual(signed(["DKIM-Signature", signature("from:to:subject", "Zz9xxxxxxxxx")], ["To", "me@inbox.example"]), [], "not the one that passed");
    assert.deepEqual(signed(["DKIM-Signature", signature("from:to:subject", "AbCd1234wxyz", "relay.example")], ["To", "me@inbox.example"]), [], "another organisation's");
    assert.deepEqual(signed(["To", "me@inbox.example"]), [], "no signature at all");
    const failed = signedRecipients(fields(["Authentication-Results", RESULT.replace("dkim=pass", "dkim=fail")], ["DKIM-Signature", signature("from:to")], ["To", "x@y.example"]), "brand.example", GMAIL);
    assert.deepEqual(failed, [], "a failed signature");
  });

  it("without header.b, the passing signer's domain picks the signatures, all of which must sign the field", () => {
    const byDomain = (...pairs: Array<[string, string]>) => signedRecipients(fields(["Authentication-Results", "mx.google.com; dkim=pass header.i=@brand.example"], ...pairs), "brand.example", GMAIL);
    assert.deepEqual(byDomain(["DKIM-Signature", signature("from:to")], ["To", "x@y.example"]), ["to"]);
    assert.deepEqual(byDomain(["DKIM-Signature", signature("from:to:cc")], ["DKIM-Signature", signature("from:to")], ["To", "x@y.example"], ["Cc", "me@inbox.example"]), ["to"]);
  });

  it("a signature that can't be read counts for nothing", () => {
    assert.deepEqual(signed(["DKIM-Signature", "d=brand.example; d=brand.example; h=from:to; b=AbCd1234"], ["To", "x@y.example"]), [], "a tag twice");
    assert.deepEqual(signed(["DKIM-Signature", `d=brand.example; h=to; b=AbCd1234; x=${"a".repeat(20_000)}`], ["To", "x@y.example"]), [], "too long");
  });
});

describe("the final security review's attacks (2026-11-25)", () => {
  const forged = (h: string, b: string) => `v=1; a=rsa-sha256; d=brand.example; s=s1; h=${h}; bh=abc=; b=${b}`;

  it("a real signature padded past the limit isn't skipped, so a forged one copying its first characters can't decide", () => {
    const padded = `v=1; a=rsa-sha256; d=brand.example; s=s1; h=from:to:subject; bh=abc=; b=AbCd1234wxyz${" ".repeat(17_000)}rest`;
    const attack = signed(["Cc", "me@inbox.example"], ["DKIM-Signature", forged("from:to:cc:subject", "AbCd1234forged")], ["DKIM-Signature", padded], ["To", "attacker@elsewhere.example"]);
    assert.deepEqual(attack, []);
    const control = signed(["DKIM-Signature", signature("from:to:subject")], ["To", "me@inbox.example"]);
    assert.deepEqual(control, ["to"], "the same message unpadded and unforged");
  });

  it("DMARC passed by SPF, the only passing DKIM signature another domain's: a forged brand signature copying its b= doesn't fit", () => {
    const spfOnly = "mx.google.com; dkim=pass header.i=@attacker.example header.s=k header.b=ATTK1234; spf=pass smtp.mailfrom=brand.example; dmarc=pass (p=REJECT) header.from=brand.example";
    const result = signedRecipients(fields(
      ["Authentication-Results", spfOnly],
      ["DKIM-Signature", "v=1; a=rsa-sha256; d=attacker.example; s=k; h=from:subject; bh=abc=; b=ATTK1234real"],
      ["DKIM-Signature", forged("from:to:subject", "ATTK1234copy")],
      ["To", "me@inbox.example"],
    ), "brand.example", GMAIL);
    assert.deepEqual(result, []);
  });

  it("any signature without d=, h= or b=, or with a tag name in the wrong case, leaves nothing", () => {
    const control = ["DKIM-Signature", signature("from:to")] as [string, string];
    assert.deepEqual(signed(control, ["DKIM-Signature", "v=1; d=brand.example; h=from:to"], ["To", "x@y.example"]), [], "no b=");
    assert.deepEqual(signed(control, ["DKIM-Signature", "v=1; d=relay.example; b=xyz"], ["To", "x@y.example"]), [], "no h=, even another domain's");
    assert.deepEqual(signed(["DKIM-Signature", "v=1; D=brand.example; h=from:to; b=AbCd1234wxyz"], ["To", "x@y.example"]), [], "D= is no d=");
  });

  it("a field named with spaces before its colon is counted: a signed To plus an added one is To twice", () => {
    assert.deepEqual(signed(["To", "me@inbox.example"], ["DKIM-Signature", signature("from:to:subject")], ["To ", "attacker@elsewhere.example"]), []);
  });
});

describe("through the parser", () => {
  const raw = (extra: string[]) => [
    `ARC-Authentication-Results: i=1; ${RESULT}`,
    `Authentication-Results: ${RESULT}`,
    `DKIM-Signature: v=1; a=rsa-sha256; d=brand.example; s=s1; h=from:to:subject:date; bh=abc=; b=AbCd1234wxyz`,
    "From: Brand <no-reply@brand.example>",
    ...extra,
    "Subject: New sign-in",
    "Date: Wed, 25 Nov 2026 10:00:00 +0000",
    "Message-ID: <a@brand.example>",
    "",
    "Was this you?",
  ].join("\r\n");

  it("reads them when the From domain is proved, and only then", async () => {
    const parsed = await parseMessage(raw(["To: me@inbox.example"]), { ownAddresses: [], authentication: GMAIL });
    assert.deepEqual([parsed.fromCheck, parsed.signedRecipients], [{ result: "verified", domain: "brand.example" }, ["to"]]);
    const added = await parseMessage(raw(["Cc: me@inbox.example", "To: attacker@elsewhere.example"]), { ownAddresses: [], authentication: GMAIL });
    assert.deepEqual(added.signedRecipients, ["to"], "the added Cc isn't signed");
    const doubled = await parseMessage(raw(["To: me@inbox.example", "To: attacker@elsewhere.example"]), { ownAddresses: [], authentication: GMAIL });
    assert.deepEqual(doubled.signedRecipients, [], "To given twice");
    const unasked = await parseMessage(raw(["To: me@inbox.example"]), { ownAddresses: [] });
    assert.equal(unasked.signedRecipients, undefined);
  });

  it("To with a space before its colon, added on top of a signed one, leaves nothing", async () => {
    const spaced = await parseMessage(raw(["To: me@inbox.example", "To : attacker@elsewhere.example"]), { ownAddresses: [], authentication: GMAIL });
    assert.deepEqual(spaced.signedRecipients, []);
  });

  it("a padded real signature and a forged one with a Cc added: nothing", async () => {
    const lines = raw(["Cc: me@inbox.example", "To: attacker@elsewhere.example"]).split("\r\n");
    lines.splice(2, 1, `DKIM-Signature: v=1; a=rsa-sha256; d=brand.example; s=s1; h=from:to:subject:date; bh=abc=; b=AbCd1234wxyz${" ".repeat(17_000)}rest`,
      "DKIM-Signature: v=1; a=rsa-sha256; d=brand.example; s=s1; h=from:to:cc:subject:date; bh=abc=; b=AbCd1234forged");
    const parsed = await parseMessage(lines.join("\r\n"), { ownAddresses: [], authentication: GMAIL });
    assert.equal(parsed.fromCheck?.result, "verified");
    assert.deepEqual(parsed.signedRecipients, []);
  });
});

describe("the fourth review's attacks, and the check being monotone (2026-11-25)", () => {
  /** A signature with the given domain, h= and b=, and optionally i=. */
  const sig = (d: string, h: string, b: string, i?: string) => `v=1; a=rsa-sha256; d=${d};${i ? ` i=${i};` : ""} s=s1; h=${h}; bh=abc=; b=${b}`;
  const result = (entries: string) => `mx.google.com; ${entries}; dmarc=pass (p=REJECT) header.from=brand.example`;
  const check = (from: string, ...pairs: Array<[string, string]>) => signedRecipients(fields(...pairs), from, GMAIL);

  it("a real signature whose i= names a subdomain still bounds what counts, so a forged one for that subdomain can't add Cc", () => {
    const passing = result("dkim=pass header.i=@alerts.brand.example header.b=AbCd1234");
    const real = sig("brand.example", "from:to:subject", "AbCd1234real", "@alerts.brand.example");
    assert.deepEqual(check("brand.example", ["Authentication-Results", passing], ["DKIM-Signature", real], ["To", "me@inbox.example"]), ["to"], "the real one alone");
    const attack = check("brand.example", ["Authentication-Results", passing], ["Cc", "me@inbox.example"],
      ["DKIM-Signature", sig("alerts.brand.example", "from:to:cc:subject", "AbCd1234forged")], ["DKIM-Signature", real], ["To", "attacker@elsewhere.example"]);
    assert.deepEqual(attack, ["to"], "no Cc");
  });

  it("a d= written in Unicode, or with a trailing dot, is the domain the result names", () => {
    const ascii = new URL("http://brånd.example").hostname;
    const unicode = signedRecipients(fields(
      ["Authentication-Results", `mx.google.com; dkim=pass header.i=@${ascii} header.b=AbCd1234; dmarc=pass header.from=${ascii}`],
      ["Cc", "me@inbox.example"], ["DKIM-Signature", sig(ascii, "from:to:cc", "AbCd1234forged")],
      ["DKIM-Signature", sig("brånd.example", "from:to", "AbCd1234real")], ["To", "x@y.example"],
    ), ascii, GMAIL);
    assert.deepEqual(unicode, ["to"], "the Unicode signature bounds it, so the forged ASCII one adds no Cc");
    const dotted = check("brand.example", ["Authentication-Results", result("dkim=pass header.i=@brand.example header.b=AbCd1234")],
      ["Cc", "me@inbox.example"], ["DKIM-Signature", sig("brand.example", "from:to:cc", "AbCd1234forged")], ["DKIM-Signature", sig("brand.example.", "from:to", "AbCd1234real")], ["To", "x@y.example"]);
    assert.deepEqual(dotted, ["to"]);
  });

  it("every signature of the organisation bounds what counts, whether it matches a result or not", () => {
    const passing = result("dkim=pass header.i=@brand.example header.b=AbCd1234");
    const unmatched = check("brand.example", ["Authentication-Results", passing], ["DKIM-Signature", sig("brand.example", "from:to:cc", "AbCd1234one")],
      ["DKIM-Signature", sig("mail.brand.example", "from:to", "Other0000")], ["To", "x@y.example"], ["Cc", "me@inbox.example"]);
    assert.deepEqual(unmatched, ["to"], "the signature no result names still takes Cc away");
  });

  it("a d= that isn't a host name, or has no organisation, leaves nothing", () => {
    const passing = ["Authentication-Results", result("dkim=pass header.i=@brand.example header.b=AbCd1234")] as [string, string];
    const real = ["DKIM-Signature", sig("brand.example", "from:to", "AbCd1234real")] as [string, string];
    assert.deepEqual(check("brand.example", passing, real, ["DKIM-Signature", sig("[192.0.2.1]", "from:to", "x")], ["To", "x@y.example"]), []);
    // As the Public Suffix List does, no organisation for a name of one label.
    const suffixed: AuthenticationOptions = { checker: "mx.google.com", organisationalDomain: (domain) => (domain.includes(".") ? organisationalDomain(domain) : null) };
    assert.deepEqual(signedRecipients(fields(passing, real, ["DKIM-Signature", sig("example", "from:to", "x")], ["To", "x@y.example"]), "brand.example", suffixed), [], "a top-level name alone");
  });

  it("a signature the result says failed leaves nothing, wherever it is", () => {
    const passing = result("dkim=pass header.i=@brand.example header.b=AbCd1234; dkim=fail header.i=@brand.example header.b=XyZw9876");
    assert.deepEqual(check("brand.example", ["Authentication-Results", passing], ["DKIM-Signature", sig("brand.example", "from:to:cc", "XyZw9876x")],
      ["DKIM-Signature", sig("brand.example", "from:to", "AbCd1234real")], ["To", "x@y.example"]), []);
    assert.deepEqual(check("brand.example", ["Authentication-Results", passing], ["DKIM-Signature", sig("other.example", "from:to", "XyZw9876x")],
      ["DKIM-Signature", sig("brand.example", "from:to", "AbCd1234real")], ["To", "x@y.example"]), [], "another domain's too");
  });

  it("monotone: adding any of these fields, alone or two together, anywhere below the checker's result, never adds a field", () => {
    const passing = result("dkim=pass header.i=@brand.example header.b=AbCd1234; dkim=fail header.i=@relay.example header.b=QqQq0000");
    const bases: Array<Array<[string, string]>> = [
      [["Authentication-Results", passing], ["DKIM-Signature", sig("brand.example", "from:to:cc:subject", "AbCd1234real")], ["To", "me@inbox.example"], ["Cc", "a@b.example"]],
      [["Authentication-Results", passing], ["DKIM-Signature", sig("brand.example", "from:subject", "AbCd1234real")], ["To", "me@inbox.example"]],
      [["Authentication-Results", passing], ["DKIM-Signature", sig("brand.example", "from:to:subject", "AbCd1234real", "@alerts.brand.example")], ["To", "me@inbox.example"]],
    ];
    const additions: Array<[string, string]> = [
      ["To", "attacker@elsewhere.example"], ["Cc", "me@inbox.example"], ["To ", "me@inbox.example"], ["cc", "x@y.example"],
      ["DKIM-Signature", sig("brand.example", "from:to:cc:subject:date", "AbCd1234forged")],
      ["DKIM-Signature", sig("alerts.brand.example", "from:to:cc", "AbCd1234forged")],
      ["DKIM-Signature", sig("brand.example", "from", "Zzzz0000")],
      ["DKIM-Signature", sig("relay.example", "from:to:cc", "AbCd1234x")],
      ["DKIM-Signature", sig("brand.example", "from:to:cc", "QqQq0000x")],
      ["DKIM-Signature", "v=1; d=brand.example; d=brand.example; h=to:cc; b=x"],
      ["DKIM-Signature", "v=1; D=brand.example; h=to:cc; b=AbCd1234x"],
      ["DKIM-Signature", "v=1; d=brand.example; h=to:cc"],
      ["DKIM-Signature ", sig("brand.example", "from:to:cc", "AbCd1234y")],
      ["Authentication-Results", "mx.google.com; dkim=pass header.i=@brand.example header.b=Zzzz0000; dmarc=pass header.from=brand.example"],
      ["X-Note", "nothing"], ["From", "Other <x@brand.example>"],
    ];
    const insert = (base: Array<[string, string]>, at: number, added: Array<[string, string]>) => [...base.slice(0, at), ...added, ...base.slice(at)];
    let tried = 0;
    for (const base of bases) {
      const before = new Set(check("brand.example", ...base));
      const lists = [...additions.map((one) => [one]), ...additions.flatMap((one, i) => additions.slice(i + 1).map((two) => [one, two]))];
      for (const added of lists) {
        for (let at = 1; at <= base.length; at++) {
          const after = check("brand.example", ...insert(base, at, added));
          tried++;
          assert.ok(after.every((field) => before.has(field)), `${JSON.stringify(added)} at ${at} added ${JSON.stringify(after)} to ${JSON.stringify([...before])}`);
        }
      }
    }
    assert.ok(tried > 1_000, `${tried} messages tried`);
  });
});

describe("a header line that is neither a field nor a fold (the fourth review's attack)", () => {
  const lines = (malformed: string | null) => [
    `ARC-Authentication-Results: i=1; ${RESULT}`,
    `Authentication-Results: ${RESULT}`,
    "From: Brand <no-reply@brand.example>",
    "Cc: me@inbox.example",
    "DKIM-Signature: v=1; a=rsa-sha256; d=brand.example; s=s1; h=from:to:cc:subject:date; bh=abc=; b=AbCd1234forged",
    ...(malformed === null ? [] : [malformed]),
    "DKIM-Signature: v=1; a=rsa-sha256; d=brand.example; s=s1; h=from:to:subject:date; bh=abc=; b=AbCd1234wxyz",
    "To: attacker@elsewhere.example",
    "Subject: New sign-in",
    "Date: Wed, 25 Nov 2026 10:00:00 +0000",
    "Message-ID: <a@brand.example>",
    "",
    "Was this you?",
  ].join("\r\n");

  it("hides the fields below it from the parser, so nothing counts", async () => {
    for (const [why, line] of [["no colon", "Just some words"], ["a space inside the name", "Bad Name: x"], ["a non-ASCII byte", "Naïve: x"], ["DEL", "Del\u007fName: x"]] as const) {
      const parsed = await parseMessage(lines(line), { ownAddresses: [], authentication: GMAIL });
      assert.equal(parsed.fromCheck?.result, "verified", why);
      assert.deepEqual(parsed.signedRecipients, [], why);
      assert.equal(headerBlockReadable(lines(line)), false, why);
      assert.equal(headerBlockReadable(new TextEncoder().encode(lines(line))), false, `${why}, as bytes`);
    }
  });

  it("without it, the real signature bounds what counts: no Cc", async () => {
    const parsed = await parseMessage(lines(null), { ownAddresses: [], authentication: GMAIL });
    assert.deepEqual(parsed.signedRecipients, ["to"], "only To, which names the attacker; the added Cc doesn't count");
    assert.equal(headerBlockReadable(lines(null)), true);
    assert.equal(headerBlockReadable("To : a@b.example\r\n folded\r\n\r\nBody: not a header"), true, "a space before the colon, a fold, then the body");
  });
});
