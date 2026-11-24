/**
 * The large-message path's edges, from the review of 2026-11-21 (its probes kept as regression tests): attachments
 * served the way the message was stored, a UTF-16 calendar invite, one download budget per message, failures that
 * would repeat never stopping an inbox, a gate shared by several providers, and a minimal form without `sizeEstimate`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGate, GMAIL_SMALL_MEMORY } from "../../src/gmail/index.ts";
import { TEXT_NOT_GIVEN } from "../../src/gmail/messages.ts";
import { attachmentContent } from "../../src/message/parse.ts";
import { FakeGmail, plainMessage, syncAll } from "../../src/testing/index.ts";
import { ADDRESS, base64Lines, gets, largeMessage, provider, synced } from "./large-message.ts";

const MB50 = 50 * 1024 * 1024;

/** The review's probe 2: a UTF-16 calendar invite and a PDF. */
function calendarMessage(): Buffer {
  const invite = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
  return Buffer.from([
    "From: cy@people.example", `To: ${ADDRESS}`, "Subject: cal16", "Message-ID: <c16@people.example>",
    'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain; charset=utf-8", "", "Hello.", "--b",
    "Content-Type: text/calendar; charset=utf-16; method=REQUEST", 'Content-Disposition: attachment; filename="invite.ics"', "Content-Transfer-Encoding: base64", "",
    base64Lines(Buffer.from(`﻿${invite}`, "utf16le")), "--b",
    "Content-Type: application/pdf", 'Content-Disposition: attachment; filename="doc.pdf"', "Content-Transfer-Encoding: base64", "", base64Lines(Buffer.from("%PDF-1.4 tiny")), "--b--", "",
  ].join("\r\n"));
}

/** A fake whose answers a test rewrites on the way out. */
function rewriting(fake: FakeGmail, rewrite: (path: string, query: URLSearchParams, body: Record<string, unknown>) => unknown) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fake.fetch(input, init);
    const url = new URL(String(input));
    if (!response.ok) return response;
    const body = rewrite(url.pathname, url.searchParams, (await response.json()) as Record<string, unknown>);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("attachments are served the way the message was stored", () => {
  it("from the raw form on Node's default, with no other request (the review's probe 2)", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    const raw = calendarMessage();
    const { id } = await fake.deliver(raw);
    const p = provider(fake);
    for (const attachment of ["0", "1"]) {
      const mark = fake.requests.length;
      const served = Buffer.from(await p.fetchAttachment(id, attachment));
      assert.ok(served.equals(Buffer.from((await attachmentContent(raw, attachment))!)), attachment);
      assert.deepEqual(gets(fake, mark), ["get raw"]);
    }
  });

  it("from the raw form under a limit, after the size check", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    const raw = calendarMessage();
    const { id } = await fake.deliver(raw);
    const mark = fake.requests.length;
    const served = Buffer.from(await provider(fake, GMAIL_SMALL_MEMORY).fetchAttachment(id, "0"));
    assert.equal(served.length, 42);
    assert.ok(served.equals(Buffer.from((await attachmentContent(raw, "0"))!)));
    assert.deepEqual(gets(fake, mark), ["get minimal", "get raw"]);
  });

  it("from the full form over it: a UTF-16 calendar invite is stored and served as the raw form gives it", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    const raw = calendarMessage();
    const { id } = await fake.deliver(raw);
    const viaRaw = (await synced(provider(fake))).get(id)!;
    fake.sizeEstimateOf = () => MB50;
    const p = provider(fake, GMAIL_SMALL_MEMORY);
    assert.deepEqual((await synced(p)).get(id), viaRaw);
    for (const attachment of ["0", "1"]) {
      const mark = fake.requests.length;
      const served = Buffer.from(await p.fetchAttachment(id, attachment));
      assert.ok(served.equals(Buffer.from((await attachmentContent(raw, attachment))!)), attachment);
      assert.deepEqual(gets(fake, mark), ["get minimal", "get full", "attachments.get"]);
    }
  });

  it("never serves a forwarded message Gmail only expanded, without its bytes or an id for them", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    const raw = largeMessage(4096).raw;
    const { id } = await fake.deliver(raw);
    const viaRaw = (await synced(provider(fake))).get(id)!;
    fake.sizeEstimateOf = () => MB50;
    const strip = (part: Record<string, unknown>): void => {
      if (part.mimeType === "message/rfc822") part.body = { size: (part.body as { size: number }).size };
      for (const child of (part.parts as Record<string, unknown>[] | undefined) ?? []) strip(child);
    };
    const fetch = rewriting(fake, (path, query, body) => {
      if (query.get("format") === "full") strip(body.payload as Record<string, unknown>);
      return body;
    });
    const p = provider(fake, { ...GMAIL_SMALL_MEMORY, fetch });
    const stored = (await synced(p)).get(id)!;
    assert.deepEqual(stored, viaRaw, "stored with Gmail's size all the same");
    const old = stored.attachments.find((a) => a.filename === "old.eml")!;
    await assert.rejects(p.fetchAttachment(id, old.id), /no such attachment/);
    await assert.rejects(p.fetchAttachment(id, "99"), /no such attachment/);
  });
});

it("one message downloads at most `largeMessageBytes` of the parts Gmail left out (the review's probe 3)", async () => {
  const part = (i: number) => ["--b", "Content-Type: text/plain; charset=utf-8", `Content-Disposition: inline; filename="log${i}.txt"`, "Content-Transfer-Encoding: base64", "", base64Lines(Buffer.from(`log line ${i} `.repeat(150_000)))].join("\r\n");
  const raw = ["From: ci@build.example", `To: ${ADDRESS}`, "Subject: CI logs", "Message-ID: <ci@build.example>", 'Content-Type: multipart/mixed; boundary="b"', "", ...Array.from({ length: 8 }, (_, i) => part(i)), "--b--", ""].join("\r\n");
  const fake = new FakeGmail({ address: ADDRESS });
  fake.bodyDataLimit = 64 * 1024;
  const { id } = await fake.deliver(raw);
  const message = (await synced(provider(fake, GMAIL_SMALL_MEMORY))).get(id)!;
  assert.deepEqual(gets(fake), ["get minimal", "get full", "attachments.get"], "the first log fits the 2 MiB, the second doesn't");
  assert.match(message.text!, /^log line 0 /);
  assert.doesNotMatch(message.text!, /log line 1 /);
  assert.ok(message.text!.length < 2 * 1024 * 1024);
});

describe("a failure that would repeat never stops an inbox", () => {
  async function leftOutBodies(answer: (body: Record<string, unknown>) => unknown) {
    const fake = new FakeGmail({ address: ADDRESS });
    fake.bodyDataLimit = 0;
    fake.sizeEstimateOf = () => MB50;
    const { id } = await fake.deliver(plainMessage({ from: "cy@people.example", to: ADDRESS, subject: "Broken part", body: "The text." }).raw);
    const fetch = rewriting(fake, (path, _query, body) => (path.includes("/attachments/") ? answer(body) : body));
    const p = provider(fake, { ...GMAIL_SMALL_MEMORY, fetch, maxRetries: 0 });
    const first = await syncAll(p, null);
    const mark = fake.requests.length;
    const again = await syncAll(p, first.cursor);
    assert.deepEqual(gets(fake, mark), [], "the next sync goes on from the cursor, nothing fetched again");
    assert.equal(again.messages.size, 0);
    return first.messages.get(id)!;
  }

  it("an attachments.get answer without readable data leaves the part out, not in the words for a size", async () => {
    const message = await leftOutBodies((body) => ({ ...body, data: 12 }));
    assert.equal(message.subject, "Broken part");
    assert.equal(message.text, TEXT_NOT_GIVEN);
  });

  it("so do empty data for a part with a size, and an answer that isn't JSON", async () => {
    assert.equal((await leftOutBodies((body) => ({ ...body, data: "" }))).text, TEXT_NOT_GIVEN);
    assert.equal((await leftOutBodies(() => "<html>Bad gateway</html>")).text, TEXT_NOT_GIVEN);
  });

  it("keeps bytes that decoded cleanly whatever size the full form gave (the review's probe 4)", async () => {
    const raw = ["From: cy@people.example", `To: ${ADDRESS}`, "Subject: sizes", "Message-ID: <sz@people.example>", 'Content-Type: multipart/mixed; boundary="b"', "",
      "--b", "Content-Type: text/plain; charset=utf-8", "", "Hello, the report is attached.", "--b",
      "Content-Type: application/pdf", 'Content-Disposition: attachment; filename="r.pdf"', "Content-Transfer-Encoding: base64", "", Buffer.from("%PDF-1.4 report").toString("base64"), "--b--", ""].join("\r\n");
    for (const skew of [1, -1]) {
      const fake = new FakeGmail({ address: ADDRESS });
      fake.bodyDataLimit = 0;
      fake.sizeEstimateOf = () => MB50;
      const { id } = await fake.deliver(raw);
      const skewed = (part: Record<string, unknown>): void => {
        const body = part.body as { attachmentId?: string; size: number };
        if (body.attachmentId) body.size += skew;
        for (const child of (part.parts as Record<string, unknown>[] | undefined) ?? []) skewed(child);
      };
      const fetch = rewriting(fake, (_path, query, body) => {
        if (query.get("format") === "full") skewed(body.payload as Record<string, unknown>);
        return body;
      });
      const p = provider(fake, { ...GMAIL_SMALL_MEMORY, fetch });
      const message = (await synced(p)).get(id)!;
      assert.equal(message.text, "Hello, the report is attached.", `skew ${skew}`);
      assert.equal(Buffer.from(await p.fetchAttachment(id, "0")).toString(), "%PDF-1.4 report", `skew ${skew}`);
    }
  });

  it("a full form the rebuild can't read becomes the usual note", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    fake.sizeEstimateOf = () => MB50;
    const { id } = await fake.deliver(plainMessage({ from: "cy@people.example", to: ADDRESS, subject: "Odd" }).raw);
    const fetch = rewriting(fake, (_path, query, body) => (query.get("format") === "full" ? { ...body, payload: { headers: "not a list" } } : body));
    const message = (await synced(provider(fake, { ...GMAIL_SMALL_MEMORY, fetch }))).get(id)!;
    assert.equal(message.subject, "(This message couldn't be read)");
    assert.match(message.text!, /couldn't read this message/);
  });

  it("a failure that may pass fails the batch, and the next try takes the message whole", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    fake.bodyDataLimit = 0;
    fake.sizeEstimateOf = () => MB50;
    const { id } = await fake.deliver(plainMessage({ from: "cy@people.example", to: ADDRESS, subject: "Later", body: "Worth the wait." }).raw);
    const p = provider(fake, { ...GMAIL_SMALL_MEMORY, maxRetries: 0 });
    fake.failNext(1, { status: 503, reason: "backendError", message: "Backend Error", match: (_method, path) => path.includes("/attachments/") });
    await assert.rejects(p.sync(null), /Backend Error/);
    assert.equal((await synced(p)).get(id)!.text, "Worth the wait.");
  });
});

it("a token refresh Google refuses for an unnamed reason during a download fails the batch, never leaving the part out", async () => {
  const fake = new FakeGmail({ address: ADDRESS });
  fake.bodyDataLimit = 0;
  fake.sizeEstimateOf = () => MB50;
  const { id } = await fake.deliver(plainMessage({ from: "cy@people.example", to: ADDRESS, subject: "Refresh", body: "Still here." }).raw);
  let refuse = false;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (refuse && url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/attachments/") && !refuse) {
      refuse = true;
      fake.expireAccessTokens();
    }
    return fake.fetch(input, init);
  };
  const p = provider(fake, { ...GMAIL_SMALL_MEMORY, fetch, maxRetries: 0 });
  await assert.rejects(p.sync(null), { name: "GoogleRefreshError" });
  refuse = false;
  const again = provider(fake, { ...GMAIL_SMALL_MEMORY, fetch: fake.fetch, maxRetries: 0 });
  assert.equal((await synced(again)).get(id)!.text, "Still here.");
});

describe("a gate shared by several providers", () => {
  async function peak(shared: boolean) {
    const fake = new FakeGmail({ address: ADDRESS });
    for (let i = 0; i < 6; i++) await fake.deliver(plainMessage({ from: "cy@people.example", to: ADDRESS, subject: `S${i}` }).raw);
    fake.latencyMs = 5;
    const gate = createGate(2);
    const options = shared ? { gate, concurrency: 8 } : { messageConcurrency: 2, concurrency: 8 };
    await Promise.all([synced(provider(fake, options)), synced(provider(fake, options))]);
    return fake.peakInFlight.get("messages.get:raw");
  }

  it("bounds the messages held by all of them together", async () => {
    assert.equal(await peak(true), 2, "two at once across both inboxes");
    assert.equal(await peak(false), 4, "two each without it");
  });

  it("is made by createGate only", () => {
    assert.throws(() => createGate(0), /slots/);
    assert.throws(() => provider(new FakeGmail({ address: ADDRESS }), { gate: { slots: 2 } }), /createGate/);
  });
});

describe("a minimal form without sizeEstimate", () => {
  it("takes the full form on a host with a limit, stored and served as the raw form", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    const raw = calendarMessage();
    const { id } = await fake.deliver(raw);
    const viaRaw = (await synced(provider(fake))).get(id)!;
    fake.sizeEstimateOf = (message, format) => (format === "minimal" ? undefined : message.raw.length);
    const p = provider(fake, GMAIL_SMALL_MEMORY);
    const mark = fake.requests.length;
    assert.deepEqual((await synced(p)).get(id), viaRaw);
    assert.deepEqual(gets(fake, mark), ["get minimal", "get full", "attachments.get"], "the invite's bytes, for its size");
    const served = Buffer.from(await p.fetchAttachment(id, "1"));
    assert.ok(served.equals(Buffer.from((await attachmentContent(raw, "1"))!)));
  });

  it("changes nothing on Node's default, which never asks", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    fake.sizeEstimateOf = () => undefined;
    const { id } = await fake.deliver(calendarMessage());
    assert.ok((await synced(provider(fake))).get(id));
    assert.deepEqual(gets(fake), ["get raw"]);
  });
});
