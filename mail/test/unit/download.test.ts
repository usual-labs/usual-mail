/**
 * Reading one base64url field out of a JSON answer as it streams (gmail/download.ts), as messages.attachments.get
 * answers: in any chunking, past other fields, nested values and strings that mention the field's name.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { base64Field } from "../../src/gmail/download.ts";

function streamOf(text: string, chunk: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

describe("base64Field", () => {
  it("decodes the field in any chunking", async () => {
    for (const chunk of [1, 2, 3, 5, 64]) {
      const bytes = await base64Field(streamOf('{\n  "size": 11,\n  "data": "aGVsbG8gd29ybGQ"\n}\n', chunk), "data", 11);
      assert.equal(Buffer.from(bytes!).toString(), "hello world", `chunks of ${chunk}`);
    }
  });

  it("skips other fields, nested values and strings that name the field", async () => {
    const json = JSON.stringify({ note: '"data": "Zm9v"', meta: { data: "YmFy", list: ["data", { x: "}" }] }, attachmentId: "ANGjdJ-x", data: "aGVsbG8gd29ybGQ", size: 11 });
    assert.equal(Buffer.from((await base64Field(streamOf(json, 4), "data"))!).toString(), "hello world");
  });

  it("reads JSON escapes in the field, as some encoders write them (the review's probe 1, T1)", async () => {
    assert.equal(Buffer.from((await base64Field(streamOf('{"size":4,"data":"QUJDRA\\u003d\\u003d"}', 3), "data", 4))!).toString(), "ABCD");
    assert.equal(Buffer.from((await base64Field(streamOf('{"data":"P\\/8\\u002b"}', 1), "data"))!).toString("hex"), Buffer.from("P/8+", "base64").toString("hex"));
    await assert.rejects(base64Field(streamOf('{"data":"QU\\x"}', 2), "data"), { name: "GmailDataError" });
  });

  it("finds the field in any random chunking past decoys with escapes (the review's probe 1, T2)", async () => {
    const payload = Buffer.from(Array.from({ length: 3001 }, (_, i) => i % 251));
    const json = `{"meta":{"data":"ZGVjb3k","x":"a\\"b}\\\\"},"arr":[{"data":"bm8"},"]}"],"note":"q\\"data\\":\\"x","size":${payload.length},"data":"${payload.toString("base64url")}","data":"c2Vjb25k"}`;
    for (let trial = 0; trial < 200; trial++) {
      const parts: string[] = [];
      for (let i = 0; i < json.length; ) {
        const n = 1 + Math.floor(Math.random() * (trial < 100 ? 3 : 300));
        parts.push(json.slice(i, i + n));
        i += n;
      }
      const stream = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } });
      assert.ok(Buffer.from((await base64Field(stream, "data", payload.length))!).equals(payload), `trial ${trial}`);
    }
  });

  it("answers undefined without the field and refuses an answer cut short", async () => {
    assert.equal(await base64Field(streamOf('{"size": 0}', 3), "data"), undefined);
    await assert.rejects(base64Field(streamOf('{"size": 3, "data": "aGVs', 3), "data"), { name: "GmailDataError", message: /ended early/ });
    await assert.rejects(base64Field(streamOf("[1, 2]", 3), "data"), { name: "GmailDataError", message: /JSON object/ });
    const broken = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("socket hang up")); } });
    await assert.rejects(base64Field(broken, "data"), { name: "GmailUnreachable", message: /broke off/ });
  });

  it("reads megabytes whether the size given is right, short or long", async () => {
    const original = randomBytes(3 * 1024 * 1024 + 7);
    const json = `{"attachmentId": "x", "size": ${original.length}, "data": "${original.toString("base64url")}"}`;
    for (const expected of [original.length, 1000, original.length * 2, 0]) {
      const bytes = await base64Field(streamOf(json, 7 * 1024 + 3), "data", expected);
      assert.equal(bytes!.byteLength, original.length);
      assert.ok(Buffer.from(bytes!).equals(original), `expected ${expected}`);
    }
  });
});
