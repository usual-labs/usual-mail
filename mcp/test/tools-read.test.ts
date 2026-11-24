/** The reading tools: the right service call, the right shape, and paging. */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import { AGENT, FakeMailService, sample } from "./fake-service.ts";
import { call, connect, setup } from "./helpers.ts";

let service: FakeMailService;
let client: Client;

beforeEach(async () => {
  const made = setup();
  service = made.service;
  client = await connect(made.handler, "umt_agent");
});

const item = (value: unknown) => value as Record<string, unknown>;

describe("list_inboxes", () => {
  it("lists the agent's inboxes with guide, trust and whether Usual Mail's AI processes them", async () => {
    const result = await call(client, "list_inboxes");
    assert.equal(service.callsTo("listInboxes").length, 1);
    assert.deepEqual(service.callsTo("listInboxes")[0]!.caller, AGENT);
    assert.equal(result.lead, "2 inboxes this agent may see.");
    assert.deepEqual(
      result.data.map((inbox) => [item(inbox).inboxId, item(inbox).trust]),
      [
        ["inb_northwind", "act_with_undo"],
        ["inb_harbor", "suggest"],
      ],
    );
    assert.match(String(item(result.data[0]).guide), /Clients come first/);
    assert.equal("aiProcessing" in item(result.data[0]), false, "no per-inbox AI switch: a key processes every inbox");
    assert.equal("connection" in item(result.data[0]), false, "an agent needn't know how an inbox is connected");
    assert.match(result.next, /take_triage_batch/);
  });

  it("says how far an inbox's first sync has got while it runs, so an agent knows mail is still coming", async () => {
    const northwind = service.inboxes.find((inbox) => inbox.id === "inb_northwind")!;
    northwind.status = "connecting";
    northwind.firstSync = { fetched: 120, total: 340 };
    const result = await call(client, "list_inboxes");
    assert.deepEqual([item(result.data[0]).status, item(result.data[0]).firstSync], ["connecting", { fetched: 120, total: 340 }]);
    assert.equal("firstSync" in item(result.data[1]), false, "only while it runs");
  });
});

describe("take_triage_batch", () => {
  it("takes the unknown threads Usual Mail's AI won't process, with their newest message", async () => {
    const working = await call(client, "take_triage_batch");
    assert.deepEqual(service.callsTo("triageQueue")[0]!.args, [{ limit: 10 }]);
    // While it works, Usual Mail's AI processes every synced thread, however old: thr_14 and thr_16 are its own.
    assert.equal(working.lead, "Nothing waits to be sorted.");
    service.aiState = { ...service.aiState, state: "unavailable" };
    const result = await call(client, "take_triage_batch");
    assert.equal(result.lead, "2 threads to sort, oldest first.");
    const thread = item(result.data[0]);
    assert.equal(thread.threadId, "thr_16");
    assert.equal(thread.category, "unknown");
    assert.equal("categorizedBy" in thread, false);
    assert.equal(item(thread.latest).messageId, "msg_16a");
    assert.match(String(item(thread.latest).text), /three directions/);
    assert.match(result.next, /sort_threads: its category/);
  });

  it("holds every unknown thread while the AI isn't working", async () => {
    service.aiState = { ...service.aiState, state: "key_refused" };
    const failing = await call(client, "take_triage_batch");
    assert.deepEqual(failing.data.map((entry) => item(entry).threadId), ["thr_16", "thr_14"]);
  });

  it("says Home holds conversations and unknown threads, notifications their own list (the owner's decision of 2026-11-19)", async () => {
    const tools = (await client.listTools()).tools;
    const tool = tools.find((entry) => entry.name === "list_threads")!;
    assert.match(tool.description ?? "", /home: what needs the person: conversations and threads nobody has categorized yet/);
    assert.match(client.getInstructions() ?? "", /Home is what needs the person: conversations and unknown threads that aren't done, stacked or waiting\. Notifications are in their own list, not Home\./);
    const triage = tools.find((entry) => entry.name === "act_on_threads") ?? tools.find((entry) => (entry.description ?? "").includes("Categories:"))!;
    assert.match(triage.description ?? "", /notification \(automatic notices: shipping, sign-ins, alerts; they have their own list, not Home\)/);
    assert.doesNotMatch(JSON.stringify(tools), /shows in Home too/);
  });

  it("says what a notification's group is, and that Usual Mail doesn't merge the threads", async () => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "list_threads")!;
    assert.match(tool.description ?? "", /group: the same opaque string on notifications of one inbox about the same thing \(a parcel, an order, a booking or an appointment\); each thread is still listed on its own/);
  });

  it("says in its description that Usual Mail sorts the rest itself", async () => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "take_triage_batch")!;
    assert.match(tool.description ?? "", /Usual Mail's own AI categorizes and summarizes mail by itself; the queue holds only the threads in category unknown/);
    assert.match(client.getInstructions() ?? "", /Usual Mail sorts the rest itself; don't sort it again\./);
  });

  it("passes inboxId and limit, and says when nothing waits", async () => {
    const result = await call(client, "take_triage_batch", { inboxId: "inb_harbor", limit: 25 });
    assert.deepEqual(service.callsTo("triageQueue")[0]!.args, [{ inboxId: "inb_harbor", limit: 25 }]);
    assert.equal(result.lead, "Nothing waits to be sorted.");
    assert.match(result.next, /Stop here/);
  });

  it("cuts a long newest message and marks it", async () => {
    service.messages.find((message) => message.id === "msg_16a")!.text = "x".repeat(5000);
    service.aiState = { ...service.aiState, state: "unavailable" };
    const latest = item(item((await call(client, "take_triage_batch")).data[0]).latest);
    assert.equal(String(latest.text).length, 2000);
    assert.equal(latest.truncated, true);
  });

  it("refuses a limit above 25 before calling the service", async () => {
    const result = await call(client, "take_triage_batch", { limit: 26 });
    assert.equal(result.isError, true);
    assert.match(result.text, /limit/);
    assert.equal(service.callsTo("triageQueue").length, 0);
  });
});

describe("read_thread", () => {
  it("reads a thread with its category, who decided it, its summary, its messages oldest first and its drafts", async () => {
    const result = await call(client, "read_thread", { threadId: "thr_1" });
    assert.deepEqual(service.callsTo("thread")[0]!.args, ["thr_1"]);
    assert.match(result.lead, /^Thread with 2 messages; this page has 2, oldest first, and 1 draft\.$/);
    const thread = item(result.data[0]);
    assert.equal(thread.threadId, "thr_1");
    assert.deepEqual([thread.category, thread.categorizedBy, thread.screened], ["conversation", "agent", false]);
    assert.equal(thread.summary, "Asks you to confirm the 2027 renewal by Friday, with 60 days' notice instead of 30.");
    assert.deepEqual(
      result.data.slice(1, 3).map((message) => item(message).messageId),
      ["msg_1a", "msg_1b"],
    );
    assert.equal(item(result.data[3]).draftId, "drf_1");
    assert.equal(result.next, "");
  });

  it("shows a sent draft's note from the provider while its thread keeps it", async () => {
    const result = await call(client, "read_thread", { threadId: "thr_7" });
    const draft = item(result.data.find((entry) => item(entry).draftId === "drf_2"));
    assert.deepEqual([draft.state, draft.note], ["sent", "Sent, but no copy was saved to the Sent folder: the mail server said the mailbox is full."]);
  });

  it("pages long threads from the newest message back", async () => {
    const first = await call(client, "read_thread", { threadId: "thr_13", limit: 2 });
    assert.deepEqual(
      first.data.slice(1, 3).map((message) => item(message).messageId),
      ["msg_13b", "msg_13c"],
    );
    const cursor = item(first.data.at(-1)).nextCursor;
    assert.equal(cursor, "2");
    assert.match(first.next, /cursor/);
    const second = await call(client, "read_thread", { threadId: "thr_13", limit: 2, cursor });
    assert.deepEqual(
      second.data.slice(1).map((message) => item(message).messageId),
      ["msg_13a"],
    );
    assert.equal(second.next, "");
  });

  it("refuses a cursor it didn't give out", async () => {
    const result = await call(client, "read_thread", { threadId: "thr_13", cursor: "abc" });
    assert.equal(result.isError, true);
    assert.deepEqual(result.data, [{ error: "invalid", message: "cursor is not one this tool gave out." }]);
    assert.equal(service.callsTo("thread").length, 0);
  });

  it("gives plain text for a message that has only HTML", async () => {
    const message = service.messages.find((entry) => entry.id === "msg_1b")!;
    delete message.text;
    message.html = "<p>Hello &amp; welcome</p><p>Second<br>line &#8212; done</p><style>p{}</style>";
    const result = await call(client, "read_thread", { threadId: "thr_1" });
    assert.equal(item(result.data[2]).text, "Hello & welcome\nSecond\nline \u2014 done");
  });
});

describe("search_threads", () => {
  it("searches and pages with the service's cursor", async () => {
    const first = await call(client, "search_threads", { q: "lumen", limit: 3 });
    assert.deepEqual(service.callsTo("search")[0]!.args, [{ q: "lumen", limit: 3 }]);
    assert.equal(first.lead, "3 threads found on this page.");
    const cursor = item(first.data.at(-1)).nextCursor;
    assert.equal(cursor, "3");
    const second = await call(client, "search_threads", { q: "lumen", limit: 3, cursor, inboxId: "inb_northwind" });
    assert.deepEqual(service.callsTo("search")[1]!.args, [{ q: "lumen", inboxIds: ["inb_northwind"], cursor: "3", limit: 3 }]);
    assert.equal(second.lead, "1 thread found.");
    assert.equal(second.next, "");
  });

  it("passes filters, alone or with text, as the service takes them", async () => {
    await call(client, "search_threads", { kinds: ["receipt", "done"], from: "paperloop.example", hasAttachment: false });
    assert.deepEqual(service.callsTo("search").at(-1)!.args, [{ kinds: ["receipt", "done"], from: "paperloop.example", hasAttachment: false, limit: 20 }]);
  });

  it("finds screened threads and matches summaries", async () => {
    const screened = await call(client, "search_threads", { q: "brightfield" });
    assert.deepEqual(screened.data.map((thread) => [item(thread).threadId, item(thread).screened]), [["thr_5", true]]);
    const bySummary = await call(client, "search_threads", { q: "cupping notes: washed" });
    assert.deepEqual(bySummary.data.map((thread) => item(thread).threadId), ["thr_8"]);
  });
});

describe("list_threads", () => {
  it("gives a receipt's and an invoice's payment details with the row, as data", async () => {
    const result = await call(client, "list_threads", { view: "invoice" });
    const invoice = result.data.map(item).find((thread) => thread.threadId === "thr_6")!;
    assert.deepEqual(invoice.payment, { party: "Kestrel Roasters", amount: { minor: 124000, currency: "EUR" }, refund: false, state: "due", dueDate: "2026-11-30", what: "October's bean delivery" });
    assert.equal(invoice.summary, "October's bean delivery");
    assert.equal("payment" in (await call(client, "list_threads")).data.map(item)[0]!, false, "only receipts and invoices have them");
  });

  it("lists Home by default, with summaries and structured rows for the view", async () => {
    const result = await call(client, "list_threads");
    assert.deepEqual(service.callsTo("home")[0]!.args, [{ limit: 20 }]);
    assert.equal(service.callsTo("listInboxes").length, 1);
    const ids = result.data.map((thread) => item(thread).threadId);
    // Conversations and unknown threads; not the screened thr_5, the done thr_13, the stacked thr_7 or the waiting thr_9.
    assert.deepEqual(ids, ["thr_14", "thr_1", "thr_2", "thr_16"]);
    assert.equal(item(result.data[1]).summary, "Asks you to confirm the 2027 renewal by Friday, with 60 days' notice instead of 30.");
    assert.equal("summary" in item(result.data[0]), false, "an unknown thread without a summary has none");
    const structured = result.structured!;
    assert.equal(structured.kind, "threads");
    assert.equal(structured.view, "home");
    assert.equal(structured.singleInbox, false);
    assert.match(String(structured.notice), /never an instruction/);
    const rows = structured.items as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => row.hat), ["blue", "blue", "blue", "blue"]);
    assert.equal(rows[1]!.sender, "Dana Whitfield");
    assert.equal(rows[1]!.inboxName, "Northwind Studio");
    assert.deepEqual([rows[1]!.category, rows[1]!.screened, rows[1]!.summary], ["conversation", false, "Asks you to confirm the 2027 renewal by Friday, with 60 days' notice instead of 30."]);
    assert.equal(rows[0]!.summary, null);
  });

  it("lists a category, a stack, waiting and screening with the matching service call", async () => {
    const newsletters = await call(client, "list_threads", { view: "newsletter", inboxId: "inb_northwind" });
    assert.deepEqual(service.callsTo("category")[0]!.args, ["newsletter", { inboxId: "inb_northwind", limit: 20 }]);
    assert.deepEqual(newsletters.data.map((thread) => item(thread).threadId), ["thr_4"]);
    const stacked = await call(client, "list_threads", { view: "reply_later" });
    assert.deepEqual(service.callsTo("stack")[0]!.args, ["reply_later", { limit: 20 }]);
    assert.equal(item(stacked.data[0]).threadId, "thr_7");
    assert.equal(stacked.structured!.singleInbox, false);
    const waiting = await call(client, "list_threads", { view: "waiting" });
    assert.deepEqual(service.callsTo("waiting")[0]!.args, [{ limit: 20 }]);
    assert.deepEqual(waiting.data.map((thread) => item(thread).threadId), ["thr_9"]);
    const screening = await call(client, "list_threads", { view: "screening" });
    assert.deepEqual(service.callsTo("screening")[0]!.args, [{ limit: 20 }]);
    assert.deepEqual(screening.data.map((thread) => [item(thread).threadId, item(thread).screened, item(thread).category]), [["thr_5", true, "conversation"]]);
    const unknown = await call(client, "list_threads", { view: "unknown" });
    assert.deepEqual(service.callsTo("category")[1]!.args, ["unknown", { limit: 20 }]);
    assert.deepEqual(unknown.data.map((thread) => item(thread).threadId), ["thr_14", "thr_16"]);
  });

  it("no longer offers Now or the piles", async () => {
    for (const view of ["now", "people", "reads", "receipts"]) {
      const result = await call(client, "list_threads", { view });
      assert.equal(result.isError, true, view);
    }
  });

  it("pages", async () => {
    const first = await call(client, "list_threads", { limit: 3 });
    assert.equal(first.data.length, 4);
    assert.deepEqual(first.data.at(-1), { nextCursor: "3" });
    assert.equal(first.structured!.nextCursor, "3");
    const second = await call(client, "list_threads", { limit: 3, cursor: "3" });
    assert.deepEqual(
      second.data.map((thread) => item(thread).threadId),
      ["thr_16"],
    );
    assert.equal(second.structured!.nextCursor, undefined);
  });
});

describe("get_ai_status", () => {
  it("gives the AI's state and counts, never its settings or anything about the key", async () => {
    const result = await call(client, "get_ai_status");
    assert.deepEqual(service.callsTo("aiStatus")[0]!.caller, AGENT);
    assert.equal(service.callsTo("aiSettings").length, 0);
    assert.equal(result.lead, "Usual Mail's AI is working.");
    assert.deepEqual(result.data, [{ state: "working", lastRunAt: "2026-11-16T09:12:40Z", pending: sample().aiStatus.pending }]);
    assert.match(result.next, /You sort only take_triage_batch's queue/);
    assert.doesNotMatch(result.text, /vercel|example\/decision|historyDays|apiKey|credentials/i);
  });

  it("names the job whose model is missing, and says only the person can fix it", async () => {
    service.aiState = { ...service.aiState, state: "model_not_found", job: "summarize", detail: "No such model" };
    const result = await call(client, "get_ai_status");
    assert.match(result.lead, /doesn't know the model of one job/);
    assert.deepEqual(result.data, [{ state: "model_not_found", job: "summarize", lastRunAt: "2026-11-16T09:12:40Z", pending: sample().aiStatus.pending }]);
    assert.match(result.next, /Only the person can fix this, in Usual Mail[\s\S]*take_triage_batch's queue/);
  });
});

describe("list_handled", () => {
  it("lists proposed and applied by default, with each thread's subject", async () => {
    const result = await call(client, "list_handled");
    assert.deepEqual(service.callsTo("handled")[0]!.args, [{ limit: 20 }]);
    assert.deepEqual(result.data.map((record) => item(record).actionId), ["act_2", "act_1", "act_4", "act_3", "act_21"]);
    assert.equal(item(result.data[4]).action, "block_sender", "the sample's block an agent proposed and the person approved");
    const proposal = item(result.data[2]);
    assert.equal(proposal.state, "proposed");
    assert.equal(proposal.action, "done");
    assert.equal(proposal.actor, "agent Claude Code");
    assert.equal(proposal.subject, "Coffee Roasters Monthly: the November cupping notes");
    assert.equal(item(proposal.thread).category, "newsletter");
    assert.equal(item(result.data[0]).actor, "rule rul_1");
    assert.equal(item(result.data[1]).action, "categorize as receipt");
    assert.ok(!result.data.some((record) => String(item(record).actor).startsWith("Usual Mail's AI")), "the AI's records are silent");
  });

  it("shows Usual Mail's AI as an actor, with its job and model, only when silent records are asked for", async () => {
    const result = await call(client, "list_handled", { includeSilent: true, inboxId: "inb_harbor" });
    const ai = result.data.map(item).filter((record) => String(record.actor).startsWith("Usual Mail's AI"));
    assert.deepEqual(ai.map((record) => record.actionId), ["act_11", "act_10", "act_17", "act_18"]);
    assert.deepEqual([ai[1]!.actor, ai[1]!.action, ai[1]!.silent], ["Usual Mail's AI (categorize with example/decision-1)", "categorize as invoice", true]);
    assert.equal("reason" in ai[1]!, false, "the AI gives no reason");
  });

  it("leaves silent records out unless asked, and shows silent, error and note on each record", async () => {
    service.inboxes.find((inbox) => inbox.id === "inb_northwind")!.trust = "act_silently";
    const acted = await call(client, "act_on_threads", { threadIds: ["thr_1"], action: "done", reason: "Answered already" });
    assert.equal(acted.lead, "Acted on 1 thread: 1 applied (1 silently), 0 proposed for the person to approve.");
    const actionId = (item(acted.data[0]).records as Array<Record<string, unknown>>)[0]!.actionId;
    const hidden = await call(client, "list_handled");
    assert.ok(!hidden.data.some((record) => item(record).actionId === actionId));
    const shown = await call(client, "list_handled", { includeSilent: true });
    assert.deepEqual(service.callsTo("handled").at(-1)!.args, [{ includeSilent: true, limit: 20 }]);
    const silent = item(shown.data.find((record) => item(record).actionId === actionId));
    assert.equal(silent.silent, true);
    Object.assign(service.actions.find((record) => record.id === "act_1")!, { note: "This server can't keep stacks" });
    Object.assign(service.actions.find((record) => record.id === "act_2")!, { error: "The undo was refused" });
    const noted = await call(client, "list_handled");
    const byId = new Map(noted.data.map((record) => [item(record).actionId, item(record)]));
    assert.equal(byId.get("act_1")!.note, "This server can't keep stacks");
    assert.equal(byId.get("act_2")!.error, "The undo was refused");
    assert.equal("silent" in byId.get("act_1")!, false, "silent is only said when true");
  });

  it("lists a trashed thread's record with the thread marked trashed", async () => {
    service.threads.find((thread) => thread.id === "thr_3")!.trashed = true;
    const result = await call(client, "list_handled");
    const record = item(result.data.find((entry) => item(entry).actionId === "act_1"));
    assert.equal(item(record.thread).trashed, true);
  });

  it("with attentionOnly lists only what failed or carries an error or a note, from every state", async () => {
    Object.assign(service.actions.find((record) => record.id === "act_1")!, { note: "This server can't keep stacks" });
    Object.assign(service.actions.find((record) => record.id === "act_15")!, { error: "The undo was refused" });
    // The AI's record whose write-back the provider refused is no longer silent, so it needs a look too.
    Object.assign(service.actions.find((record) => record.id === "act_9")!, { error: "Gmail refused the label", silent: false });
    const result = await call(client, "list_handled", { attentionOnly: true });
    assert.deepEqual(service.callsTo("handled")[0]!.args, [{ attentionOnly: true, limit: 20 }]);
    assert.deepEqual(result.data.map((record) => [item(record).actionId, item(record).state]), [["act_15", "undone"], ["act_9", "applied"], ["act_1", "applied"]]);
    assert.equal(item(result.data[1]).actor, "Usual Mail's AI (categorize with example/decision-1)");
  });

  it("with attentionOnly also lists the person's own refused change, only in inboxes the agent may see", async () => {
    const own = service.actions.find((record) => record.id === "act_6")!;
    Object.assign(own, { state: "failed", undoable: false, error: "The mail server refused to move it" });
    service.actions.push({ ...structuredClone(own), id: "act_private", inboxId: "inb_personal", threadId: "thr_12" });
    const result = await call(client, "list_handled", { attentionOnly: true });
    const rows = result.data.map((record) => [item(record).actionId, item(record).actor, item(record).state, item(record).error]);
    assert.deepEqual(rows, [["act_6", "person", "failed", "The mail server refused to move it"]], "not the one in an inbox the agent can't see");
    const ordinary = await call(client, "list_handled", { states: ["failed"] });
    assert.ok(!ordinary.data.some((record) => item(record).actionId === "act_6"), "Handled's ordinary list stays rules' and agents'");
  });

  it("passes states and inboxId", async () => {
    const result = await call(client, "list_handled", { states: ["undone"], inboxId: "inb_northwind" });
    assert.deepEqual(service.callsTo("handled")[0]!.args, [{ states: ["undone"], inboxId: "inb_northwind", limit: 20 }]);
    assert.deepEqual(result.data.map((record) => item(record).actionId), ["act_15"]);
  });
});

describe("list_rules", () => {
  it("lists an inbox's rules", async () => {
    const result = await call(client, "list_rules", { inboxId: "inb_northwind" });
    assert.deepEqual(service.callsTo("listRules")[0]!.args, ["inb_northwind"]);
    assert.equal(result.lead, "2 rules.");
    assert.deepEqual(item(result.data[0]).then, ["categorize as receipt", "done"]);
    // Who made each: a person, or an agent by name, so an agent can tell its own suggestions.
    assert.deepEqual(result.data.map((rule) => item(rule).createdBy), ["person", "person"]);
    const harbor = await call(client, "list_rules", { inboxId: "inb_harbor" });
    assert.equal(item(harbor.data[0]).createdBy, "person");
    service.rules.push({ ...service.rules[0]!, id: "rul_agent", source: "agent", enabled: false, createdBy: { kind: "agent", agentId: "dev_agent_1", name: "Claude Code" } });
    const withAgent = await call(client, "list_rules", { inboxId: "inb_northwind" });
    assert.equal(item(withAgent.data.at(-1)).createdBy, "agent Claude Code");
  });
});

describe("list_drafts", () => {
  it("lists drafts not sent yet and failed ones, with who wrote each and the provider's words", async () => {
    service.drafts.push({ ...service.drafts[0]!, id: "drf_failed", state: "failed", error: "The SMTP server refused the recipient", updatedAt: "2026-11-16T09:20:00Z" });
    service.drafts.push({ ...service.drafts[0]!, id: "drf_sent", state: "sent", note: "No copy was saved to Sent" });
    const result = await call(client, "list_drafts");
    assert.deepEqual(service.callsTo("listDrafts")[0]!.args, [{ limit: 20 }]);
    assert.equal(result.lead, "2 drafts.");
    assert.deepEqual(result.data.map((draft) => [item(draft).draftId, item(draft).state]), [["drf_failed", "failed"], ["drf_1", "draft"]]);
    assert.equal(item(result.data[0]).error, "The SMTP server refused the recipient");
    assert.equal(item(result.data[1]).createdBy, "agent Claude Code");
  });
});
