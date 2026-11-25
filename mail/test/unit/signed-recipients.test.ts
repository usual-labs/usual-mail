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
});
