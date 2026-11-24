/**
 * Large messages and bounded memory against the fake Gmail: a 30 MB message read in the full form without its
 * attachments' bytes and stored as the raw form would be; attachments through messages.attachments.get; a few
 * messages fetched at a time; normal-sized mail as before.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import type { ProviderMessage } from "@usualmail/core";
import { GMAIL_SMALL_MEMORY, type GmailProviderOptions } from "../../src/gmail/index.ts";
import { TEXT_LEFT_OUT } from "../../src/gmail/messages.ts";
import { attachmentContent } from "../../src/message/parse.ts";
import { FakeGmail, plainMessage } from "../../src/testing/index.ts";
import { ADDRESS, base64Lines, gets, largeMessage, provider, synced } from "./large-message.ts";

describe("a 30 MB message", () => {
  const fake = new FakeGmail({ address: ADDRESS });
  let raw: Buffer;
  let footage: Buffer;
  let id: string;
  let viaRaw: ProviderMessage;
  let viaFull: ProviderMessage;
  let mark: number;

  before(async () => {
    ({ raw, footage } = largeMessage());
    id = (await fake.deliver(raw)).id;
    viaRaw = (await synced(provider(fake, { largeMessageBytes: Number.POSITIVE_INFINITY }))).get(id)!;
    mark = fake.requests.length;
    viaFull = (await synced(provider(fake, GMAIL_SMALL_MEMORY))).get(id)!;
  });

  it("is about 30 MB and goes through the full form, never the raw form", () => {
    assert.ok(raw.length > 29 * 1024 * 1024 && raw.length < 32 * 1024 * 1024, `${raw.length} bytes`);
    // The size check, the full form, and the calendar invite (its size depends on its bytes); nothing else.
    assert.deepEqual(gets(fake, mark), ["get minimal", "get full", "attachments.get"]);
    const answered = fake.requests.slice(mark).find((r) => r.query.get("format") === "full")!;
    assert.equal(answered.path, `/messages/${id}`);
  });

  it("is stored exactly as the raw form would be", () => {
    assert.deepEqual(viaFull, viaRaw);
    // What that covers, spelled out for the fields the server keeps.
    assert.deepEqual(viaFull.from, { name: "Müller, Ann", email: "ann@people.example" });
    assert.equal(viaFull.subject, "Pläne – das Video");
    assert.deepEqual(viaFull.references, ["first@people.example", "earlier@people.example"]);
    assert.equal(viaFull.inReplyTo, "earlier@people.example");
    assert.equal(viaFull.listId, "plans.people.example");
    assert.equal(viaFull.fromCheck?.result, "verified", "Gmail's checker read from the full form's headers");
    assert.match(viaFull.text!, /schöne Grüße aus Köln, mit einer langen Zeile, die weich umbrochen wurde\./);
    assert.match(viaFull.text!, /The earlier plan, forwarded\./, "the forwarded message is read inline");
    assert.match(viaFull.html!, /Grüße aus Köln/);
    assert.deepEqual(
      viaFull.attachments.map((a) => [a.id, a.filename, a.mimeType, a.size, a.inline]),
      [
        ["0", "logo.png", "image/png", 70, true],
        ["1", "footage.bin", "application/octet-stream", footage.length, false],
        ["2", "invite.ics", "text/calendar", viaRaw.attachments[2]!.size, false],
        ["3", "€ plan.pdf", "application/pdf", 2048, false],
        ["4", "old.eml", "message/rfc822", viaRaw.attachments[4]!.size, false],
      ],
    );
  });

  it("serves its attachment through messages.attachments.get, not the raw form", async () => {
    const p = provider(fake, GMAIL_SMALL_MEMORY);
    const start = fake.requests.length;
    const bytes = await p.fetchAttachment(id, "1");
    assert.equal(bytes.length, footage.length);
    assert.ok(Buffer.from(bytes).equals(footage), "byte for byte");
    assert.deepEqual(gets(fake, start), ["get minimal", "get full", "attachments.get"]);
  });

  it("serves every attachment as the raw form's parser would", async () => {
    const p = provider(fake, GMAIL_SMALL_MEMORY);
    for (const attachment of viaFull.attachments) {
      if (attachment.id === "1") continue;
      const start = fake.requests.length;
      const bytes = Buffer.from(await p.fetchAttachment(id, attachment.id));
      const expected = Buffer.from((await attachmentContent(raw, attachment.id))!);
      assert.ok(bytes.equals(expected), `${attachment.filename}`);
      assert.ok(!gets(fake, start).includes("get raw"), `${attachment.filename} without the raw form`);
    }
  });
});

describe("the full form against the raw form", () => {
  const fixtures = readdirSync(new URL("../fixtures/", import.meta.url)).filter((name) => name.endsWith(".eml"));

  for (const bodyDataLimit of [Number.POSITIVE_INFINITY, 0]) {
    it(`stores and serves the same for every fixture${bodyDataLimit ? "" : ", with every part left out of the full form"}`, async () => {
      const fake = new FakeGmail({ address: ADDRESS });
      fake.bodyDataLimit = bodyDataLimit;
      const delivered: string[] = [];
      for (const name of fixtures) delivered.push((await fake.deliver(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)))).id);
      // The large message's shape, with a small attachment: every part kind in one message.
      delivered.push((await fake.deliver(largeMessage(4096).raw)).id);
      const viaRaw = await synced(provider(fake, { largeMessageBytes: Number.POSITIVE_INFINITY }));
      // Every message reported as 50 MB, so all of them go through the full form; their parts are small.
      fake.sizeEstimateOf = () => 50 * 1024 * 1024;
      const full = provider(fake, GMAIL_SMALL_MEMORY);
      const mark = fake.requests.length;
      const viaFull = await synced(full);
      assert.ok(!gets(fake, mark).includes("get raw"));
      assert.equal(viaFull.size, delivered.length);
      for (const [ref, message] of viaRaw) {
        assert.deepEqual(viaFull.get(ref), message, ref);
        for (const attachment of message.attachments) {
          const served = Buffer.from(await full.fetchAttachment(ref, attachment.id));
          const fromRaw = Buffer.from((await attachmentContent(fake.mailbox.messages.get(ref)!.raw, attachment.id))!);
          assert.ok(served.equals(fromRaw), `${ref} ${attachment.filename}`);
        }
      }
      assert.ok(!gets(fake, mark).includes("get raw"), "no attachment needed the raw form either");
    });
  }

  it("leaves out a text part over the limit and says so when nothing of the text is left", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    fake.bodyDataLimit = 1024;
    const html = `<p>${"Long newsletter. ".repeat(200_000)}</p>`;
    const lines = [`From: news@brand.example`, `To: ${ADDRESS}`, "Subject: Huge", "Message-ID: <huge@brand.example>", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64Lines(Buffer.from(html)), ""];
    const { id } = await fake.deliver(lines.join("\r\n"));
    const message = (await synced(provider(fake, { largeMessageBytes: 1024 * 1024 }))).get(id)!;
    assert.equal(message.html, undefined);
    assert.equal(message.text, TEXT_LEFT_OUT);
    assert.equal(message.subject, "Huge");
    assert.ok(!fake.requests.some((r) => r.path.includes("/attachments/")), "nothing over the limit was downloaded");
  });
});

describe("bounded memory", () => {
  async function peaks(options: GmailProviderOptions) {
    const fake = new FakeGmail({ address: ADDRESS });
    for (let i = 0; i < 10; i++) await fake.deliver(plainMessage({ from: "cy@people.example", to: ADDRESS, subject: `M${i}` }).raw);
    fake.latencyMs = 5;
    const messages = await synced(provider(fake, { concurrency: 8, ...options }));
    assert.equal(messages.size, 10);
    return fake.peakInFlight;
  }

  it("fetches and converts only `messageConcurrency` messages at once, whatever the requests in flight allow", async () => {
    const two = await peaks({ messageConcurrency: 2 });
    assert.equal(two.get("messages.get:raw"), 2, "two raw messages at most, while eight requests could be in flight");
    const checked = await peaks({ messageConcurrency: 2, largeMessageBytes: 2 * 1024 * 1024 });
    assert.equal(checked.get("messages.get"), 2, "the size check and the download share each message's turn");
    const eight = await peaks({ messageConcurrency: 8 });
    assert.equal(eight.get("messages.get:raw"), 8, "the bound is what held it");
  });

  it("refuses limits that aren't positive", () => {
    const fake = new FakeGmail({ address: ADDRESS });
    assert.throws(() => provider(fake, { messageConcurrency: 0 }), /messageConcurrency/);
    assert.throws(() => provider(fake, { messageConcurrency: 1.5 }), /messageConcurrency/);
    assert.throws(() => provider(fake, { largeMessageBytes: -1 }), /largeMessageBytes/);
  });
});

describe("normal-sized mail", () => {
  async function deliverSome(fake: FakeGmail) {
    for (let i = 0; i < 3; i++) await fake.deliver(plainMessage({ from: "Cy <cy@people.example>", to: ADDRESS, subject: `N${i}`, body: `Hello ${i}.` }).raw);
  }

  it("is read raw with no size check by default, one request a message, as before", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    await deliverSome(fake);
    await synced(provider(fake));
    assert.deepEqual(gets(fake), ["get raw", "get raw", "get raw"]);
  });

  it("is read raw after the size check where a limit is set, and stored the same", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    await deliverSome(fake);
    const before = await synced(provider(fake));
    const mark = fake.requests.length;
    const after = await synced(provider(fake, GMAIL_SMALL_MEMORY));
    assert.deepEqual([...after.entries()], [...before.entries()]);
    assert.deepEqual(gets(fake, mark).sort(), ["get minimal", "get minimal", "get minimal", "get raw", "get raw", "get raw"]);
  });

  it("opening a conversation takes the sizes from the conversation's own minimal form", async () => {
    const fake = new FakeGmail({ address: ADDRESS });
    const { id } = await fake.deliver(plainMessage({ from: "cy@people.example", to: ADDRESS, subject: "Thread" }).raw);
    const p = provider(fake, GMAIL_SMALL_MEMORY);
    const threadId = fake.mailbox.messages.get(id)!.threadId;
    const mark = fake.requests.length;
    const messages = await p.fetchThread!(threadId);
    assert.equal(messages.length, 1);
    const reads = fake.requests.slice(mark).filter((r) => r.path.startsWith("/threads") || r.path.startsWith("/messages"));
    assert.deepEqual(reads.map((r) => `${r.path.split("/")[1]} ${r.query.get("format")}`), ["threads minimal", "messages raw"]);
  });
});
