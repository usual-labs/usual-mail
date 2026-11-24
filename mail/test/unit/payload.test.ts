/**
 * The full form written back as MIME (gmail/payload.ts), against shapes the review of 2026-11-21 probed: a boundary the
 * parser reads with an escaped quote, header values with line breaks, and a From that Gmail might hand back decoded.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rebuildMessage, type GmailPart } from "../../src/gmail/payload.ts";
import { attachmentBytes, parseMessage } from "../../src/message/parse.ts";

const header = (name: string, value: string) => ({ name, value });
const data = (text: string) => ({ size: Buffer.byteLength(text), data: Buffer.from(text).toString("base64url") });
const texts = async (bytes: Uint8Array) => (await attachmentBytes(bytes)).map((content) => Buffer.from(content).toString());

describe("rebuildMessage", () => {
  it("writes its own boundaries, so a boundary with an escaped quote loses no part (the review's probe 1, T3)", async () => {
    const payload: GmailPart = {
      headers: [header("From", "a@x.example"), header("Subject", "t3"), header("Content-Type", 'multipart/mixed; boundary="outer"')],
      parts: [
        {
          headers: [header("Content-Type", 'multipart/related; boundary="in\\"ner"')],
          parts: [
            { headers: [header("Content-Type", "text/html; charset=utf-8")], body: data("<p>hi</p>") },
            { headers: [header("Content-Type", "image/png"), header("Content-ID", "<img1>"), header("Content-Disposition", "inline; filename=a.png")], body: data("PNG") },
          ],
        },
        { headers: [header("Content-Type", "application/pdf"), header("Content-Disposition", "attachment; filename=b.pdf")], body: data("PDF") },
      ],
    };
    const raw = ["From: a@x.example", "Subject: t3", 'Content-Type: multipart/mixed; boundary="outer"', "", "--outer", 'Content-Type: multipart/related; boundary="in\\"ner"', "", '--in"ner', "Content-Type: text/html; charset=utf-8", "", "<p>hi</p>", '--in"ner', "Content-Type: image/png", "Content-ID: <img1>", "Content-Disposition: inline; filename=a.png", "", "PNG", '--in"ner--', "--outer", "Content-Type: application/pdf", "Content-Disposition: attachment; filename=b.pdf", "", "PDF", "--outer--", ""].join("\r\n");
    const rebuilt = rebuildMessage(payload);
    assert.deepEqual(await texts(rebuilt.bytes), ["PNG", "PDF"]);
    assert.deepEqual(await texts(rebuilt.bytes), await texts(Buffer.from(raw)));
    const fromRebuilt = await parseMessage(rebuilt.bytes, { ownAddresses: [] });
    const fromRaw = await parseMessage(raw, { ownAddresses: [] });
    assert.deepEqual(fromRebuilt, fromRaw);
    assert.doesNotMatch(Buffer.from(rebuilt.bytes).toString("latin1"), /boundary="(outer|in)/, "the header's boundaries aren't written");
  });

  it("keeps a header value's line breaks as folding, so they can't start a header", async () => {
    const payload: GmailPart = { headers: [header("From", "a@x.example"), header("Subject", "One\r\nX-Injected: yes\nTwo")], body: data("Body.") };
    const parsed = await parseMessage(rebuildMessage(payload).bytes, { ownAddresses: [] });
    assert.equal(parsed.subject, "One X-Injected: yes Two");
    assert.equal(parsed.text, "Body.");
  });

  it("reads a From that Gmail might hand back decoded as the encoded one (the review's probe 1, T4)", async () => {
    for (const from of ["=?utf-8?Q?M=C3=BCller=2C_Ann?= <ann@people.example>", "Müller, Ann <ann@people.example>"]) {
      const parsed = await parseMessage(rebuildMessage({ headers: [header("From", from)], body: data("Hi.") }).bytes, { ownAddresses: [] });
      assert.deepEqual(parsed.from, { name: "Müller, Ann", email: "ann@people.example" }, from);
    }
  });

  it("marks a left-out calendar invite as UTF-8, so a UTF-16 one keeps its marker", async () => {
    const part: GmailPart = { headers: [header("Content-Type", 'text/calendar; charset="utf-16"; method=REQUEST; name="a;b.ics"'), header("Content-Disposition", "attachment")], body: { size: 42, attachmentId: "x" } };
    const rebuilt = rebuildMessage({ headers: [header("Content-Type", 'multipart/mixed; boundary="b"')], parts: [{ headers: [], body: data("Hi.") }, part] });
    const [content] = await attachmentBytes(rebuilt.bytes);
    assert.equal(rebuilt.partOf(content!), part);
    assert.equal(rebuilt.leftOut(content!), 42);
    assert.match(Buffer.from(rebuilt.bytes).toString("latin1"), /Content-Type: text\/calendar; method=REQUEST; name="a;b\.ics"; charset=utf-8/);
  });
});
