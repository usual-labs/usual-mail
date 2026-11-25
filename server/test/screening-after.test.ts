// After a thread skipped Screening (docs/contract.md, "Rules and learning"; the security review of 2026-11-25), on fake
// models and a Gmail mailbox: undoing the AI's decision screens it again; mail from someone not let in that joins it
// screens it again and the gate judges the newest message (a qualifying update passes again, anything else waits in
// Screening, a third party threaded in included); mail that joins while the gate's question is out isn't judged by
// the answer about the earlier message; the AI never makes such a thread a conversation; and nobody is let in by it.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import { threads } from "../src/db/index.ts";
import type { ChoiceRequest } from "../src/ai/models.ts";
import { toThread } from "../src/service/rows.ts";
import { stateColumns, type ThreadState } from "../src/service/state.ts";
import type { DeliverInput, MemoryMailbox } from "../src/testing/index.ts";
import { historyFromKnown, KNOWN, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

const proved = (domain: string) => ({ result: "verified", domain }) as const;

/** A stranger's shipping update. */
const SHIPPED = {
  from: { name: "Fernway", email: "orders@fernway.example" },
  subject: "Your order has shipped",
  text: "Order #112-3456789 is on its way. It costs €42.00.",
  automated: true,
  fromCheck: proved("fernway.example"),
  signedRecipients: ["to"],
  threadKey: "fernway-order",
} satisfies DeliverInput;

const isQuestion = (request: ChoiceRequest) => request.options.some((option) => option.value === "none");
const questions = () => t.models.sent("choose").filter((sent) => isQuestion(sent.request as ChoiceRequest)).length;

function answer(category: string, kind: string | null = null): void {
  t.models.choose = (request) => (isQuestion(request) ? kind : category);
}

async function inboxWithAi() {
  const { inbox, mailbox } = await t.connect({ address: "me@ai.example", history: [historyFromKnown], mailbox: { kind: "gmail" } });
  await t.aiOn();
  return { inbox, mailbox };
}

/** Every place the provider was told for the messages of this subject, in order: screened or not. */
const placedScreened = (mailbox: MemoryMailbox, from: number) =>
  mailbox.applied.slice(from).filter((op) => op.op === "place").map((op) => (op.op === "place" ? Boolean(op.screened) : null));

async function skippedOrder() {
  const { inbox, mailbox } = await inboxWithAi();
  answer("receipt", "order");
  const thread = await t.receive(inbox, SHIPPED);
  assert.deepEqual([thread.screened, thread.skippedScreening], [false, "order"]);
  return { inbox, mailbox, thread };
}

describe("undoing and letting in", () => {
  test("undoing the AI's decision puts it back in Screening, without the kind", async () => {
    const { mailbox, thread } = await skippedOrder();
    const record = (await t.server.handled(t.person, { includeSilent: true })).items.find((item) => item.thread.id === thread.id)!.record;
    const undone = await t.server.undo(t.person, record.id);
    assert.deepEqual([undone.threads[0]!.category, undone.threads[0]!.screened, undone.threads[0]!.skippedScreening], ["unknown", true, undefined]);
    await t.server.whenIdle();
    assert.equal(mailbox.messages().find((m) => m.subject === SHIPPED.subject)!.placement.screened, true, "written back under Screening");
  });

  test("letting the sender in afterwards: their next mail isn't screened", async () => {
    const { inbox } = await skippedOrder();
    await t.server.allowSender(t.person, { inboxId: inbox.id, address: SHIPPED.from.email });
    answer("newsletter");
    const next = await t.receive(inbox, { ...SHIPPED, subject: "Fernway's news", threadKey: "news" });
    assert.equal(next.screened, false);
  });
});

describe("mail joining a thread that skipped Screening", () => {
  test("its sender's next qualifying update is judged again and skips Screening again, never written under it", async () => {
    const { inbox, mailbox, thread } = await skippedOrder();
    const before = mailbox.applied.length;
    const asked = questions();
    answer("receipt", "order");
    const joined = await t.receive(inbox, { ...SHIPPED, text: "Order #112-3456789 is out for delivery today." });
    assert.equal(joined.id, thread.id, "the same thread");
    assert.deepEqual([joined.category, joined.screened, joined.skippedScreening], ["receipt", false, "order"]);
    assert.equal(questions(), asked + 1, "the newest message judged");
    assert.ok(!placedScreened(mailbox, before).includes(true), "held while judged: never under Screening");
  });

  test("its sender writing like a person screens it again, and lets nobody in", async () => {
    const { inbox, mailbox, thread } = await skippedOrder();
    answer("conversation");
    const joined = await t.receive(inbox, { ...SHIPPED, automated: false, text: "Hi, a person here: can you call us back?" });
    assert.equal(joined.id, thread.id);
    assert.deepEqual([joined.screened, joined.skippedScreening], [true, undefined]);
    assert.equal(mailbox.messages().find((m) => m.text?.startsWith("Hi, a person"))!.placement.screened, true, "written under Screening");
    answer("newsletter");
    const sale = await t.receive(inbox, { from: SHIPPED.from, subject: "Winter sale", automated: true, fromCheck: SHIPPED.fromCheck });
    assert.equal(sale.screened, true, "still not let in");
  });

  test("a third party threaded in, unproved and written by a person, doesn't ride the pass", async () => {
    const { inbox, mailbox, thread } = await skippedOrder();
    answer("receipt", "order");
    const joined = await t.receive(inbox, {
      from: { name: "Fernway Support", email: "help@fernway-support.example" }, subject: SHIPPED.subject, threadKey: SHIPPED.threadKey,
      text: "Order #112-3456789 is held. Call +1 555 0100 to release it.",
    });
    assert.equal(joined.id, thread.id);
    assert.deepEqual([joined.screened, joined.skippedScreening], [true, undefined], "out of Receipts, into Screening");
    assert.deepEqual((await t.server.category(t.person, "receipt", {})).items, []);
    assert.equal(mailbox.messages().find((m) => m.from.email === "help@fernway-support.example")!.placement.screened, true, "written under Screening");
    answer("conversation");
    const next = await t.receive(inbox, { from: { email: "help@fernway-support.example" }, subject: "About your order", text: "Please call us." });
    assert.equal(next.screened, true, "the third party isn't let in by writing into it");
  });

  test("someone let in writing into it changes nothing about it, and lets nobody else in", async () => {
    const { inbox, thread } = await skippedOrder();
    const asked = t.models.sent("choose").length;
    const joined = await t.receive(inbox, { from: KNOWN, subject: SHIPPED.subject, threadKey: SHIPPED.threadKey, text: "Did yours arrive too?" });
    assert.equal(joined.id, thread.id);
    assert.deepEqual([joined.category, joined.screened, joined.skippedScreening], ["receipt", false, "order"]);
    assert.equal(t.models.sent("choose").length, asked, "not asked again");
  });

  test("mail joining while the gate's question is out isn't judged by the answer about the earlier message", async () => {
    const { inbox, mailbox } = await inboxWithAi();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    t.models.choose = async (request) => {
      if (!isQuestion(request)) return "receipt";
      await waiting;
      return "order";
    };
    mailbox.deliver(SHIPPED);
    await t.server.syncInbox(t.person, inbox.id);
    for (let i = 0; i < 50 && questions() === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(questions(), 1);
    // A second, unproved message written by a person joins the thread meanwhile.
    mailbox.deliver({ from: { email: "pat@elsewhere.example" }, subject: SHIPPED.subject, threadKey: SHIPPED.threadKey, text: "Call me about this order." });
    await t.server.syncInbox(t.person, inbox.id);
    t.models.choose = (request) => (isQuestion(request) ? "order" : "conversation");
    release();
    await t.server.whenIdle();
    const after = await t.threadBySubject(SHIPPED.subject);
    assert.deepEqual([after.screened, after.skippedScreening], [true, undefined], "still screened, no kind");
    assert.notEqual(after.category === "conversation" && !after.screened, true, "never a conversation out of Screening");
  });

  test("a joined message that would pass on its own isn't let through by the answer about the earlier one", async () => {
    const { inbox, mailbox } = await inboxWithAi();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    t.models.choose = async (request) => {
      if (!isQuestion(request)) return "receipt";
      await waiting;
      return "order";
    };
    mailbox.deliver(SHIPPED);
    await t.server.syncInbox(t.person, inbox.id);
    for (let i = 0; i < 50 && questions() === 0; i++) await new Promise((r) => setTimeout(r, 5));
    // The shop's next update, which would pass the check itself, joins while the question about the first is out.
    mailbox.deliver({ ...SHIPPED, text: "Order #112-3456789 is out for delivery today." });
    await t.server.syncInbox(t.person, inbox.id);
    t.models.choose = (request) => (isQuestion(request) ? "order" : "receipt");
    release();
    await t.server.whenIdle();
    const after = await t.threadBySubject(SHIPPED.subject);
    assert.deepEqual([after.screened, after.skippedScreening], [true, undefined], "never asked about the newest message: still screened");
  });

  test("asked again, it keeps to its kind's categories: never an invoice", async () => {
    const { thread } = await skippedOrder();
    await t.host.db.update(threads).set({ categoryDue: true, categoryAskAgain: true }).where(eq(threads.id, thread.id));
    answer("invoice");
    const asked = t.models.sent("choose").length;
    await t.server.updateAiSettings(t.person, { paused: true });
    await t.server.updateAiSettings(t.person, { paused: false });
    await t.server.whenIdle();
    assert.equal(t.models.sent("choose").length, asked + 1, "asked again, any category allowed");
    const after = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([after.category, after.screened, after.skippedScreening], ["receipt", false, "order"]);
  });

  test("the AI never makes a thread that skipped Screening a conversation", async () => {
    const { thread } = await skippedOrder();
    // As if asked again about it (a stale due flag, or an asking-again): the AI may only move it to `conversation`.
    await t.host.db.update(threads).set({ categoryDue: true }).where(eq(threads.id, thread.id));
    answer("conversation");
    const asked = t.models.sent("choose").length;
    // Pausing and resuming wakes the AI's queue, which then finds the thread as history.
    await t.server.updateAiSettings(t.person, { paused: true });
    await t.server.updateAiSettings(t.person, { paused: false });
    await t.server.whenIdle();
    assert.equal(t.models.sent("choose").length, asked + 1, "asked, and answered conversation");
    const after = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([after.category, after.screened, after.skippedScreening], ["receipt", false, "order"]);
  });
});

describe("a screened thread carries no kind, whatever its row holds (backups behind the screened part's undo)", () => {
  test("stored: a screened state writes no kind", () => {
    const state = { ...emptyState(), screened: true, skippedScreening: "order" as const };
    assert.equal(stateColumns(state).skippedScreening, null);
    assert.equal(stateColumns({ ...state, screened: false }).skippedScreening, "order");
  });

  test("served: a screened row shows no kind", async () => {
    const { thread } = await skippedOrder();
    const row = (await t.host.db.select().from(threads).where(eq(threads.id, thread.id)).get())!;
    assert.equal(toThread({ ...row, screened: true }).skippedScreening, undefined);
    assert.equal(toThread(row).skippedScreening, "order");
  });
});

/** A thread's state with nothing set. */
function emptyState(): ThreadState {
  return {
    category: "receipt", categorizedBy: "ai", screened: false, screenedByMailbox: false, summary: null, done: false, stack: null,
    comeBackAt: null, comeBackIfNoReply: false, comeBackSetAt: null, unread: false, unreadMessageIds: [], readMessageIds: [],
    trashed: false, need: null, reason: null,
  };
}
