// Gmail in workerd, from the fake outside the isolate: a message of about 30 MB synced within GMAIL_SMALL_MEMORY (its
// size read first, then the full form without the attachment's bytes, never the raw form; workerd's memory measured
// meanwhile); 150 threads, so a search page and an action each bind more than 100 thread ids in one statement (as
// one JSON parameter: a Durable Object takes at most 100), the action's write-back included; and two inboxes syncing at
// once within the one gate of two messages every Gmail provider in the object shares.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { plainMessage } from "../../../mail/src/testing/index.ts";
import { ADDRESS, connectGmail, residentBytes, SECOND_ADDRESS, startServer, until, workerdPid, type TestServer } from "./harness.ts";

const MB = 1024 * 1024;

/** A message with a text part and one attachment, its bytes in base64 lines (mail's builder spreads lines, too many here). */
function withAttachment(subject: string, filename: string, bytes: Buffer): string {
  const lines = [
    "From: Ann <ann@people.example>",
    `To: ${ADDRESS}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    "Message-ID: <footage@people.example>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="parts"',
    "",
    "--parts",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The video is attached.",
    "--parts",
    `Content-Type: video/quicktime; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
  ];
  return `${lines.join("\r\n")}\r\n${bytes.toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n--parts--\r\n`;
}
let server: TestServer;
let token = "";

before(async () => {
  server = await startServer();
  token = (await server.pair()).token;
});

after(async () => {
  await server?.stop();
});

test("syncs a few messages and one of about 30 MB within the small-memory limits", async () => {
  for (let i = 1; i <= 3; i++) {
    await server.fake.deliver(plainMessage({ from: "Bo <bo@people.example>", to: ADDRESS, subject: `Note ${i}`, body: `Small note number ${i}.` }).raw);
  }
  const inbox = await connectGmail(server, token);
  await until("the small messages", async () => (await server.call("GET", "/v1/search?q=note", undefined, token)).body.items?.length === 3);

  const footage = randomBytes(22 * MB);
  const raw = withAttachment("The footage", "footage.mov", footage);
  const delivered = await server.fake.deliver(raw);
  assert.ok(raw.length > 29 * MB, `the raw message is ${(raw.length / MB).toFixed(1)} MB`);

  const pid = workerdPid();
  const baseline = residentBytes(pid);
  let peak = baseline;
  const sampler = setInterval(() => {
    try {
      peak = Math.max(peak, residentBytes(pid));
    } catch {
      // The process may be gone at the very end.
    }
  }, 25);
  try {
    assert.equal((await server.call("POST", `/v1/inboxes/${inbox.id}/sync`, undefined, token)).status, 204);
    const thread = await until("the large message", async () => (await server.call("GET", "/v1/search?q=footage", undefined, token)).body.items?.[0], 60_000);
    const opened = await server.call("GET", `/v1/threads/${thread.id}`, undefined, token);
    const [message] = opened.body.messages;
    assert.match(message.text, /The video is attached/);
    const [attachment] = message.attachments;
    assert.equal(attachment.filename, "footage.mov");
    assert.ok(Math.abs(attachment.size - footage.length) < 1024, `the attachment's size as Gmail gives it: ${attachment.size}`);
  } finally {
    clearInterval(sampler);
  }

  const forms = server.fake.requests.filter((request) => request.path === `/messages/${delivered.id}`).map((request) => request.query.get("format"));
  assert.deepEqual([...new Set(forms)].sort(), ["full", "minimal"], `asked for its size, then the full form: ${forms.join(", ")}`);
  assert.equal(server.fake.requests.filter((request) => request.path.includes("/attachments/")).length, 0, "no attachment was downloaded");
  const grew = peak - baseline;
  console.log(`workerd's memory: ${(baseline / MB).toFixed(0)} MB before the 30 MB message, ${(peak / MB).toFixed(0)} MB at most while syncing it (+${(grew / MB).toFixed(0)} MB)`);
  // The raw form took local workerd from 101 to 350 MB in the spike; without the attachment's bytes it barely grows.
  assert.ok(grew < 64 * MB, `workerd grew by ${(grew / MB).toFixed(0)} MB while syncing the 30 MB message`);
  assert.deepEqual(server.outside, []);
});

test("binds more than 100 thread ids in one statement: a search page of 150 and an action on 150", async () => {
  for (let i = 1; i <= 150; i++) {
    await server.fake.deliver(plainMessage({ from: `Shop ${i} <orders${i}@shop${i}.example>`, to: ADDRESS, subject: `Receipt ${i} for your parcel`, body: `Parcel ${i} is on its way.` }).raw);
  }
  const [inbox] = (await server.call("GET", "/v1/inboxes", undefined, token)).body;
  assert.equal((await server.call("POST", `/v1/inboxes/${inbox.id}/sync`, undefined, token)).status, 204);
  const found = await until("150 threads found", async () => {
    const search = await server.call("GET", "/v1/search?q=parcel&limit=150", undefined, token);
    return search.body.items?.length === 150 && search.body.items;
  }, 60_000);
  const ids: string[] = found.map((thread: { id: string }) => thread.id);
  assert.equal(new Set(ids).size, 150);
  assert.ok(found.every((thread: { match?: unknown }) => thread.match), "each of the 150 came with its excerpt");

  const acted = await server.call("POST", "/v1/actions", { threadIds: ids, action: { kind: "read" } }, token);
  assert.equal(acted.status, 200, JSON.stringify(acted.body).slice(0, 300));
  assert.equal(acted.body.threads.length, 150);
  assert.ok(acted.body.threads.every((thread: { unread: boolean }) => !thread.unread));
  // The write-back reads the 150 threads' messages in one statement, then takes UNREAD off each in the mailbox.
  await until("the write-back to Gmail", () => {
    const parcels = [...server.fake.mailbox.messages.values()].filter((message) => message.raw.toString().includes("is on its way"));
    return parcels.length === 150 && parcels.every((message) => !message.labelIds.has("UNREAD"));
  }, 60_000);
  const failed = server.logged(/too many SQL variables|SQLITE_ERROR/i);
  assert.deepEqual(failed, []);
  // The control: this workerd does refuse a statement with 101 bound parameters.
  const values = Array.from({ length: 101 }, (_, i) => i);
  await assert.rejects(server.sql(`SELECT 1 WHERE 0 IN (${values.map(() => "?").join(", ")})`, ...values), /too many SQL variables/);
});

test("two inboxes syncing at once share one gate of two messages", async () => {
  // A longer backlog in the first inbox than the second's start takes, with slow answers, so the second inbox has
  // messages to fetch while the first's are still being fetched: separate gates would put four in flight.
  const [first] = (await server.call("GET", "/v1/inboxes", undefined, token)).body;
  // The first inbox catches up first. The action above left 150 label changes in its history, which batches of
  // CLOUDFLARE_LIMITS.syncBatch read a few rounds at a time: read during the test, they would hold the first inbox back
  // until the second had synced alone. Caught up: a history request starting at the mailbox's latest history id.
  await until("the first inbox caught up with its history", async () => {
    const latest = `startHistoryId=${server.fake.mailbox.historyId}&`;
    if (server.requestLog.some((entry) => entry.account === server.fake && entry.path.includes(latest))) return true;
    await server.call("POST", `/v1/inboxes/${first.id}/sync`, undefined, token);
    return false;
  }, 30_000);
  for (let i = 1; i <= 20; i++) {
    await server.fake.deliver(plainMessage({ from: "Cy <cy@people.example>", to: ADDRESS, subject: `Agenda ${i}`, body: `Agenda item ${i}.` }).raw);
  }
  for (let i = 1; i <= 6; i++) {
    await server.second.deliver(plainMessage({ from: "Di <di@people.example>", to: SECOND_ADDRESS, subject: `Agenda ${i}`, body: `Agenda item ${i}.` }).raw);
  }
  server.fake.latencyMs = 40;
  server.second.latencyMs = 40;
  const from = server.requestLog.length;
  try {
    await Promise.all([server.call("POST", `/v1/inboxes/${first.id}/sync`, undefined, token), connectGmail(server, token, server.second)]);
    await until("both inboxes' agendas", async () => (await server.call("GET", "/v1/search?q=agenda&limit=50", undefined, token)).body.items?.length === 26, 60_000);
  } finally {
    server.fake.latencyMs = 0;
    server.second.latencyMs = 0;
  }
  const log = server.requestLog.slice(from);
  const message = /\/messages\/([^/?]+)\?format=/;
  const firstMessages = log.filter((entry) => entry.account === server.fake && message.test(entry.path));
  const secondList = log.find((entry) => entry.account === server.second && /\/messages\?q=/.test(entry.path))!.at;
  const secondFirst = Math.min(...log.filter((entry) => entry.account === server.second && message.test(entry.path)).map((entry) => entry.at));
  const firstLast = Math.max(...firstMessages.map((entry) => entry.at));
  assert.ok(secondList < firstLast - 300, "the second inbox listed its mail while the first's was still being fetched");
  // The gate takes turns in order: the first inbox's 20 were waiting before the second listed its mail, so each of them
  // had its turn (its first request, the size check) before any of the second's. With a gate per provider the second's
  // would begin right after its listing, beside the first's.
  const firstBegan = new Map<string, number>();
  for (const entry of firstMessages) {
    const id = message.exec(entry.path)![1]!;
    firstBegan.set(id, Math.min(firstBegan.get(id) ?? Number.POSITIVE_INFINITY, entry.at));
  }
  assert.equal(firstBegan.size, 20, "the first inbox fetched its 20 new messages in this test");
  assert.ok(Math.max(...firstBegan.values()) < secondFirst, "and its messages waited for the shared gate");
  assert.ok(server.peakMessageRequests() <= 2, `at most two message requests in flight across both inboxes, not ${server.peakMessageRequests()}`);
});
