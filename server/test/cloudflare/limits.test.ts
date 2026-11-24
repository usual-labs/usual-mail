// The Cloudflare host's limits in workerd (limits.ts, src/sync/fit.ts, src/search/indexer.ts): workerd refuses a row
// over about 8 MiB (the control); a message whose stored row would pass it is kept without its HTML, or with its text
// cut, within `storedMessageBytes`, and the sync goes on past it; search's catch-up at start runs after the start, in
// the background, and the object answers other requests between its chunks.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { plainMessage } from "../../../mail/src/testing/index.ts";
import { CLOUDFLARE_LIMITS } from "../../src/cloudflare/limits.ts";
import { BODY_SIZE_SQL } from "../../src/search/indexer.ts";
import { HTML_LEFT_OUT, TEXT_CUT } from "../../src/sync/fit.ts";
import { ADDRESS, connectGmail, startServer, until, type TestServer } from "./harness.ts";

const MB = 1024 * 1024;

let server: TestServer;
let token = "";

before(async () => {
  server = await startServer();
  token = (await server.pair()).token;
});

after(async () => {
  await server?.stop();
});

/** A message with a text part and an HTML part, raw. */
function alternative(subject: string, text: string, html: string): string {
  return [
    "From: News <news@letters.example>",
    `To: ${ADDRESS}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${subject.replace(/\W+/g, "-")}@letters.example>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    "--alt--",
    "",
  ].join("\r\n");
}

test("workerd refuses a row over about 8 MiB, all its columns together, as a Durable Object refuses one over 8 MB", async () => {
  // The control for the fit below. Cloudflare's limits page gives 8 MB for a string, BLOB or row; local workerd's own
  // limit is a few bytes over 8 MiB (8,388,636 bytes of one text value passed, 8,388,637 failed, 2026-11-21).
  await server.sql("CREATE TABLE IF NOT EXISTS large_row (v TEXT, w TEXT)");
  const tooBig = /SQLITE_TOOBIG/;
  await assert.rejects(server.sql("INSERT INTO large_row (v) VALUES (?)", "x".repeat(8 * MB + 64 * 1024)), tooBig);
  // Two values of 4.5 MB each: the limit is the row's, not each value's.
  await assert.rejects(server.sql("INSERT INTO large_row (v, w) VALUES (?, ?)", "x".repeat(4_500_000), "y".repeat(4_500_000)), tooBig);
  await server.sql("INSERT INTO large_row (v, w) VALUES (?, ?)", "x".repeat(CLOUDFLARE_LIMITS.storedMessageBytes), "y".repeat(1_000_000));
  assert.deepEqual(await server.sql("SELECT count(*) AS n FROM large_row"), [{ n: 1 }]);
  await server.sql("DROP TABLE large_row");
});

test("a message whose row would pass 8 MB is kept within the limit, and the sync goes on past it", async () => {
  const ownText = "The text version of this letter, which is more than a stub of its HTML. ".repeat(10);
  const html = `<html><body>${"<p>A long paragraph of a very large letter, written out many times over.</p>\n".repeat(120_000)}</body></html>`;
  assert.ok(html.length > 8 * MB, `the HTML is ${(html.length / MB).toFixed(1)} MiB, over a row's limit`);
  await server.fake.deliver(alternative("The huge letter", ownText, html));
  await server.fake.deliver(plainMessage({ from: "Log <log@machines.example>", to: ADDRESS, subject: "The long log", body: "A line of a long log.\r\n".repeat(150_000) }).raw);
  await server.fake.deliver(plainMessage({ from: "Ann <ann@people.example>", to: ADDRESS, subject: "After the large ones", body: "Small." }).raw);
  // For the search test below.
  for (let i = 0; i < 30; i++) {
    await server.fake.deliver(plainMessage({ from: `P${i} <p${i}@people.example>`, to: ADDRESS, subject: `Indexed later ${i}`, body: `Findable note ${i}.` }).raw);
  }

  await connectGmail(server, token);
  await until("the sync past the large messages", async () => (await server.call("GET", "/v1/inboxes", undefined, token)).body[0]?.status === "ok", 60_000);
  const rows = await server.sql<{ subject: string; text_bytes: number; html_bytes: number | null; text_end: string }>(
    "SELECT subject, length(CAST(text AS BLOB)) AS text_bytes, length(CAST(html AS BLOB)) AS html_bytes, substr(text, -200) AS text_end FROM messages ORDER BY subject",
  );
  const by = new Map(rows.map((row) => [row.subject, row]));
  const huge = by.get("The huge letter")!;
  assert.equal(huge.html_bytes, null, "its HTML left out");
  assert.ok(huge.text_end.endsWith(HTML_LEFT_OUT), "its text says so");
  const log = by.get("The long log")!;
  assert.ok(log.text_end.endsWith(TEXT_CUT), "its text cut, and says so");
  for (const row of [huge, log]) assert.ok(row.text_bytes + (row.html_bytes ?? 0) < CLOUDFLARE_LIMITS.storedMessageBytes);
  assert.ok(by.has("After the large ones"), "the message after them is stored");
  const status = (await server.call("GET", "/v1/inboxes", undefined, token)).body[0];
  assert.equal(status.status, "ok");
  assert.equal(server.logged(/Syncing .* failed/).length, 0, "no batch failed");
});

test("search's catch-up at start runs after the start, in the background, and a search waits for it", async () => {
  assert.equal((await server.call("GET", "/v1/search?q=Findable&limit=50", undefined, token)).body.items?.length, 30);
  // The index emptied, as an old store would have it, then a new instance.
  await server.sql("DELETE FROM search_people");
  await server.sql("DELETE FROM search_docs");
  await server.sql("DELETE FROM search_index");
  await server.evict();
  const from = server.logs.length;
  assert.equal((await server.call("GET", "/v1/info")).status, 200);
  await until("the catch-up's line", () => server.logged(/Search index: \d+ threads/, from).length === 1);
  const started = server.logs.findIndex((line, i) => i >= from && /started in its Durable Object/.test(line));
  const indexed = server.logs.findIndex((line, i) => i >= from && /Search index: \d+ threads/.test(line));
  assert.ok(started >= 0 && indexed > started, `the start was logged before the catch-up finished:\n${server.logs.slice(from).join("\n")}`);
  const found = await server.call("GET", "/v1/search?q=Findable&limit=50", undefined, token);
  assert.equal(found.body.items.length, 30);
});

test("while search catches up, chunk by chunk, the object answers requests between the chunks", async () => {
  // One thread a chunk, for the next instance, so the catch-up takes many turns of the event loop.
  assert.equal((await server.call("POST", "/__test/limits", { searchChunk: 1 })).status, 200);
  try {
    const [{ total }] = (await server.sql<{ total: number }>("SELECT count(*) AS total FROM threads WHERE removed = 0")) as [{ total: number }];
    assert.ok(total >= 30, `${total} threads`);
    await server.sql("DELETE FROM search_people");
    await server.sql("DELETE FROM search_docs");
    await server.sql("DELETE FROM search_index");
    await server.evict();
    const from = server.logs.length;
    assert.equal((await server.call("GET", "/v1/info")).status, 200);
    // Answered between two chunks: Durable Object SQLite answers at once, so without a turn of the event loop between
    // chunks the whole catch-up would run before any other request.
    const [{ indexed }] = (await server.sql<{ indexed: number }>("SELECT count(*) AS indexed FROM search_docs")) as [{ indexed: number }];
    assert.ok(indexed < total, `${indexed} of ${total} threads were indexed when the next request was answered`);
    await until("the catch-up's line", () => server.logged(/Search index: \d+ threads/, from).length === 1);
    assert.equal((await server.call("GET", "/v1/search?q=Findable&limit=50", undefined, token)).body.items.length, 30);
    console.log(`search's catch-up: ${indexed} of ${total} threads indexed when the next request was answered`);
  } finally {
    await server.call("POST", "/__test/limits", {});
  }
});

test("a start counts as done only once search's catch-up has finished: a reset during it counts as a failed start", async () => {
  // One thread a chunk, so the catch-up after the start takes many turns.
  assert.equal((await server.call("POST", "/__test/limits", { searchChunk: 1 })).status, 200);
  const record = async () => ((await server.call("GET", "/__test/kv")).body as Array<[string, unknown]>).find(([key]) => key === "usual-mail-start")?.[1] as { failures: number } | undefined;
  const emptyIndex = async () => {
    await server.sql("DELETE FROM search_people");
    await server.sql("DELETE FROM search_docs");
    await server.sql("DELETE FROM search_index");
  };
  try {
    await emptyIndex();
    await server.evict();
    let from = server.logs.length;
    assert.equal((await server.call("GET", "/v1/info")).status, 200);
    // The server answers, and its start's record stays while the catch-up runs.
    assert.equal((await record())?.failures, 1, "the record of this start, still there");
    await until("the catch-up's line", () => server.logged(/Search index: \d+ threads/, from).length === 1);
    await until("the record cleared", async () => (await record()) === undefined);

    // Reset in the middle of the catch-up: the next start finds the record and counts that start as a failure.
    await emptyIndex();
    await server.evict();
    assert.equal((await server.call("GET", "/v1/info")).status, 200);
    await server.evict();
    from = server.logs.length;
    assert.equal((await server.call("GET", "/v1/info")).status, 200, "one failure in a row: the next start runs at once");
    assert.equal((await record())?.failures, 2, "the start cut off in its catch-up counted");
    await until("the catch-up's line", () => server.logged(/Search index: \d+ threads/, from).length === 1);
    await until("the record cleared", async () => (await record()) === undefined);
  } finally {
    await server.call("POST", "/__test/limits", {});
  }
});

test("a text starting with U+0000 counts in full toward a round of search bodies, and is indexed", async () => {
  const text = `\u0000${"Nulword after the NUL. ".repeat(60)}`.slice(0, 1_201);
  const [message] = await server.sql<{ id: string }>("SELECT id FROM messages WHERE subject = 'After the large ones'");
  await server.sql("UPDATE messages SET text = ?, html = NULL WHERE id = ?", text, message!.id);
  const [row] = await server.sql<{ text: string; characters: number; size: number }>(
    `SELECT text, length(text) AS characters, ${BODY_SIZE_SQL} AS size FROM messages WHERE id = ?`, message!.id,
  );
  assert.equal(row!.text.length, 1_201, "the text reads back whole");
  assert.equal(row!.characters, 0, "the control: SQLite's length() stops at the NUL");
  assert.ok(row!.size >= 1_201, `what the round counts for it: ${row!.size}`);
  // Indexed with what follows the NUL.
  await server.sql("DELETE FROM search_people");
  await server.sql("DELETE FROM search_docs");
  await server.sql("DELETE FROM search_index");
  await server.evict();
  const from = server.logs.length;
  assert.equal((await server.call("GET", "/v1/info")).status, 200);
  await until("the catch-up's line", () => server.logged(/Search index: \d+ threads/, from).length === 1);
  const found = await server.call("GET", "/v1/search?q=nulword", undefined, token);
  assert.deepEqual(found.body.items.map((item: { subject: string }) => item.subject), ["After the large ones"]);
});
