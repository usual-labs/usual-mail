// The built Worker in workerd: a first start (every migration, the owner's code in its table and never in the log),
// pairing with that code, the smoke test's REST checks, the front Worker's refusals, live updates over server-sent
// events and a first Gmail sync from the fake outside the isolate.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { plainMessage } from "../../../mail/src/testing/index.ts";
import { ADDRESS, BASE, connectGmail, ROOT, startServer, until, type TestServer } from "./harness.ts";

let server: TestServer;
let token = "";
let code = "";

before(async () => {
  server = await startServer();
});

after(async () => {
  if (server) {
    // Whatever happened, the owner's code was never logged.
    if (code) assert.ok(!server.logs.some((line) => line.includes(code)), "the owner's code is in no log line");
    await server.stop();
  }
});

test("starts, applies every migration and keeps the owner's code in its table, not in the log", async () => {
  const info = await server.call("GET", "/v1/info");
  assert.equal(info.status, 200);
  assert.equal(info.body.name, "usual-mail");
  // No Google client yet, and mail.example is neither a workers.dev host nor USUAL_MAIL_PUBLIC_URL's (google.test.ts).
  assert.deepEqual(info.body.googleSignIn, { available: false, missing: ["client", "address"] });

  const journal = JSON.parse(await readFile(join(ROOT, "server/migrations/meta/_journal.json"), "utf8"));
  const [applied] = await server.sql<{ n: number }>("SELECT count(*) AS n FROM __drizzle_migrations");
  assert.equal(applied!.n, journal.entries.length, "every migration in server/migrations ran");
  const tables = (await server.sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((row) => row.name);
  for (const table of ["inboxes", "threads", "messages", "search_docs", "search_index", "owner_pairing_code"]) assert.ok(tables.includes(table), table);
  const [keys] = await server.sql<{ foreign_keys: number }>("PRAGMA foreign_keys");
  assert.equal(keys!.foreign_keys, 1);

  const rows = await server.sql<{ id: number; code: string; expires_at: string }>("SELECT * FROM owner_pairing_code");
  assert.equal(rows.length, 1);
  code = rows[0]!.code;
  assert.ok(code.length >= 8 && Date.parse(rows[0]!.expires_at) > Date.now());
  assert.equal(server.logged(/started in its Durable Object .*Gmail only; AI through AI SDK/).length, 1);
  assert.equal(server.logged(/An owner's pairing code is waiting, until/).length, 1);
  assert.equal(server.logged(/Data Studio, the object named "server", the table owner_pairing_code/).length, 1);
  assert.ok(!server.logs.some((line) => line.includes(code)), "the code isn't logged");
});

test("pairs with the code read from owner_pairing_code, and the row goes", async () => {
  const paired = await server.pair();
  assert.equal(paired.code, code);
  token = paired.token;
  await until("the owner's code row to go", async () => (await server.sql<{ n: number }>("SELECT count(*) AS n FROM owner_pairing_code"))[0]!.n === 0);
  const again = await server.call("POST", "/v1/pair", { code, name: "Again" });
  assert.equal(again.status, 401, "the code works once");
});

test("answers the smoke test's REST checks", async () => {
  assert.equal((await server.call("GET", "/v1/me", undefined, token)).status, 200);
  const home = await server.call("GET", "/v1/home", undefined, token);
  assert.equal(home.status, 200, JSON.stringify(home.body));
  const counts = await server.call("GET", "/v1/counts", undefined, token);
  assert.equal(counts.status, 200, JSON.stringify(counts.body));
  const search = await server.call("GET", "/v1/search?q=hello", undefined, token);
  assert.equal(search.status, 200, JSON.stringify(search.body));
  assert.deepEqual(search.body.items, []);
  const ai = await server.call("GET", "/v1/ai/status", undefined, token);
  assert.equal(ai.body.state, "not_set_up");
  const asked = await server.call("POST", "/v1/search/ask", { question: "is:unread smoke" }, token);
  assert.equal(asked.status, 200);
  assert.equal(asked.body.ai, "not_set_up");
  assert.equal(asked.body.text, "smoke");
  assert.equal((await server.call("GET", "/sign-in")).status, 200, "the dashboard answers");
  assert.equal((await server.call("GET", "/v1/home")).status, 401, "REST needs a token");
  const mcp = await server.call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, undefined, { accept: "application/json, text/event-stream" });
  assert.equal(mcp.status, 401, "the connector needs an agent's token");
});

test("refuses plain http before reading Authorization, and drops X-Forwarded-Host", async () => {
  for (const auth of [token, undefined]) {
    const plain = await server.call("GET", "http://mail.example/v1/me", undefined, auth);
    assert.equal(plain.status, 403);
    assert.equal(plain.body.error.code, "forbidden");
    assert.match(plain.body.error.message, /only over HTTPS/);
  }
  const over = await server.call("POST", "http://mail.example/v1/pair", { code: "AAAA-AAAA", name: "Plain" });
  assert.equal(over.status, 403, "pairing over http is refused too");
  // The dashboard takes X-Forwarded-Host as its own host when checking where a form came from. Through the Worker the
  // header is gone, so a form from another site is refused before its token is even read.
  const form = { origin: "https://elsewhere.example", "x-forwarded-host": "elsewhere.example", "content-type": "application/x-www-form-urlencoded" };
  const viaWorker = await server.call("POST", "/sign-in", "code=AAAA-AAAA", undefined, form);
  assert.equal(viaWorker.status, 403);
  assert.match(viaWorker.body, /Form not accepted/);
  // The control: from the server's own origin the same form passes that check and fails on its missing token. (The
  // dashboard's own tests show it accepts X-Forwarded-Host; Miniflare's proxy straight to the object refuses an Origin.)
  const own = await server.call("POST", "/sign-in", "code=AAAA-AAAA", undefined, { ...form, origin: BASE });
  assert.equal(own.status, 403);
  assert.match(own.body, /This sign-in form had expired/);
});

test("streams a live update over server-sent events, and syncs a few Gmail messages", async () => {
  for (const subject of ["Lunch on Friday", "The quarterly plan", "Tickets"]) {
    await server.fake.deliver(plainMessage({ from: "Dana <dana@lumen.example>", to: ADDRESS, subject, body: `About ${subject.toLowerCase()}.` }).raw);
  }
  const stream = await server.mf.dispatchFetch(`${BASE}/v1/events`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      received += decoder.decode(value, { stream: true });
    }
  })().catch(() => undefined);
  try {
    await until("the stream to open", () => received.includes(": connected"));
    const inbox = await connectGmail(server, token);
    await until("an inbox.changed event", () => received.includes("event: inbox.changed") && received.includes(inbox.id));
    await until("the first sync", async () => {
      const inboxes = await server.call("GET", "/v1/inboxes", undefined, token);
      return inboxes.body[0]?.status === "ok";
    });
    const found = await until("the three threads", async () => {
      const search = await server.call("GET", "/v1/search?q=about", undefined, token);
      return search.body.items.length === 3 && search.body.items;
    });
    assert.deepEqual(found.map((thread: { subject: string }) => thread.subject).sort(), ["Lunch on Friday", "The quarterly plan", "Tickets"]);
    await until("a thread.changed event", () => received.includes("event: thread.changed"));
    assert.deepEqual(server.outside, [], "nothing but Google's hosts was fetched");
  } finally {
    await reader.cancel().catch(() => undefined);
    await reading;
  }
});
