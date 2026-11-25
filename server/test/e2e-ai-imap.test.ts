// End to end with the server's AI and IMAP: the real server and the real IMAP provider against an IMAP server in this
// process, with fake models (no real model is called), through REST only; the mailbox is read with another mail app.
// Mail arrives and is categorized and summarized, the category's folder holds it, a person's correction is written
// back and teaches a rule, a stranger's one-time code waits in Screening (IMAP has no checker the server trusts to prove
// its From domain), the key shows nowhere, and a second server
// on the same account reads the categories back from the folders.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { parts } from "../src/node/parts.ts";
import { assertKeyNowhere, program, subjectOf, turnAiOn } from "./e2e/ai.ts";
import { rawMail, startMailHost, type MailHost } from "./e2e/imap-server.ts";
import { startWorld, type Json, type World } from "./e2e/world.ts";

let host: MailHost;
let w: World;
const world = () => startWorld({ imap: parts.providers.imap! });
beforeEach(async () => {
  host = await startMailHost();
  w = await world();
});
afterEach(async () => {
  await w.close();
  await host.close();
  assert.deepEqual(w.errors.filter((line) => !line.includes("Watching")), [], "nothing went wrong in the background");
});

let next = 0;
const id = (name: string) => `${name}-${++next}@e2e-ai.example`;
const DANA = "Dana Whitfield <dana@lumen.example>";
const KESTREL = "Kestrel Roasters <accounts@kestrel.example>";
const ROASTERS = "Coffee Roasters Monthly <news@roasters.example>";

/** The folder each message with this subject is in. */
const folderOf = async (subject: string) => (await host.folders()).filter((m) => m.subject === subject).map((m) => m.folder);
const folders = async () => new Set((await host.folders()).map((m) => m.folder));

async function deliver(inbox: Json, from: string, subject: string, extra: Partial<Parameters<typeof rawMail>[0]> = {}): Promise<Json> {
  host.deliver(rawMail({ from, subject, messageId: id(subject.replace(/\W+/g, "-")), ...extra }));
  await w.sync(inbox.id);
  return w.thread(subject);
}

async function connect(): Promise<Json> {
  const inbox = await w.ok("POST", "/v1/inboxes", { body: { name: "Mail Example", color: "#2F6FED", provider: "imap", credentials: host.credentials(), trust: "act_with_undo" } });
  await w.idle();
  return inbox;
}

test("IMAP with the AI: categorized, summarized, filed, corrected and taught; read back by a second server", async () => {
  host.append("INBOX", rawMail({ from: DANA, subject: "Earlier conversation", messageId: id("earlier") }), ["\\Seen"]);
  host.append("Archive", rawMail({ from: KESTREL, subject: "Old invoice", messageId: id("old") }), ["\\Seen"]);
  host.append("Archive", rawMail({ from: ROASTERS, subject: "October cupping notes", messageId: id("october") }), ["\\Seen"]);
  const inbox = await connect();
  await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { agentAccess: true } });
  const agent = await w.agent([inbox.id]);
  const heard = [await w.listen(w.personToken), await w.listen(agent)];
  program(w.models);

  await turnAiOn(w, inbox.id);
  const earlier = await w.thread("Earlier conversation");
  assert.deepEqual([earlier.category, earlier.categorizedBy, earlier.summary], ["conversation", "ai", "About earlier conversation"]);
  assert.deepEqual(await folderOf("Earlier conversation"), ["INBOX"]);

  const news = await deliver(inbox, ROASTERS, "November cupping notes", { headers: { "List-Id": "Roasters <monthly.roasters.example>" } });
  assert.deepEqual([news.category, news.categorizedBy, news.summary], ["newsletter", "ai", "About november cupping notes"]);
  assert.deepEqual(await folderOf("November cupping notes"), ["Usual Mail/Newsletters"]);

  const invoice = await deliver(inbox, KESTREL, "Invoice 7");
  assert.deepEqual(await folderOf("Invoice 7"), ["Usual Mail/Notifications"]);
  const corrected = await w.ok("POST", "/v1/actions", { body: { threadIds: [invoice.id], action: { kind: "categorize", category: "invoice" } } });
  assert.match(corrected.teach.question, /as an invoice\?$/);
  await w.idle();
  assert.deepEqual(await folderOf("Invoice 7"), ["Usual Mail/Invoices"], "the correction is written back");
  const rule = await w.ok("POST", `/v1/teach/${corrected.teach.id}`, { body: { accept: true } });
  const asked = w.models.sent("choose").length;
  const taught = await deliver(inbox, KESTREL, "Invoice 8");
  assert.deepEqual([taught.category, taught.categorizedBy, taught.reason], ["invoice", "rule", rule.text]);
  assert.equal(w.models.sent("choose").length, asked);
  assert.deepEqual(await folderOf("Invoice 8"), ["Usual Mail/Invoices"]);

  // A stranger's one-time code waits in Screening on IMAP: machine-sent with a code in its text, but no checker the
  // server trusts proved its From domain, and nothing skips Screening without that proof (2026-11-25). Never summarized.
  const choicesBefore = w.models.sent("choose").length;
  const code = await deliver(inbox, "Quillpad <no-reply@quillpad.example>", "Your sign-in code", { body: "Your code is 482 913." });
  assert.deepEqual([code.category, code.screened, code.summary, code.skippedScreening], ["otp", true, undefined, undefined]);
  assert.deepEqual(await folderOf("Your sign-in code"), ["Usual Mail/Screening"]);
  assert.equal(w.models.sent("choose").length, choicesBefore + 1, "categorized only: nothing proved, so the gate's question isn't asked");
  assert.ok(!w.models.requests.some((r) => r.kind === "write" && subjectOf(r.request.data) === "Your sign-in code"));

  // Another stranger is screened in the AI's category; IMAP's Screening folder keeps no category, the server does.
  const stranger = await deliver(inbox, "Tomas <tomas@brightfield.example>", "Pricing?");
  assert.deepEqual([stranger.category, stranger.screened, stranger.summary], ["conversation", true, "About pricing?"]);
  assert.deepEqual(await folderOf("Pricing?"), ["Usual Mail/Screening"]);
  const screenedInvoice = await deliver(inbox, "Billing <billing@newvendor.example>", "Invoice 9");
  assert.deepEqual([screenedInvoice.category, screenedInvoice.screened], ["notification", true]);
  assert.deepEqual(await folderOf("Invoice 9"), ["Usual Mail/Screening"]);
  await w.ok("POST", "/v1/actions", { body: { threadIds: [screenedInvoice.id], action: { kind: "allow_sender" } } });
  await w.idle();
  assert.deepEqual(await folderOf("Invoice 9"), ["Usual Mail/Notifications"], "let in: into its category's folder, kept by the server meanwhile");

  await assertKeyNowhere(w, inbox.id, agent, heard.map((listener) => listener.events));
  for (const listener of heard) listener.stop();

  // A second server on the same account, with a fresh store and no AI: the folders are what survive.
  const before = JSON.stringify((await host.folders()).map((m) => [m.folder, m.messageId]).sort());
  await w.close();
  w = await world();
  await connect();
  const read = async (subject: string) => {
    const thread = await w.thread(subject);
    return [thread.category, thread.categorizedBy, thread.screened, thread.done];
  };
  // Filed within the history days: not done, so the new server's category lists show them.
  assert.deepEqual(await read("November cupping notes"), ["newsletter", "mailbox", false, false]);
  assert.deepEqual(await read("Invoice 7"), ["invoice", "mailbox", false, false], "the person's correction survived as its folder");
  assert.deepEqual(await read("Invoice 8"), ["invoice", "mailbox", false, false]);
  assert.deepEqual(await read("Invoice 9"), ["notification", "mailbox", false, false]);
  assert.deepEqual(await read("Your sign-in code"), ["unknown", undefined, true, false], "screened; the Screening folder keeps no category");
  assert.deepEqual(await read("Pricing?"), ["unknown", undefined, true, false], "screened; the Screening folder keeps no category");
  assert.deepEqual(await read("Earlier conversation"), ["unknown", undefined, false, false], "a conversation reads back as undecided");
  assert.equal(w.models.requests.length, 0);
  await w.idle();
  assert.equal(JSON.stringify((await host.folders()).map((m) => [m.folder, m.messageId]).sort()), before, "the new server moved nothing");
});
