// Pictures from the web through the service and REST: a thread's HTML points its pictures at the picture route with
// trackers taken out; only a person's device may load them; only pictures the stored HTML shows can be fetched (the
// server is no open proxy); screened and blocked senders' pictures are held back; removing an inbox forgets its
// pictures. A fake picture source stands in for the web; nothing is fetched.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { MAX_SHOWN_HTML_LENGTH, type Inbox, type Message } from "@usualmail/core";
import { sanitizeHtml } from "@usualmail/mail";
import type { PictureSource, WebPicture } from "../src/host.ts";
import { pictureId, servedPlans } from "../src/pictures/present.ts";
import { PictureRefused } from "../src/pictures/refused.ts";
import { createApp } from "../src/rest/app.ts";
import { at, historyFromKnown, HOUR, KNOWN, makeServer, type TestServer } from "./helpers.ts";
import { png } from "./picture-hosts.ts";

const HERO = "https://news.example/hero.png";
const NEWSLETTER = sanitizeHtml([
  `<p>This week</p><img src="${HERO}" alt="Hero" width="600">`,
  `<img src="https://emltrk.com/v2/abc123" alt="">`,
  `<img src="https://news.example/p.gif" width="1" height="1">`,
].join(""))!;

class FakePictures implements PictureSource {
  calls: Array<{ inboxId: string; url: string }> = [];
  forgotten: string[] = [];
  answer: (url: string) => WebPicture = () => ({ mimeType: "image/png", data: png(10, 10) });

  async get(inboxId: string, url: string): Promise<WebPicture> {
    this.calls.push({ inboxId, url });
    return this.answer(url);
  }

  async forget(inboxId: string): Promise<void> {
    this.forgotten.push(inboxId);
  }
}

let t: TestServer;
let pictures: FakePictures;
let app: ReturnType<typeof createApp>;
let inbox: Inbox;

beforeEach(async () => {
  pictures = new FakePictures();
  t = await makeServer({ pictures });
  app = createApp(t.server, { scheduler: t.clock, log: t.host.log });
  inbox = (await t.connect({ address: "me@acme.example", agentAccess: true, history: [historyFromKnown] })).inbox;
});
afterEach(() => t.close());

function get(path: string, token = t.personToken): Promise<Response> {
  return Promise.resolve(app.request(path, { headers: { authorization: `Bearer ${token}` } }));
}

async function newsletter(from = KNOWN, subject = "This week"): Promise<Message> {
  const thread = await t.receive(inbox, { from, subject, html: NEWSLETTER, text: "This week", date: at(-HOUR) });
  return (await t.server.thread(t.person, thread.id)).messages.at(-1)!;
}

const heroPath = async (message: Message) => `/v1/messages/${message.id}/pictures/${await pictureId(HERO)}`;

describe("a thread's pictures from the web", () => {
  test("point at the picture route, with trackers taken out and counted; nothing is fetched until asked", async () => {
    const message = await newsletter();
    const path = await heroPath(message);
    assert.equal(message.html, `<p>This week</p><img src="${path}" alt="Hero" width="600" />`);
    assert.deepEqual(message.remotePictures, { shown: 1, trackersRemoved: 2, trackers: ["Litmus"] });
    assert.equal(pictures.calls.length, 0);
  });

  test("a person's device loads one: typed, sandboxed, never sniffed", async () => {
    const message = await newsletter();
    const res = await get(await heroPath(message));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    assert.equal(res.headers.get("content-disposition"), 'inline; filename="picture"');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), png(10, 10));
    assert.deepEqual(pictures.calls, [{ inboxId: inbox.id, url: HERO }]);
  });

  test("an agent's token gets needs_person, and its thread's HTML holds no address on the web", async () => {
    const message = await newsletter();
    const agent = await t.agent([inbox.id]);
    const res = await get(await heroPath(message), agent.token);
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "needs_person");
    const seen = (await t.server.thread(agent.caller, message.threadId)).messages.at(-1)!;
    assert.doesNotMatch(seen.html!, /https?:/);
    assert.equal(pictures.calls.length, 0);
  });

  test("the service itself refuses an agent, whatever route it came by", async () => {
    const message = await newsletter();
    const agent = await t.agent([inbox.id]);
    await assert.rejects(t.server.fetchPicture(agent.caller, message.id, await pictureId(HERO)), (error: Error & { code?: string }) => error.code === "needs_person");
    assert.equal(pictures.calls.length, 0);
  });

  test("a device that may see only another inbox gets nothing from this one", async () => {
    const message = await newsletter();
    const other = (await t.connect({ address: "other@acme.example" })).inbox;
    const limited = { ...t.person, inboxIds: [other.id] };
    await assert.rejects(t.server.fetchPicture(limited, message.id, await pictureId(HERO)), (error: Error & { code?: string }) => error.code === "not_found");
    assert.equal(pictures.calls.length, 0);
    assert.equal((await t.server.fetchPicture(t.person, message.id, await pictureId(HERO))).mimeType, "image/png");
  });

  test("only pictures the stored HTML shows: not a tracker's, not another address, not another message's", async () => {
    const message = await newsletter();
    const other = await newsletter(KNOWN, "Another week");
    const ids = [
      await pictureId("https://emltrk.com/v2/abc123"),
      await pictureId("https://news.example/p.gif"),
      await pictureId("https://elsewhere.example/x.png"),
      "not-an-id",
    ];
    for (const id of ids) {
      const res = await get(`/v1/messages/${message.id}/pictures/${id}?url=${encodeURIComponent("https://elsewhere.example/x.png")}`);
      assert.equal(res.status, 404, id);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "not_found");
    }
    // The other message shows the same picture under its own path; its id doesn't open this message's pictures.
    assert.equal((await get(`/v1/messages/nope/pictures/${await pictureId(HERO)}`)).status, 404);
    assert.equal((await get(await heroPath(other))).status, 200);
    assert.equal(pictures.calls.length, 1);
  });

  test("a picture request reuses the message's plan: no new plan, no tracker matched again", async () => {
    const message = await newsletter();
    const before = { ...servedPlans.work };
    for (let i = 0; i < 20; i++) assert.equal((await get(await heroPath(message))).status, 200);
    assert.deepEqual(servedPlans.work, before);
  });

  test(`HTML longer than ${MAX_SHOWN_HTML_LENGTH} characters is served as its text, and shows no pictures`, async () => {
    const html = `${NEWSLETTER}<p>${"word ".repeat(MAX_SHOWN_HTML_LENGTH / 5)}</p>`;
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Huge", html, text: "Huge, as text", date: at(-HOUR) });
    const message = (await t.server.thread(t.person, thread.id)).messages.at(-1)!;
    assert.equal(message.html, undefined);
    assert.equal(message.htmlTooLarge, true);
    assert.equal(message.text, "Huge, as text");
    assert.equal(message.remotePictures, undefined);
    assert.equal((await get(await heroPath(message))).status, 404);
    assert.equal(pictures.calls.length, 0);
  });

  test("a message whose rewriting fails is served as its text; the thread and the triage queue still open", async () => {
    const message = await newsletter();
    const present = servedPlans.present;
    servedPlans.present = async () => {
      throw new RangeError("Maximum call stack size exceeded");
    };
    try {
      const served = (await t.server.thread(t.person, message.threadId)).messages.at(-1)!;
      assert.equal(served.html, undefined);
      assert.equal(served.text, "This week");
      assert.equal(served.remotePictures, undefined);
      await t.server.triageQueue(t.person, {});
      assert.ok(t.errors.some((line) => /picture pass failed for message msg_\w+: RangeError/.test(line)), t.errors.join("\n"));
      assert.ok(!t.errors.some((line) => line.includes("Maximum call stack")), "only a reason code is logged");
    } finally {
      servedPlans.present = present;
    }
  });

  test("style nested deeper than any real mail is read no further, stored or served", async () => {
    const deep = `<style>${"@media all{".repeat(20_000)}p{color:red}${"}".repeat(20_000)}</style><p>Deep</p>`;
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Deep", html: deep, text: "Deep", date: at(-HOUR) });
    const served = (await t.server.thread(t.person, thread.id)).messages.at(-1)!;
    assert.equal(served.html, "<p>Deep</p>");
  });

  test("a refusal from the web is a 502 in a person's words", async () => {
    pictures.answer = () => {
      throw new PictureRefused("its site answered 404");
    };
    const res = await get(await heroPath(await newsletter()));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: { code: "provider_error", message: "The picture couldn't be loaded: its site answered 404" } });
  });

  test("a server without pictures from the web says so", async () => {
    const bare = await makeServer();
    try {
      const own = (await bare.connect({ address: "me@acme.example", history: [historyFromKnown] })).inbox;
      const thread = await bare.receive(own, { from: KNOWN, subject: "This week", html: NEWSLETTER, date: at(-HOUR) });
      const message = (await bare.server.thread(bare.person, thread.id)).messages.at(-1)!;
      await assert.rejects(bare.server.fetchPicture(bare.person, message.id, await pictureId(HERO)), /doesn't load pictures from the web/);
    } finally {
      await bare.close();
    }
  });
});

describe("held back until the sender is let in", () => {
  const STRANGER = { name: "Promo", email: "deals@promo.example" };

  test("a screened sender's pictures, until they are let in", async () => {
    const message = await newsletter(STRANGER, "Deals");
    assert.equal((await t.server.thread(t.person, message.threadId)).thread.screened, true);
    assert.doesNotMatch(message.html!, /\/v1\/messages\//);
    assert.match(message.html!, /<img alt="Hero" width="600" \/>/);
    assert.deepEqual(message.remotePictures, { shown: 0, trackersRemoved: 2, trackers: ["Litmus"], heldBack: "screened" });
    assert.equal((await get(await heroPath(message))).status, 404);

    await t.server.act(t.person, { threadIds: [message.threadId], action: { kind: "allow_sender" } });
    const after = (await t.server.thread(t.person, message.threadId)).messages.at(-1)!;
    assert.deepEqual(after.remotePictures, { shown: 1, trackersRemoved: 2, trackers: ["Litmus"] });
    assert.equal((await get(await heroPath(after))).status, 200);
    assert.equal(pictures.calls.length, 1);
  });

  test("a blocked sender's pictures", async () => {
    const message = await newsletter();
    await t.server.act(t.person, { threadIds: [message.threadId], action: { kind: "block_sender" } });
    const after = (await t.server.thread(t.person, message.threadId)).messages.at(-1)!;
    assert.equal(after.remotePictures?.heldBack, "blocked");
    assert.equal((await get(await heroPath(after))).status, 404);
    assert.equal(pictures.calls.length, 0);
  });

  test("a stranger forging the inbox's own address gets no pictures in a screened thread (the review's case)", async () => {
    const first = await newsletter(STRANGER, "Deals");
    const mailbox = t.mailboxes.get(inbox.address)!;
    const key = mailbox.messages().find((m) => m.subject === "Deals")!.threadKey;
    // From: is only what the sender wrote: such mail isn't the inbox's own (it isn't in Sent).
    mailbox.deliver({ from: { name: "Me", email: inbox.address }, subject: "Re: Deals", html: NEWSLETTER, threadKey: key, date: at(-HOUR / 2) });
    await t.sync(inbox);
    const detail = await t.server.thread(t.person, first.threadId);
    assert.equal(detail.thread.screened, true);
    const forged = detail.messages.at(-1)!;
    assert.equal(forged.outgoing, false);
    assert.equal(forged.remotePictures?.heldBack, "screened");
    assert.equal((await get(await heroPath(forged))).status, 404);
    assert.equal(pictures.calls.length, 0);
  });

  test("a blocked sender forging the inbox's own address into their own thread gets no pictures", async () => {
    const message = await newsletter(STRANGER, "Deals");
    await t.server.act(t.person, { threadIds: [message.threadId], action: { kind: "block_sender" } });
    const mailbox = t.mailboxes.get(inbox.address)!;
    const key = mailbox.messages().find((m) => m.subject === "Deals")!.threadKey;
    mailbox.deliver({ from: { name: "Me", email: inbox.address }, subject: "Re: Deals", html: NEWSLETTER, threadKey: key, date: at(-HOUR / 2) });
    await t.sync(inbox);
    const forged = (await t.server.thread(t.person, message.threadId)).messages.at(-1)!;
    assert.equal(forged.remotePictures?.heldBack, "blocked");
    assert.equal((await get(await heroPath(forged))).status, 404);
    assert.equal(pictures.calls.length, 0);
  });

  test("nothing from a blocked sender's message in someone else's thread", async () => {
    const STRANGER_IN = { name: "Pest", email: "pest@spam.example" };
    const first = await t.receive(inbox, { from: STRANGER_IN, subject: "Hello", text: "Hi", date: at(-3 * HOUR) });
    await t.server.act(t.person, { threadIds: [first.id], action: { kind: "block_sender" } });
    const ours = await newsletter();
    const mailbox = t.mailboxes.get(inbox.address)!;
    const key = mailbox.messages().find((m) => m.subject === "This week")!.threadKey;
    mailbox.deliver({ from: STRANGER_IN, subject: "Re: This week", html: NEWSLETTER, threadKey: key, date: at(-HOUR / 2) });
    await t.sync(inbox);
    const hidden = mailbox.messages().find((m) => m.subject === "Re: This week")!;
    const stored = (await t.server.thread(t.person, ours.threadId)).messages;
    assert.equal(stored.length, 1, "the blocked sender's message isn't shown");
    // Its id isn't served either, under any id the service could have given it.
    const { messages } = await import("../src/db/index.ts");
    const { eq } = await import("drizzle-orm");
    const row = await t.host.db.select().from(messages).where(eq(messages.ref, hidden.ref)).get();
    assert.ok(row);
    assert.equal((await get(`/v1/messages/${row.id}/pictures/${await pictureId(HERO)}`)).status, 404);
    assert.equal(pictures.calls.length, 0);
  });
});

test("removing an inbox forgets the pictures kept for it", async () => {
  await t.server.removeInbox(t.person, inbox.id);
  await t.server.whenIdle();
  assert.deepEqual(pictures.forgotten, [inbox.id]);
});
