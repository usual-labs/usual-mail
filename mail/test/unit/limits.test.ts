/** Gmail's quota bucket, concurrency gate and backoff; the outgoing message composer. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import PostalMime from "postal-mime";
import { backoffMs, Gate, QuotaBucket } from "../../src/gmail/limits.ts";
import { composeMessage } from "../../src/message/compose.ts";
import { keywordFor, resolveNames } from "../../src/names.ts";

function fakeClock(start = 0) {
  let now = start;
  const sleeps: number[] = [];
  return { now: () => now, sleep: async (ms: number) => void (sleeps.push(ms), (now += ms)), sleeps };
}

describe("QuotaBucket", () => {
  it("lets a burst through, then paces to the rate", async () => {
    const clock = fakeClock();
    const bucket = new QuotaBucket(100, 300, clock);
    for (let i = 0; i < 5; i++) await bucket.take(60);
    assert.deepEqual(clock.sleeps, [], "300 units of burst cover five 60-unit calls");
    await bucket.take(60);
    assert.deepEqual(clock.sleeps, [600], "the sixth waits 0.6 s at 100 units a second");
  });

  it("serves callers in order", async () => {
    const clock = fakeClock();
    const bucket = new QuotaBucket(10, 10, clock);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => bucket.take(10).then(() => order.push(n))));
    assert.deepEqual(order, [1, 2, 3]);
  });
});

describe("Gate", () => {
  it("never runs more than its size at once", async () => {
    const gate = new Gate(2);
    let running = 0;
    let peak = 0;
    const task = () => gate.run(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
    });
    await Promise.all(Array.from({ length: 10 }, task));
    assert.equal(peak, 2);
  });
});

describe("backoff", () => {
  it("doubles from a second, adds jitter, caps, and honours Retry-After", () => {
    const none = () => 0;
    assert.equal(backoffMs(0, null, 0, none), 1000);
    assert.equal(backoffMs(3, null, 0, none), 8000);
    assert.equal(backoffMs(10, null, 0, none), 32_000);
    assert.equal(backoffMs(0, null, 0, () => 0.999), 1999);
    assert.equal(backoffMs(0, "12", 0, none), 12_000);
    assert.equal(backoffMs(0, new Date(60_000).toUTCString(), 0, none), 60_000);
    assert.equal(backoffMs(0, "86400", 0, none), 300_000, "a day-long Retry-After is capped at five minutes");
    assert.equal(backoffMs(2, "soon", 0, none), 4000, "an unreadable Retry-After is ignored");
  });
});

describe("composeMessage", () => {
  it("builds a reply with threading headers, keeps Bcc only in the sender's copy, and lists every recipient", async () => {
    const composed = await composeMessage({
      from: { name: "Me", email: "me@mail.example" },
      to: [{ name: "Ann", email: "ann@people.example" }],
      cc: [{ email: "bo@people.example" }],
      bcc: [{ email: "secret@people.example" }],
      subject: "Re: Grüße",
      text: "Hallo zurück.",
      inReplyTo: "b@people.example",
      references: ["a@people.example"],
    });
    assert.match(composed.messageId, /^[0-9a-f-]{36}@mail\.example$/);
    assert.deepEqual(composed.recipients, ["ann@people.example", "bo@people.example", "secret@people.example"]);
    const sent = await PostalMime.parse(composed.raw);
    const kept = await PostalMime.parse(composed.rawWithBcc);
    assert.equal(sent.bcc, undefined, "recipients never see Bcc");
    assert.deepEqual(kept.bcc, [{ name: "", address: "secret@people.example" }]);
    assert.equal(sent.messageId, `<${composed.messageId}>`);
    assert.equal(kept.messageId, `<${composed.messageId}>`);
    assert.equal(sent.inReplyTo, "<b@people.example>");
    assert.equal(sent.references, "<a@people.example> <b@people.example>");
    assert.equal(sent.subject, "Re: Grüße");
    assert.equal(sent.text?.trim(), "Hallo zurück.");
  });

  it("refuses a message without recipients", async () => {
    await assert.rejects(composeMessage({ from: { email: "me@mail.example" }, to: [], cc: [], bcc: [], subject: "x", text: "x" }), /no recipients/);
  });
});

describe("names", () => {
  it("default under Usual Mail/, take custom names, and make keyword atoms", () => {
    const names = resolveNames({ names: { newsletter: "/Feeds//News/" } });
    assert.equal(names.newsletter, "Feeds/News");
    assert.equal(names.receipt, "Usual Mail/Receipts");
    assert.equal(names.otp, "Usual Mail/One-Time Codes");
    assert.equal(names.screening, "Usual Mail/Screening");
    assert.equal(keywordFor("Usual Mail/Reply Later"), "$UsualMail_ReplyLater");
    assert.equal(keywordFor("Usual Mail/Set Aside"), "$UsualMail_SetAside");
    assert.equal(keywordFor("(*)"), "$Usual");
  });
});
