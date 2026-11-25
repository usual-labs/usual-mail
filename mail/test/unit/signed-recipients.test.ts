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
import { signedRecipients } from "../../src/message/signed-recipients.ts";

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
    lines.splice(1, 1, `DKIM-Signature: v=1; a=rsa-sha256; d=brand.example; s=s1; h=from:to:subject:date; bh=abc=; b=AbCd1234wxyz${" ".repeat(17_000)}rest`,
      "DKIM-Signature: v=1; a=rsa-sha256; d=brand.example; s=s1; h=from:to:cc:subject:date; bh=abc=; b=AbCd1234forged");
    const parsed = await parseMessage(lines.join("\r\n"), { ownAddresses: [], authentication: GMAIL });
    assert.equal(parsed.fromCheck?.result, "verified");
    assert.deepEqual(parsed.signedRecipients, []);
  });
});
