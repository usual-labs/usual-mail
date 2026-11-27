// Unsubscribing from a sender (docs/contract.md, "Unsubscribing"; the owner's request of 2026-11-27): the cheapest way
// the sender's proved mail offers, in the background, for a person only; and the browser agent (Browser Use) for a page,
// with its key set in the AI's settings and never shown. After the security review of 2026-11-27: only what the
// sender's own signature vouches for, in mail Gmail's checker proved and the signature says was sent to this inbox, is
// ever used, and never a link in a body; a mailto can't make the inbox say anything; no IP address is a page; nothing is
// done twice after a restart. Made-up mail and a fake Browser Use only.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { Inbox, MailEvent, Thread, Unsubscribe } from "@usualmail/core";
import { postOneClick } from "../src/node/pictures/fetch.ts";
import { BROWSER_USE_MODEL, MOST_COST_USD } from "../src/unsubscribe/browser-use.ts";
import { AGENT_LIMIT_MS, AGENT_POLL_MS, UNPROVED } from "../src/unsubscribe/queue.ts";
import { EMAIL_BODY, headerWays, httpsAddress } from "../src/unsubscribe/ways.ts";
import { eq } from "drizzle-orm";
import { messages, unsubscribes } from "../src/db/index.ts";
import type { DeliverInput } from "../src/testing/index.ts";
import { historyFromKnown, listen, makeServer, type MakeOptions, type TestServer } from "./helpers.ts";

const LETTERS = { name: "Weekly Letters", email: "News@Letters.example" };
/** A made-up Browser Use key. It must show up nowhere a person, an agent, an event or a log could read it. */
const AGENT_KEY = "bu_test-key-6c1d0e9f8a7b";
const ALL_SIGNED = ["list-unsubscribe", "list-unsubscribe-post"] as const;
/** Proved by Gmail's checker from letters.example, with the sender's own signature over To and these parts. */
const proved = (signedUnsubscribe: DeliverInput["signedUnsubscribe"] = [...ALL_SIGNED]): Partial<DeliverInput> => ({
  fromCheck: { result: "verified", domain: "letters.example" },
  signedRecipients: ["to"],
  signedUnsubscribe,
});

let t: TestServer;
let inbox: Inbox;
afterEach(() => t?.close());

async function start(options: MakeOptions = {}, kind: "gmail" | "imap" = "gmail"): Promise<void> {
  t = await makeServer(options);
  inbox = (await t.connect({ address: "me@unsub.example", mailbox: { kind }, history: [historyFromKnown] })).inbox;
}

/** A newsletter with these headers and body, proved unless told otherwise, and its thread. */
async function letter(fields: Partial<DeliverInput>, proof: Partial<DeliverInput> = proved()): Promise<Thread> {
  return t.receive(inbox, { from: LETTERS, subject: `Issue ${Math.random().toString(36).slice(2, 7)}`, ...proof, ...fields });
}

/** Asks, blocks, lets the queue work, and answers the sender's unsubscribe as the blocked list shows it. */
async function unsubscribe(thread: Thread, ms = 1_000): Promise<Unsubscribe> {
  const asked = await t.server.unsubscribe(t.person, thread.id);
  assert.equal(asked.state, "working");
  await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "block_sender" } });
  await t.tick(ms);
  return current();
}

async function current(address = "news@letters.example"): Promise<Unsubscribe> {
  return (await t.server.senders(t.person, {})).items.find((sender) => sender.address === address)!.unsubscribe!;
}

const unsubscribeEvents = (events: MailEvent[]) =>
  events.filter((event): event is Extract<MailEvent, { type: "unsubscribe.changed" }> => event.type === "unsubscribe.changed").map((event) => event.unsubscribe);

const ONE_CLICK = { listUnsubscribe: "<https://letters.example/u/1>, <mailto:u@letters.example>", listUnsubscribePost: "List-Unsubscribe=One-Click" };

describe("the ways a sender's mail offers", () => {
  test("only what the signature vouches for: one-click needs both headers signed", () => {
    const header = "<https://letters.example/u?id=1&t=2>, <mailto:Unsub@Letters.example?subject=stop%20please&body=Pay%20me>";
    assert.deepEqual(headerWays(header, "List-Unsubscribe=One-Click", ["list-unsubscribe", "list-unsubscribe-post"]), {
      oneClick: "https://letters.example/u?id=1&t=2",
      email: { to: "unsub@letters.example", subject: "stop please", body: EMAIL_BODY },
      page: "https://letters.example/u?id=1&t=2",
    });
    assert.equal(headerWays(header, "List-Unsubscribe=One-Click", ["list-unsubscribe"]).oneClick, undefined, "the Post header unsigned");
    assert.deepEqual(headerWays(header, "List-Unsubscribe=One-Click", ["list-unsubscribe-post"]), {}, "the header itself unsigned");
    assert.deepEqual(headerWays("<http://letters.example/u>, <javascript:alert(1)>, <mailto:not-an-address>", "List-Unsubscribe=One-Click", [...ALL_SIGNED]), {});
    assert.equal(headerWays("<https://letters.example/\r\n u?id=9>", null, ["list-unsubscribe"]).page, "https://letters.example/u?id=9", "folded");
  });

  test("a mailto never puts the sender's words in the person's inbox: one plain address, a short plain subject, the server's body", () => {
    const email = (mailto: string) => headerWays(`<${mailto}>`, null, ["list-unsubscribe"]).email;
    assert.deepEqual(email("mailto:ap@victim.example?subject=Invoice%20update&body=Please%20pay%20to%20IBAN%20XX00"), { to: "ap@victim.example", subject: "Invoice update", body: EMAIL_BODY });
    assert.equal(email(`mailto:u@letters.example?subject=${"a".repeat(101)}`)!.subject, "unsubscribe", "too long");
    assert.equal(email("mailto:u@letters.example?subject=Zahlung%20f%C3%BCr%20Sie")!.subject, "unsubscribe", "not plain ASCII");
    assert.equal(email("mailto:u@letters.example?subject=a%0D%0ABcc:%20x@y.example")!.subject, "unsubscribe", "a line break");
    assert.equal(email("mailto:a@letters.example,b@elsewhere.example"), undefined, "a list");
    assert.equal(email("mailto:J%C3%BCrgen@letters.example"), undefined, "not ASCII");
    assert.equal(email("mailto:%22Name%22%20%3Cu@letters.example%3E"), undefined, "a name and brackets");
  });

  test("no page at an IP address, a user name or a host without a registrable domain", () => {
    for (const address of ["https://169.254.169.254/latest", "https://192.168.1.1/", "https://0x7f.1/u", "https://2130706433/u", "https://[::1]/u", "https://user@letters.example/u", "https://localhost/u"]) {
      assert.equal(httpsAddress(address), null, address);
    }
    const registrable = (host: string) => (host.endsWith(".example") ? host.split(".").slice(-2).join(".") : null);
    assert.equal(httpsAddress("https://news.letters.example/u", { registrable }), "https://news.letters.example/u");
    assert.equal(httpsAddress("https://intranet.corp/u", { registrable }), null, "no registrable domain by the list");
  });
});

describe("unsubscribing", () => {
  test("posts the one-click link of proved, signed mail and says so, on the blocked sender and in events", async () => {
    const posted: string[] = [];
    await start({ oneClick: async (url) => (posted.push(url), 200) });
    const thread = await letter(ONE_CLICK);
    const heard = listen(t);
    const done = await unsubscribe(thread);
    heard.stop();
    assert.deepEqual(posted, ["https://letters.example/u/1"]);
    assert.deepEqual([done.state, done.way, done.detail, done.address, done.threadId], ["done", "one_click", "Unsubscribed with their one-click link.", "news@letters.example", thread.id]);
    assert.equal(t.mailboxes.get(inbox.address)!.sent.length, 0, "no email once the one-click worked");
    assert.deepEqual(unsubscribeEvents(heard.events).map((item) => item.state), ["working", "done"]);
  });

  test("a redirect is no yes: the email goes, from the inbox, with the server's own words", async () => {
    await start({ oneClick: async () => 302 });
    const thread = await letter({ ...ONE_CLICK, listUnsubscribe: "<https://letters.example/u/1>, <mailto:u@letters.example?subject=unsubscribe%20me&body=Wire%20money>" });
    const done = await unsubscribe(thread);
    assert.deepEqual([done.state, done.way, done.detail], ["done", "email", "Asked them by email, at u@letters.example."]);
    const [sent] = t.mailboxes.get(inbox.address)!.sent;
    assert.deepEqual([sent!.from.email, sent!.to, sent!.subject, sent!.text], [inbox.address, [{ email: "u@letters.example" }], "unsubscribe me", EMAIL_BODY]);
  });

  test("unproved mail, or a header added above a signed message, is never followed: they stay blocked, in words", async () => {
    const posted: string[] = [];
    await start({ oneClick: async (url) => (posted.push(url), 200) });
    const forged = await letter(ONE_CLICK, { fromCheck: { result: "unverified" } });
    const none = await unsubscribe(forged);
    assert.deepEqual([none.state, none.way, none.url, none.detail], ["failed", undefined, undefined, UNPROVED.mail]);
    // Proved, but its List-Unsubscribe added after signing: unsigned, so neither it nor its page is used.
    await t.receive(inbox, { from: LETTERS, subject: "Added", ...proved([]), ...ONE_CLICK });
    const added = await t.threadBySubject("Added");
    const left = await unsubscribe(added);
    assert.deepEqual([left.state, left.url], ["failed", undefined]);
    assert.match(left.detail!, /no way to unsubscribe/);
    // SPF alone (no DKIM signature vouching for anything) isn't proof either.
    const spf = await t.receive(inbox, { from: { email: "spf@other.example" }, subject: "SPF", fromCheck: { result: "verified", domain: "other.example" }, signedRecipients: [], signedUnsubscribe: [...ALL_SIGNED], ...ONE_CLICK });
    await t.server.unsubscribe(t.person, spf.id);
    await t.server.act(t.person, { threadIds: [spf.id], action: { kind: "block_sender" } });
    await t.tick(1_000);
    assert.equal((await current("spf@other.example")).detail, UNPROVED.mail);
    assert.deepEqual(posted, [], "nothing was posted for any of them");
    assert.equal(t.mailboxes.get(inbox.address)!.sent.length, 0);
  });

  test("an IMAP inbox, whose checker isn't trusted, does nothing but say so", async () => {
    await start({ oneClick: async () => 200 }, "imap");
    const left = await unsubscribe(await letter(ONE_CLICK));
    assert.deepEqual([left.state, left.detail], ["failed", UNPROVED.inbox]);
  });

  test("hands the signed header's page to the person without an agent; a link in the body is never used", async () => {
    await start();
    const page = await unsubscribe(await letter({ listUnsubscribe: "<https://letters.example/prefs/2>" }, proved(["list-unsubscribe"])));
    assert.deepEqual([page.state, page.way, page.url], ["needs_person", "page", "https://letters.example/prefs/2"]);
    assert.match(page.detail!, /set up Browser Use in Settings, AI/);
    // A signed welcome mail repeating words someone else gave, with no header of its own: only blocked.
    const welcome = await t.receive(inbox, {
      from: { email: "hello@service.example" }, subject: "Welcome", fromCheck: { result: "verified", domain: "service.example" }, signedRecipients: ["to"], signedUnsubscribe: [],
      text: "Welcome, unsubscribe https://evil.example/u", html: '<p>Welcome, <a href="https://evil.example/u">unsubscribe</a></p>',
    });
    await t.server.unsubscribe(t.person, welcome.id);
    await t.server.act(t.person, { threadIds: [welcome.id], action: { kind: "block_sender" } });
    await t.tick(1_000);
    const none = await current("hello@service.example");
    assert.deepEqual([none.state, none.url], ["failed", undefined]);
    assert.match(none.detail!, /no way to unsubscribe/);
  });

  test("mail sent on from someone else's inbox isn't used; an alias of this inbox is", async () => {
    await start({ oneClick: async () => 200 });
    const forwarded = await unsubscribe(await letter({ ...ONE_CLICK, to: [{ email: "someone@elsewhere.example" }] }));
    assert.deepEqual([forwarded.state, forwarded.detail], ["failed", UNPROVED.forwarded]);
    const alias = await t.receive(inbox, { from: { email: "list@alias.example" }, subject: "To an alias", fromCheck: { result: "verified", domain: "alias.example" }, signedRecipients: ["to"], signedUnsubscribe: [...ALL_SIGNED], to: [{ email: "me+news@unsub.example" }], ...ONE_CLICK });
    await t.server.unsubscribe(t.person, alias.id);
    await t.server.act(t.person, { threadIds: [alias.id], action: { kind: "block_sender" } });
    await t.tick(1_000);
    assert.equal((await current("list@alias.example")).state, "done");
  });

  test("proved mail from before 0.1.5, whose signed headers were never read, says so", async () => {
    await start({ oneClick: async () => 200 });
    const thread = await letter(ONE_CLICK);
    // As migration 0023 leaves mail stored before it: proved, its signed headers never read.
    await t.host.db.update(messages).set({ signedUnsubscribe: null }).where(eq(messages.threadId, thread.id));
    const old = await unsubscribe(thread);
    assert.deepEqual([old.state, old.detail], ["failed", UNPROVED.old]);
  });

  test("is a person's alone, needs a sender, and asking again while it works answers the same", async () => {
    let answer = (_status: number) => {};
    await start({ oneClick: () => new Promise((resolve) => (answer = resolve)) });
    const thread = await letter(ONE_CLICK);
    const agent = await t.agent([inbox.id]);
    await assert.rejects(t.server.unsubscribe(agent.caller, thread.id), { code: "needs_person" });
    const first = await t.server.unsubscribe(t.person, thread.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await t.server.unsubscribe(t.person, thread.id), first);
    await assert.rejects(t.server.unsubscribe(t.person, "thr_nothing"), { code: "not_found" });
    answer(204);
    await t.tick(1_000);
    assert.equal((await t.server.unsubscribe(t.person, thread.id)).version, first.version + 2, "once done, asking again starts over");
  });

  test("never posts anywhere but a public https address", async () => {
    await assert.rejects(postOneClick("http://letters.example/u"), /https only/);
    await assert.rejects(postOneClick("https://127.0.0.1/u"), /private/);
    await assert.rejects(postOneClick("https://[::1]/u"), /private/);
  });
});

/** A fake Browser Use: the requests it got, and how its run goes. */
function fakeBrowserUse(plan: { key?: number; start?: number; startLost?: boolean; startGate?: Promise<void>; hideList?: boolean; runs?: string[]; output?: unknown; error?: string; cost?: string; listedTask?: string } = {}) {
  const requests: Array<{ method: string; path: string; key: string | null; body: unknown }> = [];
  let polls = 0;
  let task = plan.listedTask ?? "";
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v4/, "") + url.search;
    const key = new Headers(init?.headers).get("x-browser-use-api-key");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init?.method ?? "GET", path, key, body });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (key !== AGENT_KEY) return json(401, { detail: `bad key ${key}` });
    if (path.endsWith("00000000-0000-0000-0000-000000000000/status")) return json(plan.key ?? 404, { detail: "Run not found" });
    if (path === "/runs" && init?.method === "POST") {
      task = (body as { task: string }).task;
      if (plan.startGate) await plan.startGate;
      if (plan.startLost) throw new TypeError("the answer was lost");
      return plan.start ? json(plan.start, { detail: `refused ${key}` }) : json(200, { id: "run_1", status: "queued", sessionId: "ses_1" });
    }
    if (path.startsWith("/runs?")) return json(200, { runs: plan.hideList ? [] : [{ id: "run_1", task, status: "running", sessionId: "ses_1" }], hasMore: false });
    if (path === "/runs/run_1/cancel") return json(200, { id: "run_1", status: "cancelled", sessionId: "ses_1" });
    if (path === "/runs/run_1") {
      const runs = plan.runs ?? ["running", "completed"];
      const status = runs[Math.min(polls++, runs.length - 1)]!;
      const ended = status !== "running" && status !== "queued";
      return json(200, {
        id: "run_1", status: ended && plan.error ? "failed" : status, sessionId: "ses_1", totalCostUsd: plan.cost ?? "0.004",
        ...(ended && { output: plan.output ?? { unsubscribed: true } }), ...(plan.error && { error: plan.error }),
      });
    }
    if (path === "/browsers/ses_1") return json(200, { id: "ses_1", status: "stopped" });
    return json(404, {});
  };
  return { fetch, requests };
}

const agentOn = () => t.server.updateAiSettings(t.person, { browserAgent: { service: "browser_use", apiKey: AGENT_KEY } });
const PAGE_ONLY = { listUnsubscribe: "<https://letters.example/prefs/7>" };

describe("the browser agent", () => {
  test("is set up in the AI's settings, tested at once, and its key shown nowhere", async () => {
    const fake = fakeBrowserUse();
    await start({ browserAgent: { fetch: fake.fetch, base: "https://agent.example/api/v4" } });
    const heard = listen(t);
    const settings = await agentOn();
    assert.deepEqual(settings.browserAgent, { service: "browser_use", state: "working" });
    assert.deepEqual(fake.requests.map((request) => [request.method, request.path]), [["GET", "/runs/00000000-0000-0000-0000-000000000000/status"]]);
    const removed = await t.server.updateAiSettings(t.person, { browserAgent: null });
    assert.equal(removed.browserAgent, undefined);
    heard.stop();
    const shown = JSON.stringify([settings, removed, heard.events, t.errors, t.infos]);
    assert.ok(!shown.includes(AGENT_KEY) && !shown.includes("6c1d0e9f"), "the key, or a part of it, is nowhere");
    await assert.rejects(t.server.updateAiSettings(t.person, { browserAgent: { service: "browser_use", apiKey: "two words" } }), (error: Error) => !error.message.includes("two words"));
  });

  test("a refused key says so, in the server's words; demo mode takes none", async () => {
    await start({ browserAgent: { fetch: fakeBrowserUse({ key: 401 }).fetch } });
    const settings = await t.server.updateAiSettings(t.person, { browserAgent: { service: "browser_use", apiKey: "bu_wrong" } });
    assert.deepEqual(settings.browserAgent, { service: "browser_use", state: "key_refused", detail: "Browser Use refused the key." });
    await t.close();
    await start({ browserAgent: { off: true } });
    await assert.rejects(agentOn(), { code: "conflict" });
  });

  test("opens a proved page with bu-fast and a cost cap, reads it until it ends, then stops its browser", async () => {
    const fake = fakeBrowserUse({ runs: ["queued", "running", "completed"] });
    await start({ browserAgent: { fetch: fake.fetch } });
    await agentOn();
    const working = await unsubscribe(await letter(PAGE_ONLY));
    assert.deepEqual([working.state, working.way], ["working", "browser_agent"]);
    const run = fake.requests.find((request) => request.method === "POST" && request.path === "/runs")!;
    const body = run.body as Record<string, unknown> & { task: string };
    assert.deepEqual([body.model, body.maxCostUsd, body.browserSettings, body.keepAlive], [BROWSER_USE_MODEL, MOST_COST_USD, { proxyCountryCode: null }, undefined]);
    assert.match(body.task, /Open https:\/\/letters\.example\/prefs\/7/);
    assert.match(body.task, /me@unsub\.example/);
    assert.ok(!JSON.stringify(body).includes(AGENT_KEY), "the key goes in the header alone");
    for (let i = 0; i < 3; i++) await t.tick(AGENT_POLL_MS);
    const done = await current();
    assert.deepEqual([done.state, done.way, done.detail, done.url], ["done", "browser_agent", "Unsubscribed by Browser Use on their page.", undefined]);
    assert.ok(fake.requests.some((request) => request.method === "PATCH" && request.path === "/browsers/ses_1" && JSON.stringify(request.body) === '{"action":"stop"}'), "its browser stopped");
  });

  test("a run that doesn't confirm, takes too long, or costs more than the cap leaves the page to the person", async () => {
    const fake = fakeBrowserUse({ output: { unsubscribed: false } });
    await start({ browserAgent: { fetch: fake.fetch } });
    await agentOn();
    await unsubscribe(await letter(PAGE_ONLY));
    for (let i = 0; i < 2; i++) await t.tick(AGENT_POLL_MS);
    const left = await current();
    assert.deepEqual([left.state, left.url, left.detail], ["needs_person", "https://letters.example/prefs/7", "Browser Use couldn't finish on their page. Open it to finish."]);

    const slow = fakeBrowserUse({ runs: ["running"] });
    await t.close();
    await start({ browserAgent: { fetch: slow.fetch } });
    await agentOn();
    await unsubscribe(await letter(PAGE_ONLY));
    for (let waited = 0; waited <= AGENT_LIMIT_MS; waited += 60_000) await t.tick(60_000);
    assert.deepEqual([(await current()).state, (await current()).detail], ["needs_person", "Browser Use took too long. Open their page to finish."]);
    assert.ok(slow.requests.some((request) => request.path === "/runs/run_1/cancel"), "the run is stopped");

    const dear = fakeBrowserUse({ runs: ["running"], cost: "0.13" });
    await t.close();
    await start({ browserAgent: { fetch: dear.fetch } });
    await agentOn();
    await unsubscribe(await letter(PAGE_ONLY));
    await t.tick(AGENT_POLL_MS);
    assert.match((await current()).detail!, /reached its US\$0\.10 limit/);
    assert.ok(dear.requests.some((request) => request.path === "/runs/run_1/cancel"));
  });

  test("a run refused for want of credit records it on the settings and hands the page over", async () => {
    await start({ browserAgent: { fetch: fakeBrowserUse({ start: 402 }).fetch } });
    await agentOn();
    const left = await unsubscribe(await letter(PAGE_ONLY));
    assert.deepEqual([left.state, left.url], ["needs_person", "https://letters.example/prefs/7"]);
    assert.match(left.detail!, /out of credit/);
    assert.equal((await t.server.aiSettings(t.person)).browserAgent?.state, "out_of_credit");
  });

  test("a start whose answer was lost is found by its marker and stopped, never started twice", async () => {
    const fake = fakeBrowserUse({ startLost: true });
    await start({ browserAgent: { fetch: fake.fetch } });
    await agentOn();
    const left = await unsubscribe(await letter(PAGE_ONLY));
    assert.equal(left.state, "needs_person");
    assert.equal(fake.requests.filter((request) => request.path === "/runs" && request.method === "POST").length, 1);
    assert.ok(fake.requests.some((request) => request.path === "/runs/run_1/cancel"), "found among the runs by its marker, and stopped");
  });

  test("a restart after one click and the email failed and a run was marked stops that run first, and says so", async () => {
    const fake = fakeBrowserUse({ listedTask: "Unsubscribe … (Request marker_1.)" });
    await start({ oneClick: async () => 500, browserAgent: { fetch: fake.fetch } });
    await agentOn();
    t.mailboxes.get(inbox.address)!.failSend = "Sending is down";
    const thread = await letter({ ...ONE_CLICK, listUnsubscribe: "<https://letters.example/u/1>, <mailto:u@letters.example>" });
    // What the store holds when the server stopped after writing that a run would start, before keeping its id.
    const now = t.clock.now();
    await t.host.db.insert(unsubscribes).values({
      inboxId: inbox.id, address: "news@letters.example", threadId: thread.id, state: "working", step: "start",
      tried: ["email", "browser_agent"], marker: "marker_1", nextAt: now, askedAt: now, updatedAt: now, version: 1,
    });
    // Woken as a restart wakes it: by its next round (another sender asked).
    const other = await t.receive(inbox, { from: { email: "x@other.example" }, subject: "Other" });
    await t.server.unsubscribe(t.person, other.id);
    await t.tick(1_000);
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "block_sender" } });
    const left = await current();
    assert.deepEqual([left.state, left.url], ["needs_person", "https://letters.example/u/1"]);
    assert.equal(left.detail, "The server stopped while Browser Use was starting, so its run was stopped. Open their page to finish.");
    // When no marked run is found, it says only that it asked.
    await t.host.db.update(unsubscribes).set({ state: "working", step: "start", tried: ["browser_agent"], marker: "nothing_like_it", nextAt: t.clock.now() })
      .where(eq(unsubscribes.address, "news@letters.example"));
    await t.server.unsubscribe(t.person, (await t.receive(inbox, { from: { email: "y@other.example" }, subject: "Another" })).id);
    await t.tick(1_000);
    assert.equal((await current()).detail, "The server stopped while Browser Use was starting, so it asked Browser Use to stop any run it had begun. Open their page to finish.");
    assert.ok(fake.requests.some((request) => request.path === "/runs/run_1/cancel"), "the marked run, found and stopped");
    assert.equal(fake.requests.filter((request) => request.path === "/runs" && request.method === "POST").length, 0, "no second run");
    assert.equal(t.mailboxes.get(inbox.address)!.sent.length, 0, "no email again");
  });

  test("a key removed while a run is starting stops that run once its start answers", async () => {
    let release = () => {};
    const fake = fakeBrowserUse({ startGate: new Promise<void>((resolve) => (release = resolve)), hideList: true });
    await start({ browserAgent: { fetch: fake.fetch } });
    await agentOn();
    const thread = await letter(PAGE_ONLY);
    await t.server.unsubscribe(t.person, thread.id);
    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "block_sender" } });
    for (let i = 0; i < 200 && !fake.requests.some((request) => request.path === "/runs" && request.method === "POST"); i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Removed while the start is on its way: the run isn't listed yet, so the removal can't stop it.
    await t.server.updateAiSettings(t.person, { browserAgent: null });
    release();
    await t.tick(1_000);
    assert.ok(fake.requests.some((request) => request.path === "/runs/run_1/cancel"), "stopped once its start answered");
    assert.equal((await current()).detail, "Browser Use was removed before it finished. Open their page to finish.");
  });

  test("removing the key, or the inbox, stops the run in flight", async () => {
    const fake = fakeBrowserUse({ runs: ["running"] });
    await start({ browserAgent: { fetch: fake.fetch } });
    await agentOn();
    await unsubscribe(await letter(PAGE_ONLY));
    await t.server.updateAiSettings(t.person, { browserAgent: null });
    assert.ok(fake.requests.some((request) => request.path === "/runs/run_1/cancel"), "stopped with the key it was started with");
    await t.tick(AGENT_POLL_MS);
    assert.equal((await current()).detail, "Browser Use was removed before it finished. Open their page to finish.");

    const other = fakeBrowserUse({ runs: ["running"] });
    await t.close();
    await start({ browserAgent: { fetch: other.fetch } });
    await agentOn();
    await unsubscribe(await letter(PAGE_ONLY));
    await t.server.removeInbox(t.person, inbox.id);
    assert.ok(other.requests.some((request) => request.path === "/runs/run_1/cancel"));
  });
});
