// Asking the AI again, once, about threads it filed itself under words that have since changed (src/ai/ask-again.ts;
// the decisions of 2026-11-19, after two audits of the AI's labels). With the fake models, so these pin which threads
// are asked and that each answer takes the normal path, never how well a model answers.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Inbox, Thread } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { ASK_AGAIN, type AskAgain } from "../src/ai/ask-again.ts";
import { serverState, threads } from "../src/db/index.ts";
import { dataItems, failure, MailServer, type ChoiceRequest } from "../src/index.ts";
import { HOUR, historyFromKnown, KNOWN, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
let server: MailServer;
beforeEach(async () => {
  t = await makeServer();
  server = t.server;
});
afterEach(async () => {
  if (server !== t.server) await server.stop();
  await t.close();
});

const STRANGER = { name: "Sam Stranger", email: "sam@unknown.example" };
const subjectOf = (request: ChoiceRequest) => String(dataItems(request.data)[0]?.subject);
const asked = () => t.models.sent("choose").map((sent) => subjectOf(sent.request as ChoiceRequest)).sort();

/** The fake answers by subject; anything it isn't told is a receipt. */
function answer(by: Record<string, string>): void {
  t.models.choose = (request) => by[subjectOf(request)] ?? "receipt";
}

async function connected(): Promise<Inbox> {
  const { inbox } = await t.connect({ address: "me@again.example", history: [historyFromKnown] });
  await t.aiOn();
  return inbox;
}

async function thread(subject: string): Promise<Thread> {
  const page = await server.search(t.person, { q: subject, limit: 50 });
  return page.items.find((item) => item.subject === subject)!;
}

/**
 * Stops the server and starts it again, as a start of a build with this asking-again would. `fresh` forgets the one
 * the store had, as the migration leaves an existing store. Nothing is asked before `start`.
 */
async function restart(options: { askAgain?: AskAgain; fresh?: boolean; paused?: boolean } = {}): Promise<void> {
  await server.stop();
  if (options.fresh) await t.host.db.update(serverState).set({ categoriesAskedAgain: null });
  if (options.paused !== undefined) await t.host.db.update(serverState).set({ aiPaused: options.paused });
  t.models.requests.length = 0;
  server = await MailServer.create(t.host, { providers: t.providers, models: t.models, ...(options.askAgain && { askAgain: options.askAgain }) });
  await server.start();
  await server.whenIdle();
}

const STUB = { text: "View this email online: https://news.example/v/8c1f9e", html: `<h1>This week</h1><p>${"Three things worth reading this week. ".repeat(20)}</p>` };
/** The first asking-again of 2026-11-19, as a made-up plan: its build has been replaced. */
const FIRST_ROUND: AskAgain = { id: "made-up: the first round", categories: ["receipt", "invoice", "notification"], ifStubText: ["newsletter"], ifNeverWrittenIn: [] };

describe("asking the AI again", () => {
  test("this build's: the AI's receipts and notifications, and its conversations nobody in the mailbox wrote in", () => {
    assert.deepEqual([ASK_AGAIN.categories, ASK_AGAIN.ifStubText, ASK_AGAIN.ifNeverWrittenIn], [["receipt", "notification"], [], ["conversation"]]);
    assert.notEqual(ASK_AGAIN.id, "2026-11-19 sorting words", "a new id: the first round stays done");
  });

  test("each is asked once with the new words, and any answer is applied the normal way: recorded, written back, undoable", async () => {
    const inbox = await connected();
    const mailbox = t.mailboxes.get(inbox.address)!;
    answer({ "Sign-in alert": "notification", "Card bill": "invoice", "Stub news": "newsletter", "Full news": "newsletter", "Lunch?": "conversation", "Corrected": "notification" });
    for (const subject of ["Your parcel has shipped", "Payment received", "Account updated", "Sign-in alert", "Card bill", "Stub news", "Full news", "Lunch?", "Corrected", "Old order", "Thrown away", "Ruled"]) {
      if (subject === "Ruled") {
        await server.createRule(t.person, { inboxId: inbox.id, text: "Ruled mail is a receipt", match: { subjectContains: "Ruled" }, then: [{ kind: "categorize", category: "receipt" }] });
      }
      await t.receive(inbox, { from: KNOWN, subject, ...(subject === "Stub news" ? STUB : { text: "Made-up mail.", html: "<p>Made-up mail.</p>" }) });
    }
    await server.act(t.person, { threadIds: [(await thread("Corrected")).id], action: { kind: "categorize", category: "receipt" } });
    await server.act(t.person, { threadIds: [(await thread("Old order")).id], action: { kind: "done" } });
    await server.act(t.person, { threadIds: [(await thread("Thrown away")).id], action: { kind: "trash" } });
    mailbox.deliver({ from: KNOWN, subject: "Filed by me", placement: { inInbox: false, category: "receipt" } });
    await t.sync(inbox);
    assert.deepEqual([(await thread("Ruled")).categorizedBy, (await thread("Filed by me")).categorizedBy, (await thread("Corrected")).categorizedBy], ["rule", "mailbox", "person"]);
    const recordsBefore = (await server.handled(t.person, { includeSilent: true })).items.length;

    answer({ "Your parcel has shipped": "notification", "Payment received": "receipt", "Account updated": "conversation", "Sign-in alert": "notification", "Card bill": "invoice", "Stub news": "newsletter" });
    await restart({ askAgain: FIRST_ROUND });
    assert.deepEqual(asked(), ["Account updated", "Card bill", "Payment received", "Sign-in alert", "Stub news", "Your parcel has shipped"],
      "the AI's own receipts, invoices and notifications that aren't done or trashed, and the newsletter it read a stub of");
    assert.deepEqual(t.models.sent("write").map((sent) => subjectOf(sent.request as ChoiceRequest)), ["Account updated"],
      "a summary in place of the details for the one that left receipts for a conversation");
    assert.deepEqual(t.models.sent("extract").map((sent) => subjectOf(sent.request as ChoiceRequest)), ["Your parcel has shipped"],
      "a summary and an event for the one that became a notification; the receipts and the invoice kept their details");
    const stubRead = t.models.sent("choose").find((sent) => subjectOf(sent.request as ChoiceRequest) === "Stub news")!.request;
    assert.ok(String(dataItems(stubRead.data)[0]!.text).startsWith("This week"), "and this time it reads the HTML's text");
    const shipped = await thread("Your parcel has shipped");
    assert.deepEqual([shipped.category, shipped.categorizedBy, shipped.categorizedByActor], ["notification", "ai", { kind: "ai", job: "categorize", model: "fake/categorize" }]);
    const message = (subject: string) => mailbox.messages().find((m) => m.subject === subject)!;
    assert.equal(message("Your parcel has shipped").placement.category, "notification", "written back under its new label");
    assert.equal((await thread("Payment received")).category, "receipt", "the same answer leaves it");
    const moved = await thread("Account updated");
    assert.deepEqual([moved.category, moved.categorizedBy], ["conversation", "ai"]);
    assert.deepEqual([message("Account updated").placement.category, message("Account updated").placement.inInbox], [null, true], "a conversation has no label, and is back in the inbox as in Home");
    for (const [subject, category] of [["Sign-in alert", "notification"], ["Card bill", "invoice"], ["Stub news", "newsletter"], ["Full news", "newsletter"], ["Lunch?", "conversation"], ["Corrected", "receipt"], ["Old order", "receipt"], ["Ruled", "receipt"], ["Filed by me", "receipt"]] as const) {
      assert.equal((await thread(subject)).category, category, `${subject} is as it was`);
    }
    assert.equal(message("Thrown away").placement.trashed, true, "a trashed one stays in the trash");

    const records = (await server.handled(t.person, { includeSilent: true })).items;
    assert.equal(records.length, recordsBefore + 2, "a record for each thread that moved, none for those that stayed");
    const record = records.find((item) => item.record.threadId === shipped.id && item.record.state === "applied" && item.record.undoable)!.record;
    assert.deepEqual([record.action, record.actor, record.silent], [{ kind: "categorize", category: "notification" }, { kind: "ai", job: "categorize", model: "fake/categorize" }, true]);
    const undone = await server.undo(t.person, record.id);
    assert.deepEqual([undone.threads[0]!.category, undone.threads[0]!.categorizedBy], ["receipt", "person"], "undoing it puts it back, and the person decided it");
    await server.whenIdle();
    assert.equal(message("Your parcel has shipped").placement.category, "receipt");

    await restart({ askAgain: FIRST_ROUND });
    assert.deepEqual(asked(), [], "once: a later start asks nothing");
    assert.equal((await server.aiStatus(t.person)).pending, 0);
  });

  test("a conversation nobody in the mailbox wrote in may leave conversation, once; one the person wrote in is never asked", async () => {
    const inbox = await connected();
    const mailbox = t.mailboxes.get(inbox.address)!;
    const firstSort = { "Community event": "conversation", "Lunch?": "conversation", "Forged reply": "conversation", "Done chat": "conversation", "Card bill": "invoice", "Weekly news": "newsletter", "Cart reminder": "notification" };
    answer(firstSort);
    for (const subject of Object.keys(firstSort)) {
      await t.receive(inbox, { from: KNOWN, subject, messageId: `${subject.replace(/\W/g, "").toLowerCase()}@lumen.example` });
    }
    // The person replied in one: the provider says the mailbox sent it.
    mailbox.deliver({ from: { email: inbox.address }, to: [KNOWN], subject: "Re: Lunch?", inReplyTo: "lunch@lumen.example", outgoing: true });
    // In another, only a forged "From: me" with no evidence the mailbox sent it: nobody in the mailbox wrote there.
    mailbox.deliver({ from: { email: inbox.address }, to: [KNOWN], subject: "Re: Forged reply", inReplyTo: "forgedreply@lumen.example" });
    await t.sync(inbox);
    await server.act(t.person, { threadIds: [(await thread("Done chat")).id], action: { kind: "done" } });
    const message = (subject: string) => mailbox.messages().find((m) => m.subject === subject)!;
    assert.deepEqual([message("Community event").placement.inInbox, message("Community event").placement.category], [true, null]);

    answer({ "Community event": "newsletter", "Forged reply": "conversation", "Cart reminder": "newsletter", "Lunch?": "newsletter" });
    await restart({ fresh: true });
    assert.deepEqual(asked(), ["Cart reminder", "Community event", "Forged reply"], "not one the person wrote in, a done one, an invoice or a newsletter");
    const event = await thread("Community event");
    assert.deepEqual([event.category, event.categorizedBy], ["newsletter", "ai"]);
    assert.deepEqual([message("Community event").placement.inInbox, message("Community event").placement.category], [false, "newsletter"], "out of the inbox, under its label");
    assert.equal((await thread("Forged reply")).category, "conversation", "the same answer leaves it");
    assert.equal((await thread("Lunch?")).category, "conversation");
    assert.equal((await thread("Cart reminder")).category, "newsletter");

    const record = (await server.handled(t.person, { includeSilent: true })).items.find((item) => item.record.threadId === event.id && item.record.undoable)!.record;
    const undone = await server.undo(t.person, record.id);
    assert.deepEqual([undone.threads[0]!.category, undone.threads[0]!.categorizedBy], ["conversation", "person"]);
    await server.whenIdle();
    assert.deepEqual([message("Community event").placement.inInbox, message("Community event").placement.category], [true, null], "back in the inbox");

    t.models.requests.length = 0;
    answer({ "Forged reply": "newsletter" });
    mailbox.deliver({ from: KNOWN, subject: "Re: Forged reply", inReplyTo: "forgedreply@lumen.example" });
    await server.syncInbox(t.person, inbox.id);
    await server.whenIdle();
    assert.deepEqual(asked(), [], "afterwards the AI never categorizes a conversation again");
    const joined = await thread("Re: Forged reply");
    assert.deepEqual([joined.category, joined.categorizedBy, joined.messageCount], ["conversation", "ai", 3]);
  });

  test("the scope is one list: naming conversation in it asks the AI's conversations too, and the AI may then move them", async () => {
    const inbox = await connected();
    answer({ "Chat": "conversation", "News": "newsletter" });
    for (const subject of ["A receipt", "Chat", "News"]) await t.receive(inbox, { from: KNOWN, subject });

    answer({ "Chat": "newsletter" });
    await restart({ askAgain: { id: "made-up: conversations", categories: ["conversation"], ifStubText: [], ifNeverWrittenIn: [] } });
    assert.deepEqual(asked(), ["Chat"]);
    const chat = await thread("Chat");
    assert.deepEqual([chat.category, chat.categorizedBy], ["newsletter", "ai"]);
    assert.equal(t.mailboxes.get(inbox.address)!.messages().find((m) => m.subject === "Chat")!.placement.category, "newsletter");

    await restart({ askAgain: { id: "made-up: conversations", categories: ["receipt", "newsletter"], ifStubText: [], ifNeverWrittenIn: [] } });
    assert.deepEqual(asked(), [], "the same asking-again happens once, whatever it names");
    await restart({ askAgain: { id: "made-up: newsletters with a stub", categories: [], ifStubText: ["newsletter"], ifNeverWrittenIn: [] } });
    assert.deepEqual(asked(), [], "none of them was read from a stub");
  });

  test("a decision someone makes before the AI gets to it stands; once asked, mail joining moves it only to conversation", async () => {
    const inbox = await connected();
    for (const subject of ["First receipt", "Second receipt"]) await t.receive(inbox, { from: KNOWN, subject, messageId: `${subject.split(" ")[0]!.toLowerCase()}@lumen.example` });

    await restart({ fresh: true, paused: true });
    assert.deepEqual(asked(), [], "paused: nothing is sent");
    assert.equal((await server.aiStatus(t.person)).pending, 2, "both wait");
    await server.act(t.person, { threadIds: [(await thread("First receipt")).id], action: { kind: "categorize", category: "invoice" } });
    answer({ "First receipt": "notification", "Second receipt": "notification" });
    await server.updateAiSettings(t.person, { paused: false });
    await server.whenIdle();
    assert.deepEqual(asked(), ["Second receipt"], "the person's decision isn't asked about");
    assert.deepEqual([(await thread("First receipt")).category, (await thread("Second receipt")).category], ["invoice", "notification"]);

    t.models.requests.length = 0;
    answer({ "Second receipt": "receipt" });
    t.mailboxes.get(inbox.address)!.deliver({ from: KNOWN, subject: "Second receipt", inReplyTo: "second@lumen.example" });
    await server.syncInbox(t.person, inbox.id);
    await server.whenIdle();
    assert.deepEqual(asked(), ["Second receipt"], "mail joining asks as before");
    assert.equal((await thread("Second receipt")).category, "notification", "and only conversation would move it now");
  });

  test("a model's otp alone still doesn't lift the screening gate", async () => {
    const inbox = await connected();
    const screened = await t.receive(inbox, { from: STRANGER, subject: "Your order", text: "Thanks for shopping." });
    assert.deepEqual([screened.category, screened.screened], ["receipt", true]);
    answer({ "Your order": "otp" });
    await restart({ fresh: true });
    assert.deepEqual(asked(), ["Your order"]);
    const after = await thread("Your order");
    assert.deepEqual([after.category, after.screened], ["otp", true], "no code in it: it stays screened");
  });

  test("a failed request leaves it marked, and it is asked once the service answers again", async () => {
    const inbox = await connected();
    answer({});
    await t.receive(inbox, { from: KNOWN, subject: "Delivery update" });
    t.models.failAll = failure("unavailable", "Down for now.");
    await restart({ fresh: true });
    assert.equal((await server.aiStatus(t.person)).state, "unavailable");
    t.models.failAll = null;
    t.models.requests.length = 0;
    answer({ "Delivery update": "notification" });
    t.clock.advance(HOUR);
    await server.whenIdle();
    assert.deepEqual(asked(), ["Delivery update"]);
    assert.equal((await thread("Delivery update")).category, "notification");
    const row = await t.host.db.select().from(threads).where(eq(threads.subject, "Delivery update")).get();
    assert.deepEqual([row!.categoryAskAgain, row!.categoryDue], [false, false], "asked once: nothing left marked");
  });
});
