/**
 * Where a parser's view of the headers could differ from Gmail's (the fifth security review of 2026-11-25), at the byte
 * level: line ends (a lone LF read as a blank line, a stray CR, CRLF and LF mixed) and the header block's length; a
 * header the large-message rebuild can't write back; more DKIM signatures than are read; and Gmail's result with
 * unquoted "/" and "=" in a value, read without letting a value reach another property. Made-up `.example` domains.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GmailClient } from "../../src/gmail/client.ts";
import type { Gate } from "../../src/gmail/limits.ts";
import { fromFullForm } from "../../src/gmail/messages.ts";
import { rebuildMessage, type GmailPart } from "../../src/gmail/payload.ts";
import { fromAuthentication, parseAuthenticationResults, sealedResultAgrees, type AuthenticationOptions, type HeaderField } from "../../src/message/auth-results.ts";
import { parseMessage } from "../../src/message/parse.ts";
import { headerBlockReadable, signedRecipients } from "../../src/message/signed-recipients.ts";

const organisationalDomain = (domain: string): string | null => domain.split(".").slice(-2).join(".") || null;
const GMAIL: AuthenticationOptions = { checker: "mx.google.com", organisationalDomain };
const RESULT = "mx.google.com; dkim=pass header.i=@brand.example header.s=s1 header.b=AbCd1234; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=brand.example";
const REAL = "v=1; a=rsa-sha256; d=brand.example; s=s1; h=from:to:subject:date; bh=abc=; b=AbCd1234wxyz";
const FORGED = "v=1; a=rsa-sha256; d=brand.example; s=s1; h=from:to:cc:subject:date; bh=abc=; b=AbCd1234forged";
const bytes = (text: string) => new TextEncoder().encode(text);

describe("line ends, as bytes", () => {
  /** A forged signature and an added To above `cut`, the real signature and To below it. */
  const attack = (cut: string) => bytes([
    `ARC-Authentication-Results: i=1; ${RESULT}\r\n`,
    `Authentication-Results: ${RESULT}\r\n`,
    "From: Brand <no-reply@brand.example>\r\n",
    `DKIM-Signature: ${FORGED}\r\n`,
    "To: me@inbox.example\r\n",
    cut,
    `DKIM-Signature: ${REAL}\r\n`,
    "To: attacker@elsewhere.example\r\n",
    "Subject: New sign-in\r\n\r\n",
    "Was this you?\r\n",
  ].join(""));

  it("a lone LF that a parser reads as a blank line hides what follows: nothing counts", async () => {
    const raw = attack("X-C: z\n\r\n");
    assert.equal(headerBlockReadable(raw), false);
    const parsed = await parseMessage(raw, { ownAddresses: [], authentication: GMAIL });
    assert.equal(parsed.fromCheck?.result, "verified");
    assert.deepEqual(parsed.signedRecipients, []);
  });

  it("a stray CR, or CRLF and LF mixed, anywhere up to the blank line: unreadable", () => {
    assert.equal(headerBlockReadable(bytes("A: b\r\nC: d\re\r\n\r\nbody")), false, "a CR inside a line");
    assert.equal(headerBlockReadable(bytes("A: b\nC: d\r\n\r\nbody")), false, "LF, then CRLF");
    assert.equal(headerBlockReadable(bytes("A: b\r\nC: d\r\n\nbody")), false, "the blank line ends differently");
    assert.equal(headerBlockReadable(bytes("A: b\r\nC: d\r")), false, "a CR at the very end");
  });

  it("one line end throughout reads: all CRLF, or all LF; and whatever follows the blank line isn't read", () => {
    assert.equal(headerBlockReadable(bytes("A: b\r\n c\r\nD : e\r\n\r\nbody\nwith\rodd ends")), true);
    assert.equal(headerBlockReadable(bytes("A: b\n c\nD: e\n\nbody")), true);
    assert.equal(headerBlockReadable(bytes("A: b\r\nD: e")), true, "a short message with no body");
    assert.equal(headerBlockReadable("A: b\r\nC: d\re\r\n\r\n"), false, "as a string too");
  });

  it("an all-LF message still reads its signed fields", async () => {
    const raw = bytes([`ARC-Authentication-Results: i=1; ${RESULT}`, `Authentication-Results: ${RESULT}`, "From: Brand <no-reply@brand.example>", `DKIM-Signature: ${REAL}`, "To: me@inbox.example", "Subject: Hi", "", "Body"].join("\n"));
    const parsed = await parseMessage(raw, { ownAddresses: [], authentication: GMAIL });
    assert.deepEqual(parsed.signedRecipients, ["to"]);
  });
});

describe("the header block's length", () => {
  it("one that doesn't end within 2 MiB is unreadable, and is read only that far", () => {
    const long = bytes(`A: ${"x".repeat(3 * 1024 * 1024)}`);
    const started = performance.now();
    assert.equal(headerBlockReadable(long), false);
    assert.ok(performance.now() - started < 1_000);
  });

  it("stops at the first line that fails, however long the message", () => {
    const big = bytes(`A: b\r\nNot a field\r\n${"C: d\r\n".repeat(4 * 1024 * 1024)}\r\nbody`);
    const started = performance.now();
    assert.equal(headerBlockReadable(big), false);
    assert.ok(performance.now() - started < 50, `${(performance.now() - started).toFixed(0)} ms`);
  });
});

describe("more signatures than are read", () => {
  const fields = (...pairs: Array<[string, string]>): HeaderField[] => pairs.map(([key, value]) => ({ key, value }));
  it("sixteen are read; a seventeenth leaves nothing", () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => ["DKIM-Signature", `v=1; d=brand.example; s=s${i}; h=from:to; b=${i === 0 ? "AbCd1234real" : `Other${i}x`}`] as [string, string]);
    assert.deepEqual(signedRecipients(fields(["Authentication-Results", RESULT], ...sixteen, ["To", "x@y.example"]), "brand.example", GMAIL), ["to"]);
    const seventeen = [...sixteen, ["DKIM-Signature", "v=1; d=brand.example; s=s16; h=from:to; b=Other16x"] as [string, string]];
    assert.deepEqual(signedRecipients(fields(["Authentication-Results", RESULT], ...seventeen, ["To", "x@y.example"]), "brand.example", GMAIL), []);
  });
});

describe("a header the large-message rebuild can't write back", () => {
  const header = (name: string, value: string) => ({ name, value });
  const data = (text: string) => ({ size: Buffer.byteLength(text), data: Buffer.from(text).toString("base64url") });
  const payload = (headers: Array<{ name: string; value: string }>): GmailPart => ({
    headers: [header("ARC-Authentication-Results", `i=1; ${RESULT}`), header("Authentication-Results", RESULT), header("From", "Brand <no-reply@brand.example>"), header("DKIM-Signature", REAL), ...headers, header("Subject", "New sign-in"), header("Content-Type", "text/plain")],
    body: data("Was this you?"),
  });
  const limits = { largeMessageBytes: 1_000_000, gate: { run: <T>(work: () => Promise<T>) => work() } as unknown as Gate };
  const context = { ownAddresses: [], labelIds: {}, authentication: GMAIL, limits };
  const full = (headers: Array<{ name: string; value: string }>) => fromFullForm({} as GmailClient, { id: "m1", threadId: "t1", payload: payload(headers) }, context);

  it("is reported, at the top only", () => {
    assert.equal(rebuildMessage(payload([header("To ", "attacker@elsewhere.example")])).headersDropped, true, "a name with a space");
    assert.equal(rebuildMessage(payload([header("To", "me@inbox.example")])).headersDropped, false);
    const nested: GmailPart = { headers: [header("From", "a@x.example"), header("Content-Type", 'multipart/mixed; boundary="b"')], parts: [{ headers: [header("Bad Name", "x"), header("Content-Type", "text/plain")], body: data("x") }] };
    assert.equal(rebuildMessage(nested).headersDropped, false, "a part's own header isn't the message's");
  });

  it("then nothing counts: the dropped one could be the real To", async () => {
    const dropped = await full([header("To ", "attacker@elsewhere.example"), header("To", "me@inbox.example")]);
    assert.equal(dropped.fromCheck?.result, "verified");
    assert.deepEqual(dropped.signedRecipients, []);
    const whole = await full([header("To", "me@inbox.example")]);
    assert.deepEqual(whole.signedRecipients, ["to"], "the same message with nothing dropped");
  });
});

describe("Gmail's result with unquoted / and = in a value", () => {
  const real = "mx.google.com;\r\n       dkim=pass header.i=@brand.example header.s=s1 header.b=Kx/9Yb+G;\r\n       spf=pass (google.com: domain of msprvs1=19876abcdef=bounces-12345@bounce.brand.example designates 192.0.2.10 as permitted sender) smtp.mailfrom=msprvs1=19876abcdef=bounces-12345@bounce.brand.example;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=brand.example";

  it("reads base64's / and an SRS address's =, as Gmail writes them", () => {
    const parsed = parseAuthenticationResults(real)!;
    assert.ok(parsed, "readable");
    const dkim = parsed.results.find((entry) => entry.method === "dkim")!;
    assert.deepEqual(dkim.properties.find(([name]) => name === "header.b"), ["header.b", "Kx/9Yb+G"]);
    const spf = parsed.results.find((entry) => entry.method === "spf")!;
    assert.deepEqual(spf.properties, [["smtp.mailfrom", "msprvs1=19876abcdef=bounces-12345@bounce.brand.example"]]);
    assert.deepEqual(fromAuthentication([{ key: "Authentication-Results", value: real }, { key: "From", value: "no-reply@brand.example" }], GMAIL), { result: "verified", domain: "brand.example", by: "dmarc" });
    assert.ok(parseAuthenticationResults("mx.google.com; dkim=pass header.i=@brand.example header.b=/9j+Ab12"), "a value starting with /");
  });

  it("a joined value never reaches another property, and the old guards hold", () => {
    const glued = parseAuthenticationResults("mx.google.com; dkim=pass header.b=abc/header.i=@evil.example")!;
    assert.deepEqual(glued.results[0]!.properties, [["header.b", "abc/header.i=@evil.example"]], "one value: no header.i");
    assert.equal(parseAuthenticationResults("mx.google.com; dkim=pass header.b=abc /def"), null, "not across a space");
    assert.equal(parseAuthenticationResults("mx.google.com; dkim=pass header.b=abc(note)/def"), null, "not across a comment");
    assert.equal(parseAuthenticationResults("mx.google.com; dmarc=pass header.from==brand.example"), null, "never starting with =");
    assert.equal(parseAuthenticationResults("mx.google.com; dmarc=pass header.from=brand.example smtp.mailfrom=a=b@x.example"), null, "an envelope property on DMARC still refused");
    const domain = fromAuthentication([{ key: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=brand.example=evil.example" }, { key: "From", value: "no-reply@brand.example" }], GMAIL);
    assert.deepEqual(domain, { result: "unverified", reason: "not_aligned" }, "a joined domain is no domain");
  });
});

describe("Gmail's sealed copy of its result (the final review of 2026-11-26)", () => {
  const fields = (...pairs: Array<[string, string]>): HeaderField[] => pairs.map(([key, value]) => ({ key, value }));
  // company.example publishes no DMARC; the sender forges a signature Gmail can't check (no key: permerror, no header.b).
  const GMAILS = "mx.google.com; dkim=permerror (no key for signature) header.i=@company.example header.s=s1; spf=pass (google.com: domain of a@company.example designates 192.0.2.10 as permitted sender) smtp.mailfrom=a@company.example";
  const message = (lines: string[]) => [...lines, "From: Pat <pat@company.example>", "DKIM-Signature: v=1; a=rsa-sha256; d=company.example; s=s1; h=from:to:subject; bh=abc=; b=XyZw9876forged", "To: me@inbox.example", "Subject: Lunch?", "", "Shall we?"].join("\r\n");
  const folded = " ; dkim=pass header.i=@company.example header.b=XyZw9876";

  it("a sender's folded first line can't add a result: verified before, no signed recipients now", async () => {
    const raw = message([`ARC-Authentication-Results: i=1; ${GMAILS}`, `Authentication-Results: ${GMAILS}`, folded]);
    const parsed = await parseMessage(raw, { ownAddresses: [], authentication: GMAIL });
    assert.deepEqual(parsed.fromCheck, { result: "verified", domain: "company.example" }, "the folded line joins Gmail's result as read");
    const headers = fields(["ARC-Authentication-Results", `i=1; ${GMAILS}`], ["Authentication-Results", `${GMAILS}\r\n${folded}`], ["DKIM-Signature", "v=1; d=company.example; h=from:to; b=XyZw9876forged"], ["To", "me@inbox.example"]);
    assert.deepEqual(signedRecipients(headers, "company.example", GMAIL), ["to"], "the forged signature counted, before");
    assert.equal(sealedResultAgrees(headers, GMAIL), false, "Gmail's copy has no such result");
    assert.deepEqual(parsed.signedRecipients, []);
  });

  const agreeing = (...pairs: Array<[string, string]>) => sealedResultAgrees(fields(...pairs, ["From", "a@brand.example"]), GMAIL);
  it("agrees only with one copy, above the result, by Gmail, holding every result written the same", () => {
    assert.equal(agreeing(["ARC-Authentication-Results", `i=1; ${RESULT}`], ["Authentication-Results", RESULT]), true);
    assert.equal(agreeing(["Authentication-Results", RESULT]), false, "missing");
    assert.equal(agreeing(["ARC-Authentication-Results", `i=1; ${RESULT.replace("dmarc=pass", "dmarc=fail")}`], ["Authentication-Results", RESULT]), false, "disagreeing");
    assert.equal(agreeing(["ARC-Authentication-Results", "i=1; mx.google.com; dkim=pass header.i=@brand.example header.s=s1 header.b=AbCd1234"], ["Authentication-Results", RESULT]), false, "lacking a result");
    assert.equal(agreeing(["ARC-Authentication-Results", `i=1; ${RESULT}`], ["ARC-Authentication-Results", `i=1; ${RESULT}`], ["Authentication-Results", RESULT]), false, "repeated");
    assert.equal(agreeing(["Authentication-Results", RESULT], ["ARC-Authentication-Results", `i=1; ${RESULT}`]), false, "below the result: a sender's own");
    assert.equal(agreeing(["ARC-Authentication-Results", `i=2; ${RESULT}`], ["Authentication-Results", RESULT]), false, "not Gmail's first");
    assert.equal(agreeing(["ARC-Authentication-Results", `i=1; mx.other.example; ${RESULT.slice("mx.google.com; ".length)}`], ["Authentication-Results", RESULT]), false, "another checker");
    assert.equal(agreeing(["ARC-Authentication-Results", "i=1; mx.google.com; dkim=pass (unclosed"], ["Authentication-Results", RESULT]), false, "unreadable");
  });

  it("and with it missing, a message that would count counts nothing", async () => {
    const raw = [`Authentication-Results: ${RESULT}`, "From: Brand <no-reply@brand.example>", `DKIM-Signature: ${REAL}`, "To: me@inbox.example", "Subject: Hi", "", "Body"].join("\r\n");
    const parsed = await parseMessage(raw, { ownAddresses: [], authentication: GMAIL });
    assert.deepEqual([parsed.fromCheck?.result, parsed.signedRecipients], ["verified", []], "pictures keep the proof; the gate and the let-in rules get nothing");
  });
});
