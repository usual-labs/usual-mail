// End to end with IMAP: the real server and the real IMAP provider (from `src/node/parts.ts`) against an IMAP
// server and an SMTP server running in this process, driven through REST only. What the tests check at the
// mailbox they read with another mail app. No AI credentials are set here, so the server's AI is `not_set_up`:
// undecided threads stay `unknown`, in Home, and wait in the triage queue (e2e-ai-imap.test.ts has the AI on).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { messageWithAttachments, TINY_PNG } from "@usualmail/mail/testing";
import { parts } from "../src/node/parts.ts";
import { rawMail, startMailHost, USER, type MailHost } from "./e2e/imap-server.ts";
import { HOUR, startWorld, type Json, type World } from "./e2e/world.ts";

let host: MailHost;
let w: World;
beforeEach(async () => {
  host = await startMailHost();
  w = await startWorld({ imap: parts.providers.imap! });
});
afterEach(async () => {
  await w.close();
  await host.close();
  assert.deepEqual(w.errors.filter((line) => !line.includes("Watching")), [], "nothing went wrong in the background");
});

const DANA = "Dana Whitfield <dana@lumen.example>";
let next = 0;
const id = (name: string) => `${name}-${++next}@e2e.example`;

/** Where each message with this subject sits at the mailbox: its folder and our keywords. */
async function at(subject: string) {
  return (await host.folders()).filter((m) => m.subject === subject)
    .map((m) => ({ folder: m.folder, seen: m.flags.includes("\\Seen"), keywords: m.flags.filter((f) => f.startsWith("$UsualMail")) }));
}

/** Connects the inbox over REST with some history already in the mailbox, and waits for the first sync. */
async function connect(trust = "act_with_undo"): Promise<Json> {
  host.append("INBOX", rawMail({ from: DANA, subject: "Earlier conversation", messageId: id("earlier") }), ["\\Seen"]);
  host.append("Archive", rawMail({ from: "Ines <ines@lumen.example>", subject: "Old and done", messageId: id("done") }), ["\\Seen"]);
  const inbox = await w.ok("POST", "/v1/inboxes", { body: { name: "Mail Example", color: "#2F6FED", provider: "imap", credentials: host.credentials(), trust } });
  await w.idle();
  return inbox;
}

async function deliver(inbox: Json, from: string, subject: string, extra: Partial<Parameters<typeof rawMail>[0]> = {}): Promise<Json> {
  host.deliver(rawMail({ from, subject, messageId: id(subject.replace(/\W+/g, "-")), ...extra }));
  await w.sync(inbox.id);
  return w.thread(subject);
}

const act = (threadId: string, action: Json, token?: string) => w.ok("POST", "/v1/actions", { token, body: { threadIds: [threadId], action } });

describe("IMAP end to end: connecting and sorting", () => {
  test("a wrong password is refused with a readable reason; the first sync is history; new mail is sorted", async () => {
    const refused = await w.call("POST", "/v1/inboxes", { body: { name: "Mail Example", color: "#2F6FED", provider: "imap", credentials: host.credentials("wrong") } });
    assert.equal(refused.status, 502);
    assert.equal(refused.body.error.code, "provider_error");
    assert.match(refused.body.error.message, /refused the user name or password/);

    const inbox = await connect();
    assert.deepEqual([inbox.address, inbox.status, inbox.version], [USER, "connecting", 1]);
    // How it is connected, as the provider describes it: servers and logins, never the password.
    const login = (port: number) => ({ host: "127.0.0.1", port, secure: false, user: USER });
    assert.deepEqual(inbox.connection, { kind: "imap", imap: login(host.imapPort), smtp: login(host.smtpPort), saveSent: true });
    assert.ok(!JSON.stringify(await w.ok("GET", "/v1/inboxes")).includes("test-password"));
    const [listed] = await w.ok("GET", "/v1/inboxes");
    assert.equal(listed.status, "ok");
    const earlier = await w.thread("Earlier conversation");
    const done = await w.thread("Old and done");
    // No label means `conversation` or `unknown`: the mailbox can't tell, so history under no label is undecided.
    assert.deepEqual([earlier.category, earlier.categorizedBy, earlier.screened, earlier.done], ["unknown", undefined, false, false]);
    assert.deepEqual([done.category, done.categorizedBy, done.done], ["unknown", undefined, true]);
    assert.equal((await w.ok("GET", "/v1/ai/status")).state, "not_set_up");
    assert.deepEqual((await w.ok("GET", "/v1/triage")).map((item: Json) => item.thread.subject), ["Earlier conversation"],
      "with no AI, undecided history waits in the triage queue; done history doesn't");

    await w.ok("POST", `/v1/inboxes/${inbox.id}/rules`, {
      body: { text: "Shop receipts go to Receipts and are done", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }, { kind: "done" }] },
    });
    const receipt = await deliver(inbox, "Shop <billing@mail.shop.example>", "Your receipt");
    assert.deepEqual([receipt.category, receipt.done, receipt.categorizedBy, receipt.screened, receipt.reason], ["receipt", true, "rule", false, "Shop receipts go to Receipts and are done"]);
    assert.deepEqual(await at("Your receipt"), [{ folder: "Usual Mail/Receipts", seen: false, keywords: [] }]);

    const stranger = await deliver(inbox, "Tomas <tomas@brightfield.example>", "Pricing?");
    assert.deepEqual([stranger.category, stranger.screened, stranger.categorizedBy, stranger.reason], ["unknown", true, undefined, "First mail from this sender"]);
    assert.deepEqual(await at("Pricing?"), [{ folder: "Usual Mail/Screening", seen: false, keywords: [] }]);
    assert.deepEqual((await w.ok("GET", "/v1/screening")).items.map((x: Json) => x.subject), ["Pricing?"]);
    assert.ok(!(await w.ok("GET", "/v1/home")).items.some((x: Json) => x.id === stranger.id), "screened: not in Home");

    const known = await deliver(inbox, DANA, "Status update", { headers: { "List-Id": "Lumen Updates <Updates.Lumen.example>" } });
    assert.deepEqual([known.category, known.categorizedBy, known.screened], ["unknown", undefined, false]);
    const queue = await w.ok("GET", "/v1/triage");
    assert.deepEqual(queue.map((item: Json) => item.thread.subject), ["Earlier conversation", "Status update"], "the screened thread isn't in the queue");
    const counts = await w.ok("GET", "/v1/counts");
    assert.deepEqual([counts.all.home, counts.all.screened, counts.all.categories.receipt, counts.all.categories.unknown], [2, 1, 0, 2],
      "Home: two undecided threads; the receipt is done, so in no list");
    const detail = await w.ok("GET", `/v1/threads/${known.id}`);
    assert.equal(detail.messages[0].listId, "updates.lumen.example");
    assert.match(detail.messages[0].text, /Body of Status update/);

    // An inline picture keeps its Content-ID, without angle brackets, and its bytes come from the mailbox.
    host.deliver(messageWithAttachments({ from: DANA, to: USER, subject: "Logo", messageId: id("logo") }, [
      { filename: "logo.png", mimeType: "image/png", content: TINY_PNG, contentId: "logo@lumen.example" },
    ]).raw);
    await w.sync(inbox.id);
    const [withLogo] = (await w.ok("GET", `/v1/threads/${(await w.thread("Logo")).id}`)).messages;
    const [logo] = withLogo.attachments;
    assert.deepEqual([logo.filename, logo.inline, logo.contentId, logo.size], ["logo.png", true, "logo@lumen.example", TINY_PNG.byteLength]);
    assert.match(withLogo.html, /src="cid:logo@lumen\.example"/);
    const file = await w.call("GET", `/v1/messages/${withLogo.id}/attachments/${logo.id}`);
    assert.equal(file.headers.get("content-type"), "image/png");
    assert.deepEqual([...file.body], [...TINY_PNG]);
  });
});

describe("IMAP end to end: an agent triages", () => {
  test("in a suggest inbox it only proposes until a person approves; in an act_with_undo inbox it applies", async () => {
    const inbox = await connect("suggest");
    await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { agentAccess: true } });
    const agent = await w.agent([inbox.id], "Claude Code");
    const news = await deliver(inbox, DANA, "Weekly digest", { body: "Everything that happened this week." });
    const question = await deliver(inbox, DANA, "Can you review this?");

    const queue = await w.ok("GET", "/v1/triage", { token: agent });
    const earlier = await w.thread("Earlier conversation");
    assert.deepEqual(queue.map((item: Json) => [item.thread.id, item.latest.text]), [
      [earlier.id, "Body of Earlier conversation"], [news.id, "Everything that happened this week."], [question.id, "Body of Can you review this?"],
    ]);
    const proposed = await w.ok("POST", "/v1/triage/decisions", { token: agent, body: { decisions: [{ threadId: news.id, category: "newsletter", done: true, reason: "A digest" }] } });
    assert.deepEqual(proposed.records.map((r: Json) => [r.action.kind, r.state]), [["categorize", "proposed"], ["done", "proposed"]]);
    assert.deepEqual([proposed.threads[0].category, proposed.threads[0].categorizedBy, proposed.threads[0].reason], ["unknown", "agent", "A digest"]);
    assert.deepEqual(await at("Weekly digest"), [{ folder: "INBOX", seen: false, keywords: [] }], "only proposed: nothing moved");
    assert.deepEqual((await w.ok("GET", "/v1/triage", { token: agent })).map((item: Json) => item.thread.id), [earlier.id, question.id],
      "a proposed category takes the thread out of the queue");
    assert.equal((await w.call("POST", "/v1/actions/approve", { token: agent, body: { actionIds: [proposed.records[0].id] } })).status, 403);

    const approved = await w.ok("POST", "/v1/actions/approve", { body: { actionIds: proposed.records.map((r: Json) => r.id) } });
    assert.deepEqual(approved.records.map((r: Json) => r.state), ["applied", "applied"]);
    await w.idle();
    assert.deepEqual(await at("Weekly digest"), [{ folder: "Usual Mail/Newsletters", seen: false, keywords: [] }]);

    await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { trust: "act_with_undo" } });
    const applied = await w.ok("POST", "/v1/triage/decisions", { token: agent, body: { decisions: [{ threadId: question.id, category: "conversation", need: "reply", reason: "Dana asks for a review" }] } });
    assert.deepEqual(applied.records.map((r: Json) => [r.action.kind, r.action.category, r.state]), [["categorize", "conversation", "applied"]]);
    assert.deepEqual([applied.threads[0].category, applied.threads[0].categorizedBy, applied.threads[0].need], ["conversation", "agent", "reply"]);
    const again = await w.ok("POST", "/v1/triage/decisions", { token: agent, body: { decisions: [{ threadId: question.id, category: "conversation", reason: "Still a conversation" }] } });
    assert.deepEqual(again.records, [], "a category that doesn't change records nothing");
    assert.deepEqual(await at("Can you review this?"), [{ folder: "INBOX", seen: false, keywords: [] }], "a conversation stays in the inbox: no label");
    const filed = await act(question.id, { kind: "stack", stack: "reply_later" }, agent);
    assert.deepEqual([filed.records[0].state, filed.records[0].silent], ["applied", false]);
    await w.idle();
    assert.deepEqual(await at("Can you review this?"), [{ folder: "Archive", seen: false, keywords: ["$UsualMail_ReplyLater"] }]);
    const handled = await w.ok("GET", "/v1/handled");
    assert.deepEqual(handled.items.map((item: Json) => [item.thread.subject, item.record.action.kind]), [
      ["Can you review this?", "stack"], ["Can you review this?", "categorize"], ["Weekly digest", "done"], ["Weekly digest", "categorize"],
    ]);
  });
});

describe("IMAP end to end: writing back", () => {
  test("each action is seen at the mailbox, a stacked thread leaves the inbox, and a come-back time brings it back", async () => {
    const inbox = await connect();
    const thread = await deliver(inbox, DANA, "Photos");
    const step = async (action: Json) => {
      await act(thread.id, action);
      await w.idle();
      return (await at("Photos"))[0];
    };
    assert.deepEqual(await step({ kind: "read" }), { folder: "INBOX", seen: true, keywords: [] });
    assert.deepEqual(await step({ kind: "unread" }), { folder: "INBOX", seen: false, keywords: [] });
    assert.deepEqual(await step({ kind: "stack", stack: "reply_later" }), { folder: "Archive", seen: false, keywords: ["$UsualMail_ReplyLater"] });
    assert.deepEqual(await step({ kind: "unstack" }), { folder: "INBOX", seen: false, keywords: [] });
    assert.deepEqual(await step({ kind: "categorize", category: "newsletter" }), { folder: "Usual Mail/Newsletters", seen: false, keywords: [] });
    assert.deepEqual(await step({ kind: "categorize", category: "otp" }), { folder: "Usual Mail/One-Time Codes", seen: false, keywords: [] });
    assert.deepEqual(await step({ kind: "categorize", category: "invoice" }), { folder: "Usual Mail/Invoices", seen: false, keywords: [] });
    assert.deepEqual(await step({ kind: "categorize", category: "notification" }), { folder: "Usual Mail/Notifications", seen: false, keywords: [] });
    assert.deepEqual(await step({ kind: "categorize", category: "receipt" }), { folder: "Usual Mail/Receipts", seen: false, keywords: [] });
    assert.deepEqual(await step({ kind: "categorize", category: "conversation" }), { folder: "INBOX", seen: false, keywords: [] });
    assert.deepEqual(await step({ kind: "done" }), { folder: "Archive", seen: false, keywords: [] });
    assert.deepEqual(await step({ kind: "not_done" }), { folder: "INBOX", seen: false, keywords: [] });

    const trashed = await act(thread.id, { kind: "trash" });
    await w.idle();
    assert.deepEqual(await at("Photos"), [{ folder: "Trash", seen: false, keywords: [] }]);
    assert.deepEqual((await w.ok("GET", "/v1/handled")).items, [], "a person's own trash isn't in Handled");
    await w.ok("POST", `/v1/actions/${trashed.records[0].id}/undo`);
    await w.idle();
    assert.deepEqual(await at("Photos"), [{ folder: "INBOX", seen: false, keywords: [] }]);

    assert.deepEqual(await step({ kind: "come_back", at: new Date(w.clock.now() + HOUR).toISOString() }), { folder: "Archive", seen: false, keywords: [] });
    assert.ok(!(await w.ok("GET", "/v1/home")).items.some((x: Json) => x.id === thread.id));
    assert.deepEqual((await w.ok("GET", "/v1/waiting")).items.map((x: Json) => x.id), [thread.id]);
    const waiting = (await w.ok("GET", `/v1/threads/${thread.id}`)).thread;
    w.clock.advance(2 * HOUR);
    await w.idle();
    const back = (await w.ok("GET", `/v1/threads/${thread.id}`)).thread;
    assert.equal(back.version, waiting.version + 1);
    assert.equal((await w.ok("GET", "/v1/home")).items[0].id, thread.id);
    assert.deepEqual((await w.ok("GET", "/v1/waiting")).items, []);
    assert.deepEqual(await at("Photos"), [{ folder: "INBOX", seen: false, keywords: [] }]);

    // Screening answers: a category decided while screened keeps it screened; allowing the sender lets it in.
    const stranger = await deliver(inbox, "Lotte <lotte@brandt.example>", "Shoot next week?");
    await w.idle();
    assert.deepEqual(await at("Shoot next week?"), [{ folder: "Usual Mail/Screening", seen: false, keywords: [] }]);
    const decided = await act(stranger.id, { kind: "categorize", category: "invoice" });
    assert.deepEqual([decided.threads[0].category, decided.threads[0].screened], ["invoice", true], "deciding a category lets nobody in");
    await w.idle();
    assert.deepEqual(await at("Shoot next week?"), [{ folder: "Usual Mail/Screening", seen: false, keywords: [] }], "IMAP keeps one folder: Screening");
    await act(stranger.id, { kind: "allow_sender" });
    await w.idle();
    assert.deepEqual(await at("Shoot next week?"), [{ folder: "Usual Mail/Invoices", seen: false, keywords: [] }], "let in: under its category");
    await act(stranger.id, { kind: "categorize", category: "conversation" });
    await w.idle();
    assert.deepEqual(await at("Shoot next week?"), [{ folder: "INBOX", seen: false, keywords: [] }]);
  });

  test("changes made at the mailbox arrive: archived, back in the inbox, read, stacked, trashed", async () => {
    const inbox = await connect();
    const thread = await deliver(inbox, DANA, "Lunch?");
    const move = (from: string, to: string) => host.otherApp(async (client) => {
      const lock = await client.getMailboxLock(from);
      try {
        const uids = await client.search({ header: { subject: "Lunch?" } }, { uid: true });
        await client.messageMove((uids as number[]).join(","), to, { uid: true });
      } finally {
        lock.release();
      }
    });
    const flag = (folder: string, flags: string[]) => host.otherApp(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ header: { subject: "Lunch?" } }, { uid: true });
        await client.messageFlagsAdd((uids as number[]).join(","), flags, { uid: true });
      } finally {
        lock.release();
      }
    });
    const now = async () => (await w.ok("GET", `/v1/threads/${thread.id}`)).thread;

    await move("INBOX", "Archive");
    await w.sync(inbox.id);
    assert.deepEqual([(await now()).done, (await now()).categorizedBy], [true, undefined], "archiving decides no category");
    await move("Archive", "INBOX");
    await w.sync(inbox.id);
    assert.deepEqual([(await now()).done, (await now()).category, (await now()).categorizedBy], [false, "conversation", "mailbox"], "moved into the inbox there: a conversation");
    assert.equal((await w.ok("GET", "/v1/home")).items[0].id, thread.id);
    await flag("INBOX", ["\\Seen"]);
    await w.sync(inbox.id);
    assert.equal((await now()).unread, false);
    await flag("INBOX", ["$UsualMail_SetAside"]);
    await w.sync(inbox.id);
    assert.deepEqual([(await now()).stack, (await now()).done], ["set_aside", false]);
    assert.deepEqual(await at("Lunch?"), [{ folder: "Archive", seen: true, keywords: ["$UsualMail_SetAside"] }], "a stacked thread leaves the inbox");
    await host.otherApp((client) => client.mailboxCreate(["Usual Mail", "Receipts"]));
    await move("Archive", "Usual Mail/Receipts");
    await w.sync(inbox.id);
    assert.deepEqual([(await now()).category, (await now()).categorizedBy, (await now()).done], ["receipt", "mailbox", false], "a category's folder is that category");
    await host.otherApp((client) => client.mailboxCreate(["Usual Mail", "Screening"]));
    await move("Usual Mail/Receipts", "Usual Mail/Screening");
    await w.sync(inbox.id);
    assert.deepEqual([(await now()).screened, (await now()).category], [true, "receipt"], "the Screening folder screens it; the server keeps the category");
    await move("Usual Mail/Screening", "Trash");
    await w.sync(inbox.id);
    assert.equal((await now()).trashed, true);
    assert.ok(!(await w.ok("GET", "/v1/stacks/set_aside")).items.some((x: Json) => x.id === thread.id));
  });
});

describe("IMAP end to end: replies, credentials, removal", () => {
  test("an agent drafts a reply, a person sends it, and it appears in its thread at the next sync", async () => {
    const inbox = await connect();
    await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { agentAccess: true } });
    const agent = await w.agent([inbox.id]);
    const thread = await deliver(inbox, DANA, "Contract renewal", { body: "Can you confirm by Friday?" });
    const [message] = (await w.ok("GET", `/v1/threads/${thread.id}`, { token: agent })).messages;
    const draft = await w.ok("POST", "/v1/drafts", {
      token: agent,
      body: { inboxId: inbox.id, threadId: thread.id, inReplyToMessageId: message.id, to: [{ name: "Dana Whitfield", email: "dana@lumen.example" }], subject: "Re: Contract renewal", body: "Confirmed." },
    });
    assert.equal((await w.call("POST", `/v1/drafts/${draft.id}/send`, { token: agent })).body.error.code, "needs_person");
    const sent = await w.ok("POST", `/v1/drafts/${draft.id}/send`);
    assert.deepEqual([sent.state, sent.note, sent.version], ["sent", undefined, 3]);
    assert.equal(host.received.length, 1);
    assert.match(host.received[0]!.toString(), /In-Reply-To: <Contract-renewal-\d+@e2e\.example>/);
    await w.idle();
    const detail = await w.ok("GET", `/v1/threads/${thread.id}`);
    assert.deepEqual(detail.messages.map((m: Json) => [m.subject, m.outgoing]), [["Contract renewal", false], ["Re: Contract renewal", true]]);
    assert.deepEqual(detail.drafts, []);
    assert.deepEqual((await at("Re: Contract renewal")).map((m) => m.folder), ["Sent"], "the server never files outgoing mail");
  });

  test("changing credentials: refused, for another address, then the new password; removing leaves the mailbox as it was", async () => {
    const inbox = await connect();
    host.setPassword("new-password");
    // The open connection stays logged in; pausing and resuming makes the server log in again.
    await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { paused: true } });
    await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { paused: false } });
    await w.idle();
    const [failing] = await w.ok("GET", "/v1/inboxes");
    assert.equal(failing.status, "needs_attention");
    assert.match(failing.statusDetail, /refused the user name or password/);
    assert.ok(w.errors.every((line) => /refused the user name or password/.test(line)));
    w.errors.length = 0;

    const wrong = await w.call("PATCH", `/v1/inboxes/${inbox.id}`, { body: { name: "Renamed", credentials: host.credentials("old-guess") } });
    assert.deepEqual([wrong.status, wrong.body.error.code], [502, "provider_error"]);
    assert.match(wrong.body.error.message, /refused the user name or password/);
    const other = await w.call("PATCH", `/v1/inboxes/${inbox.id}`, { body: { credentials: host.credentials("new-password", "someone@mail.example") } });
    assert.deepEqual([other.status, other.body.error.code], [400, "invalid"]);
    assert.equal((await w.ok("GET", "/v1/inboxes"))[0].name, "Mail Example");

    const fixed = await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { credentials: host.credentials("new-password") } });
    assert.equal(fixed.status, "connecting");
    host.deliver(rawMail({ from: DANA, subject: "After the new password", messageId: id("after") }));
    await w.idle();
    await w.sync(inbox.id);
    assert.equal((await w.ok("GET", "/v1/inboxes"))[0].status, "ok");
    assert.equal((await w.thread("After the new password")).category, "unknown");

    const before = await host.folders();
    assert.equal((await w.call("DELETE", `/v1/inboxes/${inbox.id}`)).status, 204);
    assert.deepEqual(await w.ok("GET", "/v1/inboxes"), []);
    assert.equal((await w.call("GET", `/v1/search?q=After`)).body.items.length, 0);
    assert.deepEqual(await host.folders(), before, "nothing at the mailbox changed");
  });
});
