// The REST surface over a real MailServer: routes, sign-in, errors, pages and the event stream.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ROUTES, type Inbox, type MailEvent, type RouteName } from "@usualmail/core";
import { createApp } from "../src/rest/app.ts";
import { MemoryMailbox } from "../src/testing/index.ts";
import { at, DAY, HOUR, historyFromKnown, KNOWN, makeServer, TEST_KEY, type TestServer } from "./helpers.ts";

let t: TestServer;
let app: ReturnType<typeof createApp>;
let inbox: Inbox;

beforeEach(async () => {
  t = await makeServer();
  app = createApp(t.server, { scheduler: t.clock, log: t.host.log, keepAliveMs: 25_000 });
  inbox = (await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] })).inbox;
});
afterEach(async () => t.close());

function call(method: string, path: string, options: { token?: string; body?: unknown; raw?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined || options.raw !== undefined) headers["content-type"] = "application/json";
  const body = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return Promise.resolve(app.request(path, { method, headers, ...(body !== undefined && { body }) }));
}

// Response bodies are checked field by field, so they are loosely typed here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function json(response: Response | Promise<Response>): Promise<{ status: number; body: Json }> {
  const res = await response;
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

describe("routes", () => {
  test("every route in ROUTES is mounted with its method", async () => {
    const mounted = new Set(app.routes.map((route) => `${route.method} ${route.path}`));
    for (const [name, route] of Object.entries(ROUTES)) {
      assert.ok(mounted.has(`${route.method} ${route.path}`), `${name}: ${route.method} ${route.path} isn't mounted`);
    }
    // And each one answers as itself, not as the catch-all.
    for (const name of Object.keys(ROUTES) as RouteName[]) {
      const route = ROUTES[name];
      const path = route.path.replace(":category", "conversation").replace(":stack", "reply_later").replace(/:\w+/g, "nope");
      const res = await call(route.method, path, { token: t.personToken });
      if (name === "events") {
        assert.equal(res.headers.get("content-type"), "text/event-stream");
        await res.body?.cancel();
        continue;
      }
      const text = await res.text();
      assert.ok(!text.includes("No such route"), `${name} fell through to the catch-all`);
    }
  });

  test("/v1/briefs/latest is not taken for a brief id", async () => {
    const res = await json(call("GET", "/v1/briefs/latest", { token: t.personToken }));
    assert.deepEqual(res, { status: 200, body: null });
  });

  test("health and info need no token", async () => {
    assert.deepEqual(await json(call("GET", "/healthz")), { status: 200, body: { ok: true } });
    // A server its host gave no Google client and no address says Google sign-in isn't available, and why. Paired
    // before any password (the test server pairs a person's device), it has none and can't be claimed.
    assert.deepEqual(await json(call("GET", "/v1/info")), {
      status: 200,
      body: {
        name: "usual-mail",
        version: "0.0.0",
        apiVersion: 1,
        googleSignIn: { available: false, missing: ["client", "address"] },
        owner: { password: false, claimable: false },
      },
    });
  });
});

describe("sign-in", () => {
  test("a pairing code becomes a token once; agents get their inboxes; revoked tokens stop working", async () => {
    const personCode = await t.server.createPairingCode(t.person, { kind: "person" });
    const paired = await json(call("POST", "/v1/pair", { body: { code: personCode.code.toLowerCase().replace("-", " "), name: "iPhone" } }));
    assert.equal(paired.status, 200);
    assert.match(paired.body.token, /^umt_[\w-]{43}$/);
    assert.equal(paired.body.device.kind, "person");
    assert.deepEqual((await json(call("POST", "/v1/pair", { body: { code: personCode.code, name: "Again" } }))).body.error.code, "unauthorized");

    const agentCode = await json(call("POST", "/v1/pairing-codes", { token: paired.body.token, body: { kind: "agent", inboxIds: [inbox.id] } }));
    assert.equal(agentCode.status, 200);
    const agent = await json(call("POST", "/v1/pair", { body: { code: agentCode.body.code, name: "Claude Code" } }));
    assert.deepEqual(agent.body.device.inboxIds, [inbox.id]);
    assert.equal((await json(call("GET", "/v1/inboxes", { token: agent.body.token }))).body[0].id, inbox.id);
    const denied = await json(call("GET", "/v1/devices", { token: agent.body.token }));
    assert.deepEqual(denied, { status: 403, body: { error: { code: "needs_person", message: "Only a person's device can do this" } } });

    const devices = await json(call("GET", "/v1/devices", { token: paired.body.token }));
    assert.deepEqual(devices.body.map((d: { name: string }) => d.name), ["Test Mac", "iPhone", "Claude Code"]);
    assert.equal((await call("DELETE", `/v1/devices/${agent.body.device.id}`, { token: paired.body.token })).status, 204);
    assert.equal((await call("GET", "/v1/inboxes", { token: agent.body.token })).status, 401);
  });
});

describe("pairing", () => {
  test("a wrong, used or expired code is unauthorized; ten wrong codes in ten minutes are rate_limited until they pass", async () => {
    const good = await t.server.createPairingCode(t.person, { kind: "person" });
    const pair = (code: string) => json(call("POST", "/v1/pair", { body: { code, name: "Guess" } }));
    for (let i = 0; i < 10; i++) {
      const wrong = await pair("WRNG-0000");
      assert.deepEqual([wrong.status, wrong.body.error.code], [401, "unauthorized"]);
      t.clock.advance(30_000);
    }
    const limited = await pair(good.code);
    assert.deepEqual([limited.status, limited.body.error.code], [429, "rate_limited"]);
    // Ten minutes after the first wrong code, one try is free again.
    t.clock.advance(10 * 60_000 - 10 * 30_000);
    assert.equal((await pair(good.code)).status, 200);
    assert.equal((await pair(good.code)).body.error.code, "unauthorized");
    const expired = await t.server.createPairingCode(t.person, { kind: "person" });
    t.clock.advance(15 * 60_000);
    assert.equal((await pair(expired.code)).body.error.code, "unauthorized");
  });

  test("a device may end its own token with DELETE /v1/devices/:id", async () => {
    const agent = await t.agent([inbox.id]);
    const id = agent.caller.actor.kind === "agent" ? agent.caller.actor.agentId : "";
    assert.equal((await call("DELETE", `/v1/devices/${id}`, { token: agent.token })).status, 204);
    assert.equal((await call("GET", "/v1/inboxes", { token: agent.token })).status, 401);
  });
});

describe("statuses", () => {
  test("a success is 200 with a body or 204 without, never 201", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Status", date: at(-HOUR) });
    const responses = [
      await call("POST", "/v1/pairing-codes", { token: t.personToken, body: { kind: "person" } }),
      await call("POST", `/v1/inboxes/${inbox.id}/rules`, { token: t.personToken, body: { text: "X", match: { domain: "x.example" }, then: [{ kind: "done" }] } }),
      await call("POST", "/v1/drafts", { token: t.personToken, body: { inboxId: inbox.id, to: [KNOWN], subject: "Hi", body: "Hello" } }),
      await call("POST", "/v1/briefs", { token: t.personToken, body: { from: at(-DAY), to: at(0), sections: [] } }),
      await call("POST", "/v1/actions", { token: t.personToken, body: { threadIds: [thread.id], action: { kind: "done" } } }),
      await call("POST", `/v1/inboxes/${inbox.id}/sync`, { token: t.personToken }),
    ];
    assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200, 200, 204]);
  });
});

describe("errors", () => {
  test("every error is { error: { code, message } } with the status for its code", async () => {
    const cases: Array<[Promise<Response>, number, string]> = [
      [call("GET", "/v1/home"), 401, "unauthorized"],
      [call("GET", "/v1/home", { token: "umt_wrong" }), 401, "unauthorized"],
      [call("GET", "/v1/threads/thr_missing", { token: t.personToken }), 404, "not_found"],
      [call("GET", "/v1/nowhere", { token: t.personToken }), 404, "not_found"],
      [call("POST", "/v1/actions", { token: t.personToken, raw: "{nope" }), 400, "invalid"],
      [call("POST", "/v1/actions", { token: t.personToken, body: { threadIds: [], action: { kind: "done" } } }), 400, "invalid"],
      [call("POST", "/v1/actions", { token: t.personToken, body: { threadIds: ["x"], action: { kind: "explode" } } }), 400, "invalid"],
      [call("GET", "/v1/categories/everything", { token: t.personToken }), 400, "invalid"],
      [call("GET", "/v1/stacks/someday", { token: t.personToken }), 400, "invalid"],
      [call("GET", "/v1/home?limit=0", { token: t.personToken }), 400, "invalid"],
      [call("GET", "/v1/home?cursor=bogus", { token: t.personToken }), 400, "invalid"],
      [call("POST", "/v1/actions", { token: t.personToken, body: { threadIds: ["x"], action: { kind: "categorize", category: "unknown" } } }), 400, "invalid"],
      [call("POST", "/v1/actions", { token: t.personToken, body: { threadIds: ["x"], action: { kind: "move", pile: "reads" } } }), 400, "invalid"],
      [call("PATCH", "/v1/ai", { token: t.personToken, body: { historyDays: 31 } }), 400, "invalid"],
      [call("POST", "/v1/inboxes", { token: t.personToken, body: { name: "Twice", color: "#000000", provider: "imap", credentials: { mailbox: "me@acme.example" } } }), 409, "conflict"],
    ];
    for (const [request, status, code] of cases) {
      const res = await json(request);
      assert.equal(res.status, status, JSON.stringify(res.body));
      assert.equal(res.body.error.code, code);
      assert.equal(typeof res.body.error.message, "string");
    }
    const down = new MemoryMailbox({ address: "down@acme.example" });
    down.failSync = "Connection refused";
    t.mailboxes.set(down.address, down);
    const provider = await json(call("POST", "/v1/inboxes", { token: t.personToken, body: { name: "Down", color: "#000000", provider: "imap", credentials: { mailbox: "down@acme.example" } } }));
    assert.deepEqual([provider.status, provider.body.error.code], [502, "provider_error"]);
  });
});

describe("pages", () => {
  test("lists page with opaque cursors until the last page has none", async () => {
    for (let i = 0; i < 5; i++) await t.receive(inbox, { from: KNOWN, subject: `Mail ${i}`, date: at(-(10 - i) * HOUR) });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await json(call("GET", `/v1/home?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: t.personToken }));
      assert.equal(res.status, 200);
      seen.push(...res.body.items.map((x: { subject: string }) => x.subject));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, ["Mail 4", "Mail 3", "Mail 2", "Mail 1", "Mail 0"]);
    const filtered = await json(call("GET", `/v1/search?q=mail%203&inboxId=${inbox.id}`, { token: t.personToken }));
    assert.deepEqual(filtered.body.items.map((x: { subject: string }) => x.subject), ["Mail 3"]);
  });

  test("Handled filters by state", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Filed", date: at(-HOUR) });
    const agent = await t.agent([inbox.id]);
    const act = await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } });
    await t.server.undo(t.person, act.records[0]!.id);
    assert.equal((await json(call("GET", "/v1/handled", { token: t.personToken }))).body.items.length, 0);
    const undone = await json(call("GET", "/v1/handled?states=undone,rejected", { token: t.personToken }));
    assert.deepEqual(undone.body.items.map((i: { record: { state: string } }) => i.record.state), ["undone"]);
  });

  test("Handled lists silent records only with includeSilent=true", async () => {
    await t.server.updateInbox(t.person, inbox.id, { trust: "act_silently" });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Quietly filed", date: at(-HOUR) });
    const agent = await t.agent([inbox.id]);
    await t.server.act(agent.caller, { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } });
    assert.deepEqual((await json(call("GET", "/v1/handled", { token: t.personToken }))).body.items, []);
    const silent = await json(call("GET", "/v1/handled?includeSilent=true", { token: t.personToken }));
    assert.deepEqual(silent.body.items.map((i: { record: { silent: boolean } }) => i.record.silent), [true]);
    assert.equal((await json(call("GET", "/v1/handled?includeSilent=yes", { token: t.personToken }))).status, 400);
  });
});

describe("bodies", () => {
  test("approve, teach, triage decisions and rules use the contract's bodies; deletes and sync are 204", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Body test", date: at(-HOUR) });
    const decided = await json(call("POST", "/v1/triage/decisions", { token: t.personToken, body: { decisions: [{ threadId: thread.id, category: "conversation", need: "reply", reason: "Mine" }] } }));
    assert.equal(decided.status, 200);
    assert.deepEqual(decided.body.records.map((r: { action: unknown }) => r.action), [{ kind: "categorize", category: "conversation" }]);
    assert.deepEqual(decided.body.threads.map((x: { id: string; need: string; categorizedBy: string }) => [x.id, x.need, x.categorizedBy]), [[thread.id, "reply", "person"]]);
    const again = await json(call("POST", "/v1/triage/decisions", { token: t.personToken, body: { decisions: [{ threadId: thread.id, category: "conversation", reason: "Still mine" }] } }));
    assert.deepEqual(again.body.records, [], "the category didn't change, so nothing is recorded");
    const moved = await json(call("POST", "/v1/actions", { token: t.personToken, body: { threadIds: [thread.id], action: { kind: "categorize", category: "newsletter" } } }));
    const teach = await json(call("POST", `/v1/teach/${moved.body.teach.id}`, { token: t.personToken, body: { accept: true } }));
    assert.equal(teach.body.source, "correction");
    const rule = await json(call("POST", `/v1/inboxes/${inbox.id}/rules`, { token: t.personToken, body: { text: "X", match: { domain: "x.example" }, then: [{ kind: "done" }] } }));
    assert.equal(rule.body.inboxId, inbox.id);
    assert.equal((await call("DELETE", `/v1/rules/${rule.body.id}`, { token: t.personToken })).status, 204);
    assert.equal((await call("POST", `/v1/inboxes/${inbox.id}/sync`, { token: t.personToken })).status, 204);
    const undone = await json(call("POST", `/v1/actions/${moved.body.records[0].id}/undo`, { token: t.personToken }));
    assert.deepEqual([undone.status, undone.body.records[0].state, undone.body.threads[0].category], [200, "undone", "conversation"]);
    const approve = await json(call("POST", "/v1/actions/approve", { token: t.personToken, body: { actionIds: ["act_nope"] } }));
    assert.equal(approve.status, 404);
    const wrapped = await json(call("POST", "/v1/actions/reject", { token: t.personToken, body: ["act_nope"] }));
    assert.equal(wrapped.status, 400);
  });

  test("attachments stream from the provider with their type, sandboxed", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Files", date: at(-HOUR), attachments: [
      { id: "p1", filename: "Invoice 2026.pdf", mimeType: "application/pdf", size: 4, inline: false, data: new Uint8Array([37, 80, 68, 70]) },
      { id: "h1", filename: "page.html", mimeType: "text/html", size: 2, inline: false, data: new Uint8Array([60, 62]) },
    ] });
    const detail = await t.server.thread(t.person, thread.id);
    const message = detail.messages[0]!;
    const pdf = await call("GET", `/v1/messages/${message.id}/attachments/${message.attachments[0]!.id}`, { token: t.personToken });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.match(pdf.headers.get("content-disposition")!, /^inline; filename="Invoice 2026.pdf"/);
    assert.deepEqual([...new Uint8Array(await pdf.arrayBuffer())], [37, 80, 68, 70]);
    const html = await call("GET", `/v1/messages/${message.id}/attachments/${message.attachments[1]!.id}`, { token: t.personToken });
    assert.match(html.headers.get("content-disposition")!, /^attachment;/);
    assert.match(html.headers.get("content-security-policy")!, /sandbox/);
    assert.equal((await call("GET", `/v1/messages/${message.id}/attachments/att_nope`, { token: t.personToken })).status, 404);
  });
});

describe("the fifth revision's routes", () => {
  test("lists by category, stack, waiting and screening; counts; an agent sees its own inboxes' counts and the AI's status only", async () => {
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Counted", date: at(-HOUR) });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "categorize", category: "invoice" } });
    const invoices = await json(call("GET", "/v1/categories/invoice", { token: t.personToken }));
    assert.deepEqual(invoices.body.items.map((x: { subject: string }) => x.subject), ["Counted"]);
    assert.deepEqual((await json(call("GET", "/v1/categories/unknown", { token: t.personToken }))).status, 200);
    assert.deepEqual((await json(call("GET", "/v1/stacks/set_aside", { token: t.personToken }))).body.items, []);
    assert.deepEqual((await json(call("GET", "/v1/waiting", { token: t.personToken }))).body.items, []);
    assert.deepEqual((await json(call("GET", "/v1/screening", { token: t.personToken }))).body.items, []);
    const counts = await json(call("GET", "/v1/counts", { token: t.personToken }));
    assert.equal(counts.body.all.categories.invoice, 1);
    assert.deepEqual(counts.body.inboxes.map((c: { inboxId: string }) => c.inboxId), [inbox.id]);
    assert.ok(Number.isInteger(counts.body.version) && counts.body.version >= 1);

    // A second inbox the agent isn't given: its counts stay out of the agent's view.
    const other = (await t.connect({ address: "other@acme.example", history: [historyFromKnown] })).inbox;
    const agent = await t.agent([inbox.id]);
    const theirs = await json(call("GET", "/v1/counts", { token: agent.token }));
    assert.deepEqual(theirs.body.inboxes.map((c: { inboxId: string }) => c.inboxId), [inbox.id]);
    assert.ok(!JSON.stringify(theirs.body).includes(other.id));
    assert.equal((await json(call("GET", "/v1/ai/status", { token: agent.token }))).body.state, "not_set_up");
    for (const [method, path] of [["GET", "/v1/ai"], ["PATCH", "/v1/ai"], ["POST", "/v1/ai/test"]] as const) {
      const denied = await json(call(method, path, { token: agent.token, body: method === "PATCH" ? { paused: true } : undefined }));
      assert.deepEqual([denied.status, denied.body.error.code], [403, "needs_person"], `${method} ${path}`);
    }
  });

  test("PATCH /v1/ai stores, tests and answers with the settings, never the key; POST /v1/ai/test answers with the status", async () => {
    const saved = await json(call("PATCH", "/v1/ai", { token: t.personToken, body: { credentials: { kind: "direct", provider: "anthropic", apiKey: TEST_KEY } } }));
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.body.credentialsSet, saved.body.connection], [true, { kind: "direct", provider: "anthropic" }]);
    assert.ok(!JSON.stringify(saved.body).includes(TEST_KEY));
    // The test ran before the route answered, so the status read straight afterwards includes it.
    assert.equal((await json(call("GET", "/v1/ai/status", { token: t.personToken }))).body.state, "working");
    const tested = await json(call("POST", "/v1/ai/test", { token: t.personToken }));
    assert.deepEqual([tested.status, tested.body.state], [200, "working"]);
    const read = await json(call("GET", "/v1/ai", { token: t.personToken }));
    assert.deepEqual(read.body, saved.body);
    // There is no per-inbox switch: a key processes every inbox's mail, and the field is refused.
    const refused = await json(call("PATCH", `/v1/inboxes/${inbox.id}`, { token: t.personToken, body: { aiProcessing: true } }));
    assert.deepEqual([refused.status, refused.body.error.code], [400, "invalid"]);
  });

  test("GET /v1/senders and POST /v1/senders/allow: a person's; an agent's token is told needs_person", async () => {
    const thread = await t.receive(inbox, { from: { name: "BrightBuy Deals", email: "deals@brightbuy.example" }, subject: "Sale" });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "block_sender" } });
    const list = await json(call("GET", "/v1/senders?state=blocked&limit=10", { token: t.personToken }));
    assert.deepEqual([list.status, list.body.items.map((item: Json) => [item.inboxId, item.address, item.name, item.messagesSinceBlocked])],
      [200, [[inbox.id, "deals@brightbuy.example", "BrightBuy Deals", 0]]]);
    assert.equal((await json(call("GET", `/v1/senders?inboxId=${inbox.id}`, { token: t.personToken }))).body.items.length, 1, "blocked is the default");
    const odd = await json(call("GET", "/v1/senders?state=known", { token: t.personToken }));
    assert.deepEqual([odd.status, odd.body.error.code], [400, "invalid"]);
    const agent = await t.agent([inbox.id]);
    for (const refused of [
      await json(call("GET", "/v1/senders?state=blocked", { token: agent.token })),
      await json(call("POST", "/v1/senders/allow", { token: agent.token, body: { inboxId: inbox.id, address: "deals@brightbuy.example" } })),
    ]) assert.deepEqual([refused.status, refused.body.error.code], [403, "needs_person"]);
    const allowed = await json(call("POST", "/v1/senders/allow", { token: t.personToken, body: { inboxId: inbox.id, address: "Deals@BrightBuy.example" } }));
    assert.deepEqual([allowed.status, allowed.body.records.length, allowed.body.records[0].action.kind], [200, 1, "allow_sender"]);
    assert.deepEqual((await json(call("GET", "/v1/senders?state=blocked", { token: t.personToken }))).body.items, []);
    const bad = await json(call("POST", "/v1/senders/allow", { token: t.personToken, body: { inboxId: inbox.id } }));
    assert.deepEqual([bad.status, bad.body.error.code], [400, "invalid"]);
  });

  test("PATCH /v1/inboxes/:id takes each of the eight icons added on 2026-11-20 and still refuses an unknown one", async () => {
    for (const icon of ["plane", "wallet", "family", "rocket", "school", "heart", "star", "leaf"]) {
      const set = await json(call("PATCH", `/v1/inboxes/${inbox.id}`, { token: t.personToken, body: { icon } }));
      assert.deepEqual([set.status, set.body.icon], [200, icon], icon);
    }
    const refused = await json(call("PATCH", `/v1/inboxes/${inbox.id}`, { token: t.personToken, body: { icon: "castle" } }));
    assert.deepEqual([refused.status, refused.body.error.code], [400, "invalid"]);
  });
});

describe("events", () => {
  test("a server-sent event stream: one MailEvent per event, a keep-alive comment, closed when the token is revoked", async () => {
    const agent = await t.agent([inbox.id]);
    const res = await call("GET", "/v1/events", { token: agent.token });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const until = async (marker: string) => {
      while (!buffer.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`Stream ended before ${marker}`);
        buffer += decoder.decode(value);
      }
    };
    await until(": connected");

    const thread = await t.receive(inbox, { from: KNOWN, subject: "Live", date: at(-HOUR) });
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "done" } });
    await until("event: action.recorded");
    const blocks = buffer.split("\n\n").filter((block) => block.startsWith("event: "));
    for (const block of blocks) {
      const [eventLine, dataLine] = block.split("\n");
      const event = JSON.parse(dataLine!.slice("data: ".length)) as MailEvent;
      assert.equal(eventLine, `event: ${event.type}`);
    }
    assert.ok(blocks.some((block) => block.startsWith("event: thread.changed")));

    t.clock.advance(25_000);
    await until(": keep-alive");

    await t.server.revokeDevice(t.person, (await t.server.listDevices(t.person)).find((d) => d.kind === "agent")!.id);
    t.clock.advance(25_000);
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  });
});
