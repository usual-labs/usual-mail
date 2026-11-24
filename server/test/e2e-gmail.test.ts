// End to end with Gmail: the real server and the real Gmail provider against mail's fake of Gmail's REST API,
// driven through REST only. What the tests check at the mailbox they read from the fake's labels. No AI credentials
// are set here (e2e-ai-gmail.test.ts has the AI on), so undecided threads stay `unknown` in Home.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createGmailProvider } from "@usualmail/mail";
import { FakeGmail } from "@usualmail/mail/testing";
import { rawMail } from "./e2e/imap-server.ts";
import { HOUR, startWorld, type Json, type World } from "./e2e/world.ts";

const ADDRESS = "me@gmail.example";
let fake: FakeGmail;
let w: World;
beforeEach(async () => {
  fake = new FakeGmail({ address: ADDRESS });
  w = await startWorld({ gmail: (credentials, options) => createGmailProvider(credentials, { ...options, fetch: fake.fetch, quotaPerSecond: 1_000_000 }) });
});
afterEach(async () => {
  await w.close();
  assert.deepEqual(w.errors, [], "nothing went wrong in the background");
});

const DANA = "Dana Whitfield <dana@lumen.example>";
let next = 0;
const id = (name: string) => `${name}-${++next}@e2e.example`;

/** The labels on each message with this subject, by name, without Gmail's categories. */
function labels(subject: string): string[][] {
  return [...fake.mailbox.messages.values()]
    .filter((m) => m.raw.toString("latin1").includes(`Subject: ${subject}\r\n`))
    .map((m) => [...m.labelIds].map((labelId) => fake.mailbox.labels.get(labelId)?.name ?? labelId).filter((name) => !name.startsWith("CATEGORY_")).sort());
}

async function connect(trust = "act_with_undo"): Promise<Json> {
  await fake.deliver(rawMail({ from: DANA, to: ADDRESS, subject: "Earlier conversation", messageId: id("earlier") }), ["INBOX"]);
  await fake.deliver(rawMail({ from: "Ines <ines@lumen.example>", to: ADDRESS, subject: "Old and done", messageId: id("done") }), []);
  const inbox = await w.ok("POST", "/v1/inboxes", { body: { name: "Gmail", color: "#1F8A5B", provider: "gmail", credentials: fake.credentials, trust } });
  await w.idle();
  return inbox;
}

async function deliver(inbox: Json, from: string, subject: string, extra: Partial<Parameters<typeof rawMail>[0]> = {}): Promise<Json> {
  await fake.deliver(rawMail({ from, to: ADDRESS, subject, messageId: id(subject.replace(/\W+/g, "-")), ...extra }));
  await w.sync(inbox.id);
  return w.thread(subject);
}

const act = (threadId: string, action: Json, token?: string) => w.ok("POST", "/v1/actions", { token, body: { threadIds: [threadId], action } });

describe("Gmail end to end", () => {
  test("a revoked refresh token is refused; the first sync is history; new mail is sorted by a rule and by screening", async () => {
    const refused = await w.call("POST", "/v1/inboxes", { body: { name: "Gmail", color: "#1F8A5B", provider: "gmail", credentials: { ...fake.credentials, refreshToken: "revoked" } } });
    assert.deepEqual([refused.status, refused.body.error.code], [502, "provider_error"]);
    assert.match(refused.body.error.message, /Connect the Gmail inbox again/);

    const inbox = await connect();
    assert.equal(inbox.address, ADDRESS);
    assert.deepEqual([(await w.thread("Earlier conversation")).done, (await w.thread("Old and done")).done], [false, true]);
    assert.deepEqual((await w.ok("GET", "/v1/triage")).map((item: Json) => item.thread.subject), ["Earlier conversation"]);

    await w.ok("POST", `/v1/inboxes/${inbox.id}/rules`, { body: { text: "Shop receipts", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }, { kind: "done" }] } });
    const receipt = await deliver(inbox, "billing@shop.example", "Your receipt");
    assert.deepEqual([receipt.category, receipt.done, receipt.categorizedBy], ["receipt", true, "rule"]);
    assert.deepEqual(labels("Your receipt"), [["UNREAD", "Usual Mail/Receipts"]]);
    const stranger = await deliver(inbox, "Tomas <tomas@brightfield.example>", "Pricing?");
    assert.deepEqual([stranger.category, stranger.screened], ["unknown", true]);
    assert.deepEqual(labels("Pricing?"), [["UNREAD", "Usual Mail/Screening"]]);
    // Deciding a category keeps it screened; Gmail keeps both labels on it.
    await act(stranger.id, { kind: "categorize", category: "invoice" });
    await w.idle();
    assert.deepEqual(labels("Pricing?"), [["UNREAD", "Usual Mail/Invoices", "Usual Mail/Screening"]]);
    const known = await deliver(inbox, DANA, "Status update");
    assert.deepEqual([known.category, known.categorizedBy, known.screened], ["unknown", undefined, false]);
    assert.deepEqual(labels("Status update"), [["INBOX", "UNREAD"]]);
  });

  test("an agent proposes in a suggest inbox and a person approves; once trusted it applies; actions are labels", async () => {
    const inbox = await connect("suggest");
    await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { agentAccess: true } });
    const agent = await w.agent([inbox.id]);
    const digest = await deliver(inbox, DANA, "Weekly digest");
    const proposal = await w.ok("POST", "/v1/triage/decisions", { token: agent, body: { decisions: [{ threadId: digest.id, category: "newsletter", reason: "A digest" }] } });
    assert.equal(proposal.records[0].state, "proposed");
    assert.deepEqual(labels("Weekly digest"), [["INBOX", "UNREAD"]]);
    await w.ok("POST", "/v1/actions/approve", { body: { actionIds: [proposal.records[0].id] } });
    await w.idle();
    assert.deepEqual(labels("Weekly digest"), [["UNREAD", "Usual Mail/Newsletters"]]);

    await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { trust: "act_with_undo" } });
    const photos = await deliver(inbox, DANA, "Photos");
    const step = async (action: Json, token?: string) => {
      await act(photos.id, action, token);
      await w.idle();
      return labels("Photos")[0];
    };
    assert.deepEqual(await step({ kind: "stack", stack: "reply_later" }, agent), ["UNREAD", "Usual Mail/Reply Later"]);
    assert.deepEqual(await step({ kind: "unstack" }), ["INBOX", "UNREAD"]);
    assert.deepEqual(await step({ kind: "read" }), ["INBOX"]);
    assert.deepEqual(await step({ kind: "done" }), []);
    assert.deepEqual(await step({ kind: "come_back", at: new Date(w.clock.now() + HOUR).toISOString() }), []);
    w.clock.advance(2 * HOUR);
    await w.idle();
    assert.deepEqual(labels("Photos")[0], ["INBOX"], "back in the inbox once the time passed");
    const trashed = await act(photos.id, { kind: "trash" });
    await w.idle();
    assert.deepEqual(labels("Photos")[0], ["TRASH"]);
    await w.ok("POST", `/v1/actions/${trashed.records[0].id}/undo`);
    await w.idle();
    assert.deepEqual(labels("Photos")[0], ["INBOX"]);
  });

  test("changes made at the mailbox arrive; a reply drafted by an agent and sent by a person joins its thread", async () => {
    const inbox = await connect();
    await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { agentAccess: true } });
    const thread = await deliver(inbox, DANA, "Lunch?");
    const message = [...fake.mailbox.messages.values()].find((m) => m.raw.toString("latin1").includes("Subject: Lunch?"))!;
    fake.mailbox.modify(message, [], ["INBOX", "UNREAD"]);
    await w.sync(inbox.id);
    const archived = (await w.ok("GET", `/v1/threads/${thread.id}`)).thread;
    assert.deepEqual([archived.done, archived.unread], [true, false]);
    fake.mailbox.modify(message, ["INBOX"], []);
    await w.sync(inbox.id);
    assert.equal((await w.ok("GET", "/v1/home")).items[0].id, thread.id);
    const back = (await w.ok("GET", `/v1/threads/${thread.id}`)).thread;
    assert.deepEqual([back.category, back.categorizedBy], ["conversation", "mailbox"], "moved into the inbox there: a conversation");
    // A filed category's label added there: that category, out of Home; the server archives it to match.
    const otp = fake.mailbox.createLabel("Usual Mail/One-Time Codes", {})!;
    fake.mailbox.modify(message, [otp.id], []);
    await w.sync(inbox.id);
    const filed = (await w.ok("GET", `/v1/threads/${thread.id}`)).thread;
    assert.deepEqual([filed.category, filed.categorizedBy, filed.done], ["otp", "mailbox", false]);
    assert.deepEqual(labels("Lunch?"), [["Usual Mail/One-Time Codes"]], "out of the inbox, under its label");
    fake.mailbox.modify(message, ["INBOX"], [otp.id]);
    await w.sync(inbox.id);
    assert.equal((await w.ok("GET", "/v1/home")).items[0].id, thread.id);

    const agent = await w.agent([inbox.id]);
    const [first] = (await w.ok("GET", `/v1/threads/${thread.id}`)).messages;
    const draft = await w.ok("POST", "/v1/drafts", { token: agent, body: { inboxId: inbox.id, threadId: thread.id, inReplyToMessageId: first.id, to: [{ email: "dana@lumen.example" }], subject: "Re: Lunch?", body: "Yes, at noon." } });
    const sent = await w.ok("POST", `/v1/drafts/${draft.id}/send`);
    assert.equal(sent.state, "sent");
    await w.idle();
    const detail = await w.ok("GET", `/v1/threads/${thread.id}`);
    assert.deepEqual(detail.messages.map((m: Json) => [m.subject, m.outgoing]), [["Lunch?", false], ["Re: Lunch?", true]]);
    assert.deepEqual(labels("Re: Lunch?"), [["SENT"]], "the server never files outgoing mail");
  });

  test("new credentials are checked first; removing the inbox leaves the mailbox as it was", async () => {
    const inbox = await connect();
    const wrong = await w.call("PATCH", `/v1/inboxes/${inbox.id}`, { body: { credentials: { ...fake.credentials, refreshToken: "nope" } } });
    assert.deepEqual([wrong.status, wrong.body.error.code], [502, "provider_error"]);
    fake.refreshToken = "rotated-token";
    const fixed = await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { credentials: { ...fake.credentials } } });
    assert.equal(fixed.status, "connecting");
    await w.idle();
    assert.equal((await w.ok("GET", "/v1/inboxes"))[0].status, "ok");

    const before = JSON.stringify([...fake.mailbox.messages.values()].map((m) => [m.id, [...m.labelIds].sort()]));
    assert.equal((await w.call("DELETE", `/v1/inboxes/${inbox.id}`)).status, 204);
    assert.deepEqual(await w.ok("GET", "/v1/inboxes"), []);
    assert.equal(JSON.stringify([...fake.mailbox.messages.values()].map((m) => [m.id, [...m.labelIds].sort()])), before);
  });
});

describe("Gmail end to end: mail a filter filed", () => {
  test("keeps the labels a Gmail filter gave it, without rules or screening; mail delivered to spam is ignored", async () => {
    const inbox = await connect();
    assert.deepEqual(inbox.connection, { kind: "gmail", clientId: fake.credentials.clientId }, "the client id, never the secret or token");
    await w.ok("POST", `/v1/inboxes/${inbox.id}/rules`, { body: { text: "Shop mail to Receipts", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }] } });
    const newsletters = fake.mailbox.createLabel("Usual Mail/Newsletters", {})!;
    const screening = fake.mailbox.createLabel("Usual Mail/Screening", {})!;
    // A filter that skips the inbox, one that skips it and labels Newsletters, and one that files under Screening.
    await fake.deliver(rawMail({ from: "Shop <billing@shop.example>", to: ADDRESS, subject: "Skipped the inbox", messageId: id("skipped") }), ["UNREAD"]);
    await fake.deliver(rawMail({ from: "Tomas <tomas@brightfield.example>", to: ADDRESS, subject: "Labelled Newsletters", messageId: id("news") }), ["UNREAD", newsletters.id]);
    await fake.deliver(rawMail({ from: "Quillpad <no-reply@quillpad.example>", to: ADDRESS, subject: "Labelled Screening", messageId: id("screen") }), ["UNREAD", screening.id]);
    await fake.deliver(rawMail({ from: "Prize <win@prize.example>", to: ADDRESS, subject: "You won", messageId: id("spam") }), ["UNREAD", "SPAM"]);
    await w.sync(inbox.id);
    const skipped = await w.thread("Skipped the inbox");
    assert.deepEqual([skipped.category, skipped.categorizedBy, skipped.done], ["unknown", undefined, true]);
    const labelled = await w.thread("Labelled Newsletters");
    assert.deepEqual([labelled.category, labelled.categorizedBy, labelled.screened, labelled.done], ["newsletter", "mailbox", false, false]);
    const screened = await w.thread("Labelled Screening");
    assert.deepEqual([screened.category, screened.screened, screened.done], ["unknown", true, false]);
    assert.equal((await w.call("GET", "/v1/search?q=You%20won")).body.items.length, 0);
    assert.deepEqual([labels("Skipped the inbox"), labels("Labelled Newsletters"), labels("Labelled Screening")],
      [[["UNREAD"]], [["UNREAD", "Usual Mail/Newsletters"]], [["UNREAD", "Usual Mail/Screening"]]], "nothing changed at Gmail");
  });

  test("mail delivered to spam and then marked \"not spam\" at Gmail arrives as new mail", async () => {
    const inbox = await connect();
    const spam = await fake.deliver(rawMail({ from: "Tomas <tomas@brightfield.example>", to: ADDRESS, subject: "Not spam after all", messageId: id("unspam") }), ["UNREAD", "SPAM"]);
    await w.sync(inbox.id);
    assert.equal((await w.call("GET", "/v1/search?q=Not%20spam")).body.items.length, 0, "ignored while in spam");
    fake.mailbox.modify(spam, ["INBOX"], ["SPAM"]);
    await w.sync(inbox.id);
    const thread = await w.thread("Not spam after all");
    assert.deepEqual([thread.category, thread.screened, thread.done, thread.trashed], ["unknown", true, false, false], "sorted as new mail in the inbox");
    assert.deepEqual(labels("Not spam after all"), [["UNREAD", "Usual Mail/Screening"]]);
  });
});
