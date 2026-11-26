// Mail from a sender who isn't let in that skips Screening (docs/contract.md, "Rules and learning"; the owner's decision
// of 2026-11-25), through the whole server on fake models and a Gmail mailbox: the AI categorizes, then is asked once
// which kind it is only when the server's own check could let it through; the thread lands in its category's list,
// says why (`skippedScreening`), is written back to its category's label and never to Screening, and its sender still
// isn't let in. Look-alikes stay screened without the question; the AI off or failing leaves them screened as before,
// and so does mail the gate didn't hold for an answer. What happens after a thread skipped it: screening-after.test.ts.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ChoiceRequest } from "../src/ai/models.ts";
import { failure } from "../src/index.ts";
import type { DeliverInput } from "../src/testing/index.ts";
import { at, HOUR, historyFromKnown, makeServer, type TestServer } from "./helpers.ts";

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
  signedRecipients: ["to"],
} satisfies DeliverInput;

/** A stranger's security alert. */
const ALERT = {
  from: { name: "Lumen Bank", email: "security@lumen-bank.example" },
  subject: "New sign-in to your account",
  text: "We noticed a new sign-in from a new device on 25 Nov. Was this you?",
  automated: true,
  fromCheck: proved("lumen-bank.example"),
  signedRecipients: ["to"],
} satisfies DeliverInput;

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

/** The screening gate's question (pass-prompt.ts), not a categorize request. */
const isQuestion = (request: ChoiceRequest) => request.options.some((option) => option.value === "none");
const questions = () => t.models.sent("choose").filter((sent) => isQuestion(sent.request as ChoiceRequest)).length;

/** The AI answers `category` to categorize and `kind` to the gate's question. */
function answer(category: string, kind: string | null = null): void {
  t.models.choose = (request) => (isQuestion(request) ? kind : category);
}

async function inboxWithAi(ai = true) {
  const { inbox, mailbox } = await t.connect({ address: "me@ai.example", history: [historyFromKnown], mailbox: { kind: "gmail" } });
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

describe("one-time codes on each provider", () => {
  const CODE = { ...SIGN_IN, subject: "Your code", text: "Your verification code is 482913." } satisfies DeliverInput;

  test("the check must hold with the thread's subject, which the model read, and with the newest message's own", async () => {
    const { inbox, mailbox } = await inboxWithAi();
    answer("otp");
    mailbox.deliver({ ...SIGN_IN, subject: "Your sign-in code", text: "Hello.", threadKey: "code", date: at(-2 * HOUR) });
    mailbox.deliver({ ...SIGN_IN, subject: "Hello again", text: "482913", threadKey: "code", date: at(-HOUR) });
    await t.server.syncInbox(t.person, inbox.id);
    await t.server.whenIdle();
    const thread = await t.threadBySubject("Your sign-in code");
    assert.deepEqual([thread.screened, thread.skippedScreening], [true, undefined], "the newest message's own subject names no code");
  });

  test("a stranger's earlier message gives the thread its subject: a proved sender's mail joining it doesn't skip", async () => {
    // The narrow check of 2026-11-26: the thread's subject is the first message's, here an unproved stranger's.
    const { inbox, mailbox } = await inboxWithAi();
    answer("notification", "security");
    mailbox.deliver({ from: { email: "x@elsewhere.example" }, subject: "Security alert: unusual sign-in, was this you?", text: "Check it here: https://elsewhere.example/a", automated: true, threadKey: "bank", date: at(-2 * HOUR) });
    mailbox.deliver({ ...ALERT, subject: "Your statement is ready", text: "A new sign-in to your statements. Was this you? https://lumen-bank.example/s", threadKey: "bank", date: at(-HOUR) });
    await t.server.syncInbox(t.person, inbox.id);
    await t.server.whenIdle();
    const thread = await t.threadBySubject("Security alert: unusual sign-in, was this you?");
    assert.deepEqual([thread.screened, thread.skippedScreening], [true, undefined]);
  });

  test("the same proved sender's thread keeps its first subject: a security alert joining it must say so there too", async () => {
    // The release verifier's case (M2): with only the newest message's subject checked, this would skip Screening.
    const { inbox, mailbox } = await inboxWithAi();
    answer("notification", "security");
    mailbox.deliver({ ...ALERT, subject: "Your statement is ready", text: "Your November statement is ready to view.", threadKey: "statement", date: at(-2 * HOUR) });
    mailbox.deliver({ ...ALERT, threadKey: "statement", date: at(-HOUR) });
    await t.server.syncInbox(t.person, inbox.id);
    await t.server.whenIdle();
    const thread = await t.threadBySubject("Your statement is ready");
    assert.deepEqual([thread.screened, thread.skippedScreening], [true, undefined], "the thread's subject, which the model read, names no alert");
  });

  test("on Gmail a code whose From domain the checker didn't prove never falls back", async () => {
    const { inbox } = await inboxWithAi();
    answer("otp");
    for (const fromCheck of [{ result: "unverified" }, { result: "other_checker" }, { result: "repeated" }, { result: "no_header" }] as const) {
      const thread = await t.receive(inbox, { ...CODE, subject: `Code, ${fromCheck.result}`, fromCheck });
      assert.deepEqual([thread.category, thread.screened], ["otp", true], fromCheck.result);
    }
  });

  test("on IMAP, which has no checker, a code passes as before: machine-sent, addressed to the inbox, a code", async () => {
    const { inbox } = await t.connect({ address: "me@imap.example", history: [historyFromKnown] });
    await t.aiOn();
    answer("otp");
    const { fromCheck: _none, ...unproved } = CODE;
    const thread = await t.receive(inbox, unproved);
    assert.deepEqual([thread.category, thread.screened, thread.skippedScreening], ["otp", false, "code"]);
    const blind = await t.receive(inbox, { ...unproved, subject: "Code by Bcc", to: [{ email: "someone@elsewhere.example" }] });
    assert.equal(blind.screened, true, "not addressed to the inbox");
    answer("notification", "security");
    const alert = await t.receive(inbox, { ...ALERT, fromCheck: undefined });
    assert.equal(alert.screened, true, "nothing else passes on IMAP");
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

  test("the shape of mail sent to this person alone: an alert sent on by Bcc, one with a List-Id, one replying elsewhere", async () => {
    const { inbox } = await inboxWithAi();
    answer("notification", "security");
    for (const [why, input] of [
      ["sent to someone else", { ...ALERT, subject: "Bcc", to: [{ email: "victim.list@elsewhere.example" }] }],
      ["a List-Id", { ...ALERT, subject: "Listed", listId: "alerts.lumen-bank.example" }],
      ["a Reply-To elsewhere", { ...ALERT, subject: "Replying elsewhere", replyTo: [{ email: "helper@elsewhere.example" }] }],
      ["a Cc added after signing", { ...ALERT, subject: "Cc added", to: [{ email: "attacker@elsewhere.example" }], cc: [{ email: "me@ai.example" }] }],
      ["To given twice", { ...ALERT, subject: "Doubled", signedRecipients: [] }],
      ["a document's mention", { ...ALERT, subject: "Mentioned", from: { email: "comments-noreply@docs.google.com" }, fromCheck: proved("docs.google.com") }],
      ["a help desk's tenant", { ...ALERT, subject: "Help desk", from: { email: "no_reply_sample@ab--cd.zendesk.com" }, fromCheck: proved("ab--cd.zendesk.com") }],
    ] as Array<[string, DeliverInput]>) {
      const thread = await t.receive(inbox, input);
      assert.deepEqual([thread.screened, thread.skippedScreening], [true, undefined], why);
    }
    assert.equal(questions(), 0, "none of them was worth asking");
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

  test("mail the gate didn't hold stays in Screening when the AI answers later: the AI turned on afterwards", async () => {
    const { inbox, mailbox } = await inboxWithAi(false);
    const thread = await t.receive(inbox, ALERT);
    assert.equal(mailbox.messages().find((m) => m.subject === ALERT.subject)!.placement.screened, true, "under Screening");
    answer("notification", "security");
    await t.aiOn();
    const after = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([after.category, after.screened, after.skippedScreening], ["notification", true, undefined], "categorized, still screened");
    assert.equal(questions(), 0, "not asked: nothing could pass");
    assert.ok(!mailbox.applied.some((op) => op.op === "place" && !op.screened), "never moved out of Screening");
  });

  test("a categorize that failed and is tried again doesn't lift the gate either", async () => {
    const { inbox, mailbox } = await inboxWithAi();
    t.models.failures.push(failure("unavailable"));
    const thread = await t.receive(inbox, ALERT);
    assert.deepEqual([thread.category, thread.screened], ["unknown", true]);
    answer("notification", "security");
    await t.tick(2 * HOUR);
    const after = (await t.server.thread(t.person, thread.id)).thread;
    assert.deepEqual([after.category, after.screened, after.skippedScreening], ["notification", true, undefined]);
    assert.ok(!mailbox.applied.some((op) => op.op === "place" && !op.screened), "never moved out of Screening");
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
