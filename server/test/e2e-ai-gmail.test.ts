// End to end with the server's AI and Gmail: the real server and the real Gmail provider against mail's fake of
// Gmail's REST API, with fake models (no real model is called), through REST only. Mail arrives and is categorized
// and summarized, the category's label appears at Gmail, a person's correction is written back and teaches a rule,
// a stranger's one-time code is never screened, the key shows nowhere, and a second server on the same mailbox reads
// the categories back from the labels.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createGmailProvider } from "@usualmail/mail";
import { FakeGmail } from "@usualmail/mail/testing";
import { assertKeyNowhere, program, subjectOf, turnAiOn } from "./e2e/ai.ts";
import { rawMail } from "./e2e/imap-server.ts";
import { startWorld, type Json, type World } from "./e2e/world.ts";

const ADDRESS = "me@gmail.example";
let fake: FakeGmail;
let w: World;
const world = () => startWorld({ gmail: (credentials, options) => createGmailProvider(credentials, { ...options, fetch: fake.fetch, quotaPerSecond: 1_000_000 }) });
beforeEach(async () => {
  fake = new FakeGmail({ address: ADDRESS });
  w = await world();
});
afterEach(async () => {
  await w.close();
  assert.deepEqual(w.errors, [], "nothing went wrong in the background");
});

let next = 0;
const id = (name: string) => `${name}-${++next}@e2e-ai.example`;
const DANA = "Dana Whitfield <dana@lumen.example>";
const KESTREL = "Kestrel Roasters <accounts@kestrel.example>";
const ROASTERS = "Coffee Roasters Monthly <news@roasters.example>";

/** The labels on each message with this subject, by name, without Gmail's categories. */
function labels(subject: string): string[][] {
  return [...fake.mailbox.messages.values()]
    .filter((m) => m.raw.toString("latin1").includes(`Subject: ${subject}\r\n`))
    .map((m) => [...m.labelIds].map((labelId) => fake.mailbox.labels.get(labelId)?.name ?? labelId).filter((name) => !name.startsWith("CATEGORY_")).sort());
}

const labelNames = () => [...fake.mailbox.labels.values()].map((label) => label.name);

async function deliver(inbox: Json, from: string, subject: string, extra: Partial<Parameters<typeof rawMail>[0]> = {}): Promise<Json> {
  await fake.deliver(rawMail({ from, to: ADDRESS, subject, messageId: id(subject.replace(/\W+/g, "-")), ...extra }));
  await w.sync(inbox.id);
  return w.thread(subject);
}

async function connect(): Promise<Json> {
  const inbox = await w.ok("POST", "/v1/inboxes", { body: { name: "Gmail", color: "#1F8A5B", provider: "gmail", credentials: fake.credentials, trust: "act_with_undo" } });
  await w.idle();
  return inbox;
}

test("Gmail with the AI: categorized, summarized, labelled, corrected and taught; read back by a second server", async () => {
  // History: a conversation in the inbox; archived mail from two senders, who are let in by it.
  await fake.deliver(rawMail({ from: DANA, to: ADDRESS, subject: "Earlier conversation", messageId: id("earlier") }), ["INBOX"]);
  await fake.deliver(rawMail({ from: KESTREL, to: ADDRESS, subject: "Old invoice", messageId: id("old") }), []);
  await fake.deliver(rawMail({ from: ROASTERS, to: ADDRESS, subject: "October cupping notes", messageId: id("october") }), []);
  const inbox = await connect();
  await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { agentAccess: true } });
  const agent = await w.agent([inbox.id]);
  const heard = [await w.listen(w.personToken), await w.listen(agent)];
  program(w.models);
  assert.equal(w.models.requests.length, 0, "nothing goes to the AI before credentials are set");

  await turnAiOn(w, inbox.id);
  // The key makes every inbox's threads history: what isn't done is processed, newest first.
  const earlier = await w.thread("Earlier conversation");
  assert.deepEqual([earlier.category, earlier.categorizedBy, earlier.summary], ["conversation", "ai", "About earlier conversation"]);
  assert.deepEqual(labels("Earlier conversation"), [["INBOX"]], "a conversation carries no label");
  assert.equal((await w.thread("Old invoice")).summary, undefined, "done history isn't processed");
  assert.deepEqual(w.models.requests.map((r) => [r.kind, subjectOf(r.request.data)]), [["choose", "Earlier conversation"], ["write", "Earlier conversation"]]);

  // New mail: categorized, then summarized, and the label appears at Gmail.
  const news = await deliver(inbox, ROASTERS, "November cupping notes", { headers: { "List-Id": "Roasters <monthly.roasters.example>" }, body: "Washed Ethiopians are back." });
  assert.deepEqual([news.category, news.categorizedBy, news.screened, news.summary], ["newsletter", "ai", false, "About november cupping notes"]);
  assert.deepEqual(labels("November cupping notes"), [["UNREAD", "Usual Mail/Newsletters"]]);
  const sent = w.models.requests.find((r) => r.kind === "choose" && subjectOf(r.request.data) === "November cupping notes")!.request;
  assert.match(sent.data, /^<usual-mail-data id="[0-9a-f]{18}">\n.*\n<\/usual-mail-data id="[0-9a-f]{18}">$/s, "the mail inside one marked block");
  assert.match(sent.data, /"listId":"monthly\.roasters\.example"/);
  assert.match(sent.data, /"text":"Washed Ethiopians are back\."/);
  assert.ok(!sent.instructions.includes("Ethiopians"), "the server's words carry no mail");
  const record = (await w.ok("GET", "/v1/handled?includeSilent=true")).items.find((item: Json) => item.thread.id === news.id).record;
  assert.deepEqual([record.actor, record.silent, record.action], [{ kind: "ai", job: "categorize", model: "fake/categorize" }, true, { kind: "categorize", category: "newsletter" }]);
  assert.ok(!(await w.ok("GET", "/v1/handled")).items.some((item: Json) => item.thread.id === news.id), "silent: in Handled only when asked");

  // The AI gets one wrong; the person corrects it. It is written back as the label and offers to teach a rule.
  const invoice = await deliver(inbox, KESTREL, "Invoice 7", { body: "1,240.00 EUR, due 30 November." });
  assert.deepEqual([invoice.category, invoice.categorizedBy], ["notification", "ai"]);
  assert.deepEqual(labels("Invoice 7"), [["UNREAD", "Usual Mail/Notifications"]]);
  const corrected = await w.ok("POST", "/v1/actions", { body: { threadIds: [invoice.id], action: { kind: "categorize", category: "invoice" } } });
  assert.deepEqual([corrected.threads[0].category, corrected.threads[0].categorizedBy], ["invoice", "person"]);
  assert.match(corrected.teach.question, /^Always treat mail from Kestrel Roasters \(accounts@kestrel\.example\) as an invoice\?$/);
  await w.idle();
  assert.deepEqual(labels("Invoice 7"), [["UNREAD", "Usual Mail/Invoices"]], "the correction is written back");
  const details = await w.thread("Invoice 7");
  assert.deepEqual(details.payment, { party: "Kestrel Roasters", amount: { minor: 124000, currency: "EUR" }, refund: false, state: null, dueDate: null, what: "Invoice 7" },
    "now an invoice, it is asked for its details, each checked against the mail");
  assert.equal(details.summary, "Invoice 7");
  const rule = await w.ok("POST", `/v1/teach/${corrected.teach.id}`, { body: { accept: true } });
  assert.deepEqual([rule.source, rule.enabled, rule.then], ["correction", true, [{ kind: "categorize", category: "invoice" }]]);
  const asked = w.models.sent("choose").length;
  const taught = await deliver(inbox, KESTREL, "Invoice 8");
  assert.deepEqual([taught.category, taught.categorizedBy, taught.reason], ["invoice", "rule", rule.text]);
  assert.equal(w.models.sent("choose").length, asked, "the rule decided it: no categorize request");
  assert.equal(taught.summary, "Invoice 8", "the AI still processes it: an invoice's details, whose what is its summary");
  assert.deepEqual(labels("Invoice 8"), [["UNREAD", "Usual Mail/Invoices"]]);

  // A stranger's one-time code: categorized first, never screened, never summarized, never under Screening.
  assert.ok(!labelNames().includes("Usual Mail/Screening"));
  // Gmail's own checker proved its From domain, and the passing signature (b= starting AbCd1234) signs To. Gmail's
  // sealed copy of its result, above it, agrees.
  const result = "mx.google.com; dkim=pass header.i=@quillpad.example header.s=s1 header.b=AbCd1234; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=quillpad.example";
  const proved = {
    "ARC-Authentication-Results": `i=1; ${result}`,
    "Authentication-Results": result,
    "DKIM-Signature": "v=1; a=rsa-sha256; c=relaxed/relaxed; d=quillpad.example; s=s1; h=from:to:subject:date; bh=abc=; b=AbCd1234wxyz",
  };
  const code = await deliver(inbox, "Quillpad <no-reply@quillpad.example>", "Your sign-in code", { body: "Your code is 482 913.", headers: proved });
  assert.deepEqual([code.category, code.screened, code.summary], ["otp", false, undefined]);
  assert.deepEqual(labels("Your sign-in code"), [["UNREAD", "Usual Mail/One-Time Codes"]]);
  assert.ok(!labelNames().includes("Usual Mail/Screening"), "no message was ever put under Screening");
  assert.ok(!w.models.requests.some((r) => r.kind === "write" && subjectOf(r.request.data) === "Your sign-in code"));

  // Any other stranger is screened, in the category the AI gave it, and summarized for the screening list.
  const stranger = await deliver(inbox, "Tomas <tomas@brightfield.example>", "Pricing?");
  assert.deepEqual([stranger.category, stranger.screened, stranger.summary], ["conversation", true, "About pricing?"]);
  assert.deepEqual(labels("Pricing?"), [["UNREAD", "Usual Mail/Screening"]]);
  assert.deepEqual((await w.ok("GET", "/v1/screening")).items.map((x: Json) => x.id), [stranger.id]);
  // Gmail keeps every label on a message: a screened thread carries its category's label too.
  const screenedInvoice = await deliver(inbox, "Billing <billing@newvendor.example>", "Invoice 9");
  assert.deepEqual([screenedInvoice.category, screenedInvoice.screened], ["notification", true]);
  assert.deepEqual(labels("Invoice 9"), [["UNREAD", "Usual Mail/Notifications", "Usual Mail/Screening"]]);

  const status = await w.ok("GET", "/v1/ai/status");
  assert.deepEqual([status.state, status.pending], ["working", 0]);
  assert.ok(heard[0]!.events.some((event) => event.type === "thread.changed" && event.thread.id === news.id && event.thread.summary));
  await assertKeyNowhere(w, inbox.id, agent, heard.map((listener) => listener.events));
  for (const listener of heard) listener.stop();

  // A new server on the same mailbox, with a fresh store and no AI: the labels are what survive.
  const before = JSON.stringify([...fake.mailbox.messages.values()].map((m) => [m.id, [...m.labelIds].sort()]));
  await w.close();
  w = await world();
  await connect();
  const read = async (subject: string) => {
    const thread = await w.thread(subject);
    return [thread.category, thread.categorizedBy, thread.screened, thread.done];
  };
  // Filed within the history days: not done, so the new server's category lists show them.
  assert.deepEqual(await read("November cupping notes"), ["newsletter", "mailbox", false, false]);
  assert.deepEqual(await read("Invoice 7"), ["invoice", "mailbox", false, false], "the person's correction survived as its label");
  assert.deepEqual(await read("Invoice 8"), ["invoice", "mailbox", false, false]);
  assert.deepEqual(await read("Your sign-in code"), ["otp", "mailbox", false, false]);
  assert.deepEqual(await read("Pricing?"), ["unknown", undefined, true, false], "still screened; a conversation has no label");
  assert.deepEqual(await read("Invoice 9"), ["notification", "mailbox", true, false], "screened, in the category its label names");
  assert.deepEqual(await read("Earlier conversation"), ["unknown", undefined, false, false], "a conversation reads back as undecided");
  assert.equal((await w.thread("November cupping notes")).summary, undefined, "summaries lived only on the old server");
  assert.equal(w.models.requests.length, 0);
  assert.equal(JSON.stringify([...fake.mailbox.messages.values()].map((m) => [m.id, [...m.labelIds].sort()])), before, "the new server moved nothing");
});
