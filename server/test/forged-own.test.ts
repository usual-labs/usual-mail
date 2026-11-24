// "Outgoing" comes only from the provider's evidence (Gmail's SENT label, IMAP's Sent folder) or from a Message-ID the
// server itself sent, never from a From naming the inbox (the coordinator's decision of 2026-11-18, after the
// pictures' security review). A stranger who writes the inbox's own address as From is treated like any unknown
// sender. Memory mailboxes stand in for the providers: like them, they call mail outgoing only when told it was sent.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Inbox } from "@usualmail/core";
import { sanitizeHtml } from "@usualmail/mail";
import type { PictureSource, WebPicture } from "../src/host.ts";
import { pictureId } from "../src/pictures/present.ts";
import type { MemoryMailbox } from "../src/testing/index.ts";
import { at, historyFromKnown, HOUR, KNOWN, makeServer, type TestServer } from "./helpers.ts";
import { png } from "./picture-hosts.ts";

const ME = { name: "Me", email: "me@acme.example" };
const SPAMMER = { name: "Deals", email: "deals@spam.example" };
const PIXEL = "https://track.example/u/8f3a2c/open.png";
const HTML = sanitizeHtml(`<p>Deal</p><img src="${PIXEL}" alt="" width="40" height="40">`)!;

let t: TestServer;
let inbox: Inbox;
let mailbox: MemoryMailbox;
let fetched: string[];

beforeEach(async () => {
  fetched = [];
  const pictures: PictureSource = {
    async get(_inboxId: string, url: string): Promise<WebPicture> {
      fetched.push(url);
      return { mimeType: "image/png", data: png(40, 40) };
    },
    async forget() {},
  };
  t = await makeServer({ pictures });
  ({ inbox, mailbox } = await t.connect({ address: ME.email, history: [historyFromKnown] }));
});
afterEach(() => t.close());

describe("a forged From: me", () => {
  test("starting its own thread arrives like an unknown sender's mail: screened, its pictures held", async () => {
    const thread = await t.receive(inbox, { from: ME, to: [ME], subject: "Invoice", html: HTML, date: at(-HOUR) });
    const detail = await t.server.thread(t.person, thread.id);
    assert.equal(detail.thread.screened, true);
    assert.equal(detail.thread.done, false);
    assert.equal(detail.thread.sender, ME.email);
    const message = detail.messages.at(-1)!;
    assert.equal(message.outgoing, false, "no \"You\"");
    assert.equal(message.remotePictures?.heldBack, "screened");
    await assert.rejects(t.server.fetchPicture(t.person, message.id, await pictureId(PIXEL)), /No such picture/);
    assert.deepEqual(fetched, []);
  });

  test("addressed to a spammer lets nobody in", async () => {
    const first = await t.receive(inbox, { from: SPAMMER, subject: "Buy now", text: "x", date: at(-3 * HOUR) });
    assert.equal(first.screened, true);
    await t.receive(inbox, { from: ME, to: [SPAMMER], subject: "Hello", text: "x", date: at(-2 * HOUR) });
    assert.equal((await t.server.thread(t.person, first.id)).thread.screened, true);
    const next = await t.receive(inbox, { from: SPAMMER, subject: "Buy more", text: "x", date: at(-HOUR) });
    assert.equal(next.screened, true);
  });

  test("a reply into a forged thread lets its writer in no more than any screened thread does", async () => {
    await t.receive(inbox, { from: ME, to: [ME], subject: "Note", text: "x", date: at(-3 * HOUR) });
    const key = mailbox.messages().find((m) => m.subject === "Note")!.threadKey;
    mailbox.deliver({ from: SPAMMER, subject: "Re: Note", text: "x", threadKey: key, date: at(-2 * HOUR) });
    await t.sync(inbox);
    const later = await t.receive(inbox, { from: SPAMMER, subject: "Fresh offer", text: "x", date: at(-HOUR) });
    assert.equal(later.screened, true);
  });

  test("in a let-in sender's thread shows as written, never as the inbox's own", async () => {
    const ours = await t.receive(inbox, { from: KNOWN, subject: "Lunch", text: "x", date: at(-3 * HOUR) });
    const key = mailbox.messages().find((m) => m.subject === "Lunch")!.threadKey;
    mailbox.deliver({ from: ME, subject: "Re: Lunch", text: "forged", threadKey: key, date: at(-2 * HOUR) });
    await t.sync(inbox);
    const forged = (await t.server.thread(t.person, ours.id)).messages.at(-1)!;
    assert.equal(forged.outgoing, false);
    assert.equal(forged.from.email, ME.email);
  });
});

describe("the inbox's own mail", () => {
  test("mail the provider says the inbox sent still lets its recipients in", async () => {
    const first = await t.receive(inbox, { from: SPAMMER, subject: "Hi there", text: "x", date: at(-3 * HOUR) });
    mailbox.deliver({ from: ME, to: [SPAMMER], subject: "Re: Hi there", text: "x", date: at(-2 * HOUR), outgoing: true, placement: { inInbox: false } });
    await t.sync(inbox);
    assert.equal((await t.server.thread(t.person, first.id)).thread.screened, false);
  });

  test("the inbox's own address is never let in by itself: not as a recipient, not from history", async () => {
    const draft = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [ME, { email: "bo@people.example" }], subject: "To me", body: "x" });
    await t.server.sendDraft(t.person, draft.id);
    await t.server.whenIdle();
    const forged = await t.receive(inbox, { from: ME, to: [ME], subject: "Forged later", text: "x", date: at(-HOUR) });
    assert.equal(forged.screened, true);
    const bo = await t.receive(inbox, { from: { email: "bo@people.example" }, subject: "From Bo", text: "x", date: at(-HOUR / 2) });
    assert.equal(bo.screened, false, "the other recipient was let in");
  });

  test("a copy of mail the server sent, arriving without the Sent evidence, is the inbox's own", async () => {
    const draft = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [{ email: "bo@people.example" }], bcc: [ME], subject: "Copy to me", body: "x" });
    await t.server.sendDraft(t.person, draft.id);
    await t.server.whenIdle();
    const sentCopy = mailbox.messages().find((m) => m.subject === "Copy to me")!;
    // The Sent copy goes (a mailbox that keeps none); the copy to the inbox arrives with the same Message-ID.
    mailbox.remove(sentCopy.ref);
    await t.sync(inbox);
    await t.receive(inbox, { from: ME, to: [{ email: "bo@people.example" }], subject: "Copy to me", text: "x", messageId: sentCopy.messageId!, date: at(0) });
    const found = await t.server.search(t.person, { q: "Copy to me" });
    const detail = await t.server.thread(t.person, found.items[0]!.id);
    assert.equal(detail.messages.at(-1)!.outgoing, true);
    assert.equal(detail.thread.screened, false);
  });
});
