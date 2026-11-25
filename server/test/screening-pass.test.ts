// Mail from a sender who isn't let in that skips Screening (docs/contract.md, "Rules and learning"; the owner's decision
// of 2026-11-25), through the whole server on fake models: the AI categorizes, then is asked once which kind it is only
// when the server's own check could let it through; the thread lands in its category's list, says why
// (`skippedScreening`), is written back to its category's label and never to Screening, and its sender still isn't
// let in. Look-alikes stay screened without the question; the AI off or failing leaves them screened as before.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ChoiceRequest } from "../src/ai/models.ts";
import { failure } from "../src/index.ts";
import type { DeliverInput } from "../src/testing/index.ts";
import { historyFromKnown, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

const proved = (domain: string) => ({ result: "verified", domain }) as const;

/** A stranger's sign-in link: proved, machine-sent, a link and sign-in words. */
const SIGN_IN = {
  from: { name: "Quillpad", email: "no-reply@quillpad.example" },
  subject: "Sign in to Quillpad",
  text: "Click to sign in: https://quillpad.example/magic/abc",
  automated: true,
  fromCheck: proved("quillpad.example"),
} satisfies DeliverInput;

/** A stranger's security alert. */
const ALERT = {
  from: { name: "Lumen Bank", email: "security@lumen-bank.example" },
  subject: "New sign-in to your account",
  text: "We noticed a new sign-in from a new device on 25 Nov. Was this you?",
  automated: true,
  fromCheck: proved("lumen-bank.example"),
} satisfies DeliverInput;

/** A stranger's shipping update. */
const SHIPPED = {
  from: { name: "Fernway", email: "orders@fernway.example" },
  subject: "Your order has shipped",
  text: "Order #112-3456789 is on its way. It costs €42.00.",
  automated: true,
  fromCheck: proved("fernway.example"),
  threadKey: "fernway-order",
} satisfies DeliverInput;

/** The screening gate's question (pass-prompt.ts), not a categorize request. */
const isQuestion = (request: ChoiceRequest) => request.options.some((option) => option.value === "none");
const questions = () => t.models.sent("choose").filter((sent) => isQuestion(sent.request as ChoiceRequest)).length;

/** The AI answers `category` to categorize and `kind` to the gate's question. */
function answer(category: string, kind: string | null = null): void {
  t.models.choose = (request) => (isQuestion(request) ? kind : category);
}

async function inboxWithAi(ai = true) {
  const { inbox, mailbox } = await t.connect({ address: "me@ai.example", history: [historyFromKnown] });
  if (ai) await t.aiOn();
  return { inbox, mailbox };
}

describe("a kind that skips Screening", () => {
  test("a sign-in link stays a one-time code's kind: out of Screening, never summarized, its sender not let in", async () => {
    const { inbox, mailbox } = await inboxWithAi();
    answer("otp", "sign_in");
    const thread = await t.receive(inbox, SIGN_IN);
    assert.deepEqual([thread.category, thread.screened, thread.skippedScreening, thread.summary], ["otp", false, "sign_in", undefined]);
    assert.deepEqual(t.models.requests.map((r) => r.kind), ["choose", "choose"], "categorized, asked once, no summary");
    assert.deepEqual((await t.server.category(t.person, "otp", {})).items.map((x) => x.id), [thread.id]);
    const placed = mailbox.messages().find((m) => m.subject === SIGN_IN.subject)!.placement;
    assert.deepEqual([placed.inInbox, placed.category, placed.screened], [false, "otp", false], "under One-Time Codes");
    assert.ok(!mailbox.applied.some((op) => op.op === "place" && op.screened), "never placed under Screening");
    const record = (await t.server.handled(t.person, { includeSilent: true })).items.find((item) => item.thread.id === thread.id)!.record;
    assert.deepEqual([record.actor.kind, record.silent, record.reason], ["ai", true, undefined], "one silent record, no reason");
    // Its sender still isn't let in: their newsletter is screened.
    answer("newsletter");
    const next = await t.receive(inbox, { from: SIGN_IN.from, subject: "Quillpad's November news", fromCheck: SIGN_IN.fromCheck, automated: true });
    assert.deepEqual([next.screened, next.skippedScreening], [true, undefined]);
  });

  test("a security alert lands in Notifications with its summary and event", async () => {
    const { inbox, mailbox } = await inboxWithAi();
    answer("notification", "security");
    const thread = await t.receive(inbox, ALERT);
    assert.deepEqual([thread.category, thread.screened, thread.skippedScreening], ["notification", false, "security"]);
    assert.ok(thread.summary, "summarized like any notification");
    assert.deepEqual(t.models.requests.map((r) => r.kind), ["choose", "choose", "extract"]);
    assert.deepEqual((await t.server.category(t.person, "notification", {})).items.map((x) => x.id), [thread.id]);
    assert.deepEqual((await t.server.screening(t.person, {})).items, []);
    const placed = mailbox.messages().find((m) => m.subject === ALERT.subject)!.placement;
    assert.deepEqual([placed.category, placed.screened], ["notification", false]);
  });

  test("an order update lands in Receipts", async () => {
    const { inbox } = await inboxWithAi();
    answer("receipt", "order");
    const thread = await t.receive(inbox, SHIPPED);
    assert.deepEqual([thread.category, thread.screened, thread.skippedScreening], ["receipt", false, "order"]);
  });

  test("a one-time code needs no question, and says so", async () => {
    const { inbox } = await inboxWithAi();
    answer("otp", "sign_in");
    const thread = await t.receive(inbox, { ...SIGN_IN, subject: "Your code", text: "Your verification code is 482913." });
    assert.deepEqual([thread.screened, thread.skippedScreening], [false, "code"]);
    assert.equal(questions(), 0);
  });
});

describe("look-alikes stay screened, in the category the AI gave", () => {
  test("a From domain the provider's checker didn't prove, a person's mail, a public mail domain: not even asked", async () => {
    const { inbox } = await inboxWithAi();
    answer("notification", "security");
    const cases: Array<[string, DeliverInput]> = [
      ["not proved", { ...ALERT, subject: "Alert one", fromCheck: { result: "unverified" } }],
      ["no checker's word", { ...ALERT, subject: "Alert two", fromCheck: undefined }],
      ["proved for another domain", { ...ALERT, subject: "Alert three", fromCheck: proved("mailer.example") }],
      ["written by a person", { ...ALERT, subject: "Alert four", automated: false }],
      ["a public mail domain", { ...ALERT, subject: "Alert five", from: { email: "security.team@yahoo.example" }, fromCheck: proved("yahoo.example") }],
    ];
    for (const [why, input] of cases) {
      const thread = await t.receive(inbox, input);
      assert.deepEqual([thread.category, thread.screened, thread.skippedScreening], ["notification", true, undefined], why);
    }
    assert.equal(questions(), 0, "nothing could pass, so nothing was asked");
  });

  test("a sign-in link without a link, or a model's none, or a kind its category can't be", async () => {
    const { inbox } = await inboxWithAi();
    answer("otp", "sign_in");
    const noLink = await t.receive(inbox, { ...SIGN_IN, subject: "Sign in", text: "Open the app to sign in." });
    assert.deepEqual([noLink.screened, noLink.skippedScreening], [true, undefined]);
    assert.equal(questions(), 0, "no kind's evidence: not asked");
    answer("otp", "none");
    const none = await t.receive(inbox, { ...SIGN_IN, subject: "Sign in again" });
    assert.deepEqual([none.category, none.screened], ["otp", true]);
    answer("otp", "security");
    const offered = await t.receive(inbox, { ...SIGN_IN, subject: "Sign in once more" });
    assert.deepEqual([offered.category, offered.screened], ["otp", true], "security isn't offered for a one-time code");
    assert.equal(questions(), 2);
  });

  test("a kind the server's own check refuses: a booking with no booking in it", async () => {
    const { inbox, mailbox } = await inboxWithAi();
    answer("notification", "booking");
    const thread = await t.receive(inbox, ALERT);
    assert.deepEqual([thread.category, thread.screened, thread.skippedScreening], ["notification", true, undefined]);
    assert.equal(mailbox.messages().find((m) => m.subject === ALERT.subject)!.placement.screened, true, "written under Screening");
  });

  test("an invoice never skips Screening, and isn't asked about", async () => {
    const { inbox } = await inboxWithAi();
    answer("invoice", "payment");
    const thread = await t.receive(inbox, { ...ALERT, subject: "Payment due", text: "Your card ending in 4242 will be charged €120.00." });
    assert.deepEqual([thread.category, thread.screened], ["invoice", true]);
    assert.equal(questions(), 0);
  });
});

describe("the gate's order with the AI off or failing", () => {
  test("with no AI key, a sign-in link is screened in unknown and nothing leaves the server", async () => {
    const { inbox } = await inboxWithAi(false);
    const thread = await t.receive(inbox, SIGN_IN);
    assert.deepEqual([thread.category, thread.screened, thread.skippedScreening], ["unknown", true, undefined]);
    assert.equal(t.models.requests.length, 0);
  });

  test("the question failing leaves it screened in its category, written back under Screening", async () => {
    const { inbox, mailbox } = await inboxWithAi();
    t.models.choose = (request) => {
      if (isQuestion(request)) throw failure("unavailable");
      return "notification";
    };
    const counted = async () => (await t.server.aiUsage(t.person, {})).periods.today.find((row) => row.job === "categorize");
    const before = await counted();
    const thread = await t.receive(inbox, ALERT);
    assert.deepEqual([thread.category, thread.screened, thread.skippedScreening], ["notification", true, undefined]);
    assert.equal(mailbox.messages().find((m) => m.subject === ALERT.subject)!.placement.screened, true);
    assert.equal((await t.server.aiStatus(t.person)).state, "unavailable");
    const after = (await counted())!;
    assert.deepEqual([after.requests - (before?.requests ?? 0), after.failed - (before?.failed ?? 0)], [2, 1], "both requests counted, the question as failed");
  });

  test("while the question's answer is awaited, the thread is screened but not written back", async () => {
    const { inbox, mailbox } = await inboxWithAi();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    t.models.choose = async (request) => {
      if (!isQuestion(request)) return "notification";
      await waiting;
      return "security";
    };
    mailbox.deliver(ALERT);
    await t.server.syncInbox(t.person, inbox.id);
    for (let i = 0; i < 50 && questions() === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(questions(), 1);
    const held = await t.threadBySubject(ALERT.subject);
    assert.deepEqual([held.category, held.screened], ["unknown", true], "the category waits for the question too");
    assert.ok(!mailbox.applied.some((op) => op.op === "place"), "nothing written while it waits");
    release();
    await t.server.whenIdle();
    const after = await t.threadBySubject(ALERT.subject);
    assert.deepEqual([after.category, after.screened, after.skippedScreening], ["notification", false, "security"]);
    assert.ok(!mailbox.applied.some((op) => op.op === "place" && op.screened), "never placed under Screening");
  });
});

describe("after it skipped Screening", () => {
  test("undoing the AI's decision puts it back in Screening, without the kind", async () => {
    const { inbox, mailbox } = await inboxWithAi();
    answer("notification", "security");
    const thread = await t.receive(inbox, ALERT);
    const record = (await t.server.handled(t.person, { includeSilent: true })).items.find((item) => item.thread.id === thread.id)!.record;
    const undone = await t.server.undo(t.person, record.id);
    assert.deepEqual([undone.threads[0]!.category, undone.threads[0]!.screened, undone.threads[0]!.skippedScreening], ["unknown", true, undefined]);
    await t.server.whenIdle();
    assert.equal(mailbox.messages().find((m) => m.subject === ALERT.subject)!.placement.screened, true, "written back under Screening");
  });

  test("its sender writing into it again lets nobody in, and the AI isn't asked to move it to Home", async () => {
    const { inbox } = await inboxWithAi();
    answer("receipt", "order");
    const thread = await t.receive(inbox, SHIPPED);
    assert.equal(thread.skippedScreening, "order");
    const asked = t.models.sent("choose").length;
    answer("conversation");
    const joined = await t.receive(inbox, { ...SHIPPED, subject: "Your order has shipped", text: "Hi, a person here: can you call us back?" });
    assert.equal(joined.id, thread.id, "the same thread");
    assert.deepEqual([joined.category, joined.screened, joined.skippedScreening], ["receipt", false, "order"]);
    assert.equal(t.models.sent("choose").length, asked, "no categorize request for mail joining it");
    // Still not let in: the shop's sale is screened.
    answer("newsletter");
    const sale = await t.receive(inbox, { from: SHIPPED.from, subject: "Winter sale", automated: true, fromCheck: SHIPPED.fromCheck });
    assert.equal(sale.screened, true);
  });

  test("letting the sender in afterwards changes nothing about it but who may write", async () => {
    const { inbox } = await inboxWithAi();
    answer("notification", "security");
    const thread = await t.receive(inbox, ALERT);
    await t.server.allowSender(t.person, { inboxId: inbox.id, address: ALERT.from.email });
    answer("newsletter");
    const next = await t.receive(inbox, { ...ALERT, subject: "Lumen's news" });
    assert.equal(next.screened, false, "let in now");
    assert.equal((await t.server.thread(t.person, thread.id)).thread.screened, false);
  });
});
