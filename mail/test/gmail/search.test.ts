/** Searching Gmail itself (docs/contract-search.md): the query in Gmail's operators, and what is asked of Gmail. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGmailProvider } from "../../src/index.ts";
import { gmailQuery, labelTerm } from "../../src/gmail/search.ts";
import { DEFAULT_NAMES } from "../../src/names.ts";
import { FakeGmail, plainMessage } from "../../src/testing/index.ts";

test("the server's search in Gmail's operators", () => {
  assert.equal(
    gmailQuery({
      words: ["tulips", "c++"], phrases: ["arrive on friday"], exclude: ["spam"], from: "Anna Schmidt", to: "me@acme.example",
      subject: "weekly report", hasAttachment: true, after: "2026-11-01T00:00:00Z", before: "2026-11-02T00:00:00Z", unread: false,
      categories: ["receipt", "invoice"], screened: true, archived: true,
    }, DEFAULT_NAMES),
    'tulips "c++" "arrive on friday" -spam from:"Anna Schmidt" to:me@acme.example subject:(weekly report) has:attachment ' +
      "after:1793491200 before:1793577600 is:read {label:usual-mail-receipts label:usual-mail-invoices} " +
      "label:usual-mail-screening -in:inbox -in:drafts -in:chats",
  );
  assert.equal(gmailQuery({ words: [], phrases: [], exclude: [], hasAttachment: false, unread: true }, DEFAULT_NAMES), "-has:attachment is:unread -in:drafts -in:chats");
  assert.equal(labelTerm("Usual Mail/One-Time Codes"), "label:usual-mail-one-time-codes");
});

test("a page is one threads.list and one threads.get in the metadata form per conversation; opening reads it whole", async () => {
  const fake = new FakeGmail({ address: "me@mail.example" });
  const provider = createGmailProvider(fake.credentials, { fetch: fake.fetch, quotaPerSecond: 1_000_000 });
  for (const subject of ["Tulips one", "Tulips two"]) {
    await fake.deliver(plainMessage({ from: "Ann <ann@people.example>", to: "me@mail.example", subject, body: "It's about tulips." }).raw);
  }
  fake.requests.length = 0;
  const page = await provider.search!({ words: ["tulips"], phrases: [], exclude: [] }, { limit: 10 });
  assert.deepEqual(page.hits.map((hit) => hit.subject), ["Tulips two", "Tulips one"]);
  assert.equal(page.hits[0]!.snippet, "It&#39;s about tulips.", "Gmail's own snippet, as it sends it");
  assert.deepEqual(fake.requests.map((r) => `${r.method} ${r.path.replace(/\/[0-9a-f]{16}$/, "/:id")} ${r.query.get("format") ?? ""}`.trim()), [
    "GET /threads", "GET /threads/:id metadata", "GET /threads/:id metadata",
  ]);
  assert.deepEqual(fake.requests[1]!.query.getAll("metadataHeaders"), ["Subject", "From", "Date"], "nothing of the bodies");
  fake.requests.length = 0;
  const messages = await provider.fetchThread!(page.hits[0]!.threadKey);
  assert.equal(messages.length, 1);
  const reads = fake.requests.filter((r) => r.path.startsWith("/threads") || r.path.startsWith("/messages"));
  assert.deepEqual(reads.map((r) => `${r.method} ${r.query.get("format")}`), ["GET minimal", "GET raw"], "besides the profile and the labels, once");
  assert.ok(fake.requests.every((r) => r.method === "GET"), "read-only");
});

test("a refused sign-in is the provider's GoogleTokenError, which the server turns into 'sign in again'", async () => {
  const fake = new FakeGmail({ address: "me@mail.example" });
  const provider = createGmailProvider(fake.credentials, { fetch: fake.fetch, quotaPerSecond: 1_000_000, maxRetries: 0 });
  fake.revokeGrant();
  await assert.rejects(provider.search!({ words: ["x"], phrases: [], exclude: [] }, { limit: 10 }), { name: "GoogleTokenError" });
});
