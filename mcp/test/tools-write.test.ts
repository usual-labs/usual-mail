/** The tools that change things: the right service call, the right shape, and refusals before the service. */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import { AGENT, FakeMailService } from "./fake-service.ts";
import { call, connect, setup } from "./helpers.ts";

let service: FakeMailService;
let client: Client;

beforeEach(async () => {
  const made = setup();
  service = made.service;
  client = await connect(made.handler, "umt_agent");
});

const item = (value: unknown) => value as Record<string, unknown>;
const records = (data: unknown[]) => item(data[0]).records as Array<Record<string, unknown>>;

describe("sort_threads", () => {
  it("decides categories with reasons and reports what applied and what is proposed", async () => {
    const decisions = [
      { threadId: "thr_16", category: "conversation", need: "decide", reason: "A designer asks which direction to take" },
      { threadId: "thr_6", category: "receipt", done: true, reason: "A paid invoice" },
    ];
    const result = await call(client, "sort_threads", { decisions });
    assert.deepEqual(service.callsTo("decide")[0]!.args, [decisions]);
    assert.deepEqual(service.callsTo("decide")[0]!.caller, AGENT);
    assert.equal(result.lead, "Sorted 2 threads: 1 applied, 1 proposed for the person to approve.");
    assert.deepEqual(records(result.data).map((record) => [record.action, record.state]), [["categorize as conversation", "applied"], ["categorize as receipt", "proposed"]]);
    const threads = item(result.data[0]).threads as Array<Record<string, unknown>>;
    assert.deepEqual(threads.map((thread) => [thread.threadId, thread.category, thread.categorizedBy]), [["thr_16", "conversation", "agent"], ["thr_6", "invoice", "agent"]]);
    assert.match(result.next, /"proposed" means it waits for the person's yes/);
  });

  it("takes only a decided category: never unknown, and no pile", async () => {
    for (const decision of [{ category: "unknown" }, { pile: "people" }, { category: "reads" }]) {
      const result = await call(client, "sort_threads", { decisions: [{ threadId: "thr_16", reason: "r", ...decision }] });
      assert.equal(result.isError, true, JSON.stringify(decision));
    }
    assert.equal(service.callsTo("decide").length, 0);
  });

  it("requires a reason for every decision", async () => {
    const result = await call(client, "sort_threads", { decisions: [{ threadId: "thr_16", category: "conversation" }] });
    assert.equal(result.isError, true);
    assert.equal(service.callsTo("decide").length, 0);
  });
});

describe("act_on_threads", () => {
  it("acts with the core action and the reason", async () => {
    const result = await call(client, "act_on_threads", { threadIds: ["thr_1", "thr_2"], action: "done", reason: "Answered" });
    assert.deepEqual(service.callsTo("act")[0]!.args, [{ threadIds: ["thr_1", "thr_2"], action: { kind: "done" }, reason: "Answered" }]);
    assert.equal(result.lead, "Acted on 2 threads: 2 applied, 0 proposed for the person to approve.");
    assert.equal(result.structured!.kind, "act");
    assert.deepEqual((result.structured!.records as Array<Record<string, unknown>>).map((record) => record.undoable), [true, true]);
    assert.match(result.next, /undo_action/);
  });

  it("builds categorize, stack and come_back from their arguments", async () => {
    await call(client, "act_on_threads", { threadIds: ["thr_1"], action: "categorize", category: "newsletter", reason: "r" });
    await call(client, "act_on_threads", { threadIds: ["thr_1"], action: "stack", stack: "set_aside", reason: "r" });
    await call(client, "act_on_threads", {
      threadIds: ["thr_1"],
      action: "come_back",
      comeBackAt: "2026-11-20T08:00:00.000+00:00",
      ifNoReply: true,
      reason: "r",
    });
    assert.deepEqual(
      service.callsTo("act").map((entry) => (entry.args[0] as { action: unknown }).action),
      [
        { kind: "categorize", category: "newsletter" },
        { kind: "stack", stack: "set_aside" },
        { kind: "come_back", at: "2026-11-20T08:00:00Z", ifNoReply: true },
      ],
    );
  });

  it("refuses a categorize without a category, a stack without a stack, and a bad time, before the service", async () => {
    for (const args of [
      { action: "categorize" },
      { action: "stack" },
      { action: "come_back" },
      { action: "come_back", comeBackAt: "next Tuesday" },
    ]) {
      const result = await call(client, "act_on_threads", { threadIds: ["thr_1"], reason: "r", ...args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.equal(item(result.data[0]).error, "invalid");
      assert.match(result.next, /Fix the arguments/);
    }
    const move = await call(client, "act_on_threads", { threadIds: ["thr_1"], action: "move", pile: "reads", reason: "r" });
    assert.equal(move.isError, true, "move is gone since the fifth revision");
    assert.equal(service.callsTo("act").length, 0);
  });

  it("says trash is only proposed", async () => {
    const result = await call(client, "act_on_threads", { threadIds: ["thr_2"], action: "trash", reason: "Spam" });
    assert.equal(result.lead, "Acted on 1 thread: 0 applied, 1 proposed for the person to approve.");
    assert.equal(records(result.data)[0]!.state, "proposed");
  });
});

describe("undo_action", () => {
  it("undoes by action id", async () => {
    const result = await call(client, "undo_action", { actionId: "act_8" });
    assert.equal(result.isError, true, "act_8 is in an inbox this agent can't see");
    const own = await call(client, "act_on_threads", { threadIds: ["thr_1"], action: "done", reason: "r" });
    const actionId = records(own.data)[0]!.actionId;
    const undone = await call(client, "undo_action", { actionId });
    assert.deepEqual(service.callsTo("undo").at(-1)!.args, [actionId]);
    assert.equal(undone.lead, "Undone. 1 thread is back as before.");
    assert.equal((undone.structured!.records as Array<Record<string, unknown>>)[0]!.state, "undone");
  });

  it("explains needs_person when an agent may not undo", async () => {
    const proposal = await call(client, "act_on_threads", { threadIds: ["thr_6"], action: "done", reason: "r" });
    const result = await call(client, "undo_action", { actionId: records(proposal.data)[0]!.actionId });
    assert.equal(result.isError, true);
    assert.equal(result.lead, "Needs a person. Nothing was changed.");
    assert.equal(item(result.data[0]).error, "needs_person");
    assert.match(result.next, /Only a person can do this/);
    assert.match(result.next, /come back as "proposed"/);
  });
});

describe("update_guide", () => {
  it("changes the guide and nothing else, even when other fields are sent", async () => {
    const result = await call(client, "update_guide", {
      inboxId: "inb_harbor",
      guide: "Suppliers first.",
      trust: "act_silently",
      agentAccess: true,
    });
    assert.deepEqual(service.callsTo("updateInbox")[0]!.args, ["inb_harbor", { guide: "Suppliers first." }]);
    assert.deepEqual(result.data, [{ inboxId: "inb_harbor", guide: "Suppliers first." }]);
    assert.equal(service.inboxes.find((inbox) => inbox.id === "inb_harbor")!.trust, "suggest");
  });
});

describe("suggest_rule", () => {
  it("creates a rule without choosing its source, and says it starts off", async () => {
    const result = await call(client, "suggest_rule", {
      inboxId: "inb_northwind",
      text: "Mail from fernhill.example is a receipt and done",
      match: { domain: "fernhill.example", subjectContains: "" },
      then: [{ kind: "categorize", category: "receipt" }, { kind: "done" }],
    });
    assert.deepEqual(service.callsTo("createRule")[0]!.args, [
      {
        inboxId: "inb_northwind",
        text: "Mail from fernhill.example is a receipt and done",
        match: { domain: "fernhill.example" },
        then: [{ kind: "categorize", category: "receipt" }, { kind: "done" }],
      },
      undefined,
    ]);
    assert.equal(result.lead, "Rule suggested. It stays off until a person turns it on.");
    assert.equal(item(result.data[0]).enabled, false);
    assert.equal(item(result.data[0]).source, "agent");
  });

  it("refuses an empty match, a categorize without a category, and kinds a rule can't hold", async () => {
    const base = { inboxId: "inb_northwind", text: "t" };
    const empty = await call(client, "suggest_rule", { ...base, match: {}, then: [{ kind: "done" }] });
    assert.equal(item(empty.data[0]).message, "match needs at least one field.");
    const bare = await call(client, "suggest_rule", { ...base, match: { from: "a@b.example" }, then: [{ kind: "categorize" }] });
    assert.equal(item(bare.data[0]).message, "A categorize in `then` needs a category.");
    const move = await call(client, "suggest_rule", { ...base, match: { from: "a@b.example" }, then: [{ kind: "move", pile: "reads" }] });
    assert.equal(move.isError, true, "move is gone since the fifth revision");
    const unread = await call(client, "suggest_rule", { ...base, match: { from: "a@b.example" }, then: [{ kind: "unread" }] });
    assert.equal(unread.isError, true);
    assert.equal(service.callsTo("createRule").length, 0);
  });
});

describe("suggest_rule from a thread", () => {
  it("builds a rule for the thread's mailing list from its List-Id, in the thread's inbox", async () => {
    const result = await call(client, "suggest_rule", {
      text: "The Weekly Build is a newsletter and done",
      listFromThread: "thr_4",
      then: [{ kind: "categorize", category: "newsletter" }, { kind: "done" }],
    });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(service.callsTo("thread")[0]!.args, ["thr_4"]);
    assert.deepEqual(service.callsTo("createRule")[0]!.args[0], {
      inboxId: "inb_northwind",
      text: "The Weekly Build is a newsletter and done",
      match: { listId: "weekly-build.weeklybuild.example" },
      then: [{ kind: "categorize", category: "newsletter" }, { kind: "done" }],
    });
    assert.deepEqual(item(result.data[0]).match, { listId: "weekly-build.weeklybuild.example" });
  });

  it("keeps other conditions, and refuses a thread from no list, another inbox or another list id", async () => {
    await call(client, "suggest_rule", { text: "t", listFromThread: "thr_4", match: { subjectContains: "issue" }, then: [{ kind: "read" }] });
    assert.deepEqual((service.callsTo("createRule")[0]!.args[0] as { match: unknown }).match, { subjectContains: "issue", listId: "weekly-build.weeklybuild.example" });
    const noList = await call(client, "suggest_rule", { text: "t", listFromThread: "thr_1", then: [{ kind: "read" }] });
    assert.match(String(item(noList.data[0]).message), /no List-Id/);
    const otherInbox = await call(client, "suggest_rule", { inboxId: "inb_harbor", text: "t", listFromThread: "thr_4", then: [{ kind: "read" }] });
    assert.equal(item(otherInbox.data[0]).message, "That thread is in another inbox than inboxId.");
    const otherList = await call(client, "suggest_rule", { text: "t", listFromThread: "thr_4", match: { listId: "x.example" }, then: [{ kind: "read" }] });
    assert.match(String(item(otherList.data[0]).message), /differs from the thread's list/);
    const nothing = await call(client, "suggest_rule", { text: "t", then: [{ kind: "read" }] });
    assert.match(String(item(nothing.data[0]).message), /inboxId is needed/);
    assert.equal(service.callsTo("createRule").length, 1);
  });

  it("a thread this agent can't see is not found", async () => {
    const result = await call(client, "suggest_rule", { text: "t", listFromThread: "thr_11", then: [{ kind: "read" }] });
    assert.equal(item(result.data[0]).error, "not_found");
  });
});

describe("update_rule and delete_rule", () => {
  it("changes only the text of an agent's rule that is on, and it stays on", async () => {
    service.rules.push({ id: "rul_a", inboxId: "inb_harbor", text: "Old", match: { domain: "a.example" }, then: [{ kind: "read" }], source: "agent", enabled: true, hits: 3, createdBy: { kind: "agent" as const, agentId: "dev_agent_1", name: "Test Agent" }, version: 1, createdAt: "2026-11-15T00:00:00Z" });
    const result = await call(client, "update_rule", { ruleId: "rul_a", text: "New words" });
    assert.deepEqual(service.callsTo("updateRule")[0]!.args, ["rul_a", { text: "New words" }]);
    assert.equal(result.lead, "Rule changed. It is on.");
  });

  it("changing what an agent's rule that is on matches switches it off, as the server does", async () => {
    service.rules.push({ id: "rul_a", inboxId: "inb_harbor", text: "Old", match: { domain: "a.example" }, then: [{ kind: "read" }], source: "agent", enabled: true, hits: 3, createdBy: { kind: "agent" as const, agentId: "dev_agent_1", name: "Test Agent" }, version: 1, createdAt: "2026-11-15T00:00:00Z" });
    const result = await call(client, "update_rule", {
      ruleId: "rul_a",
      match: { domain: "b.example", from: "" },
      then: [{ kind: "categorize", category: "receipt" }, { kind: "done" }],
    });
    assert.deepEqual(service.callsTo("updateRule")[0]!.args, [
      "rul_a",
      { match: { domain: "b.example" }, then: [{ kind: "categorize", category: "receipt" }, { kind: "done" }] },
    ]);
    assert.equal(result.lead, "Rule changed. It is off until a person turns it on.");
  });

  it("refuses an empty change, an empty match and a categorize without a category before the service", async () => {
    for (const args of [{}, { match: {} }, { then: [{ kind: "categorize" }] }]) {
      const result = await call(client, "update_rule", { ruleId: "rul_4", ...args });
      assert.equal(item(result.data[0]).error, "invalid", JSON.stringify(args));
    }
    assert.equal(service.callsTo("updateRule").length, 0);
  });

  it("deletes an agent's rule", async () => {
    service.rules.push({ id: "rul_a", inboxId: "inb_harbor", text: "Old", match: { domain: "a.example" }, then: [{ kind: "read" }], source: "agent", enabled: false, hits: 0, createdBy: { kind: "agent" as const, agentId: "dev_agent_1", name: "Test Agent" }, version: 1, createdAt: "2026-11-15T00:00:00Z" });
    const result = await call(client, "delete_rule", { ruleId: "rul_a" });
    assert.deepEqual(service.callsTo("deleteRule")[0]!.args, ["rul_a"]);
    assert.equal(result.lead, "Rule deleted. Mail it already sorted stays where it is.");
    assert.ok(!service.rules.some((rule) => rule.id === "rul_a"));
  });
});

describe("delete_draft", () => {
  it("deletes a draft an agent wrote", async () => {
    const result = await call(client, "delete_draft", { draftId: "drf_1" });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(service.callsTo("deleteDraft")[0]!.args, ["drf_1"]);
    assert.deepEqual(result.data, [{ draftId: "drf_1", deleted: true }]);
    assert.equal(result.lead, "Draft deleted.");
  });

  it("asks the service straight away, which says when there is no such draft", async () => {
    const missing = await call(client, "delete_draft", { draftId: "drf_nope" });
    assert.equal(item(missing.data[0]).error, "not_found");
    assert.deepEqual(service.callsTo("deleteDraft").map((entry) => entry.args), [["drf_nope"]]);
    assert.equal(service.callsTo("listDrafts").length, 0, "no lookup of its own");
  });
});

describe("write_draft", () => {
  it("replies to the newest message someone else sent, with recipients and subject from it", async () => {
    const result = await call(client, "write_draft", { threadId: "thr_13", body: "Thank you, Ines." });
    const input = service.callsTo("saveDraft")[0]!.args[0] as Record<string, unknown>;
    assert.deepEqual(input, {
      inboxId: "inb_northwind",
      threadId: "thr_13",
      inReplyToMessageId: "msg_13c",
      to: [service.messages.find((message) => message.id === "msg_13c")!.from],
      cc: [],
      subject: "Re: Thanks for the workshop",
      body: "Thank you, Ines.",
    });
    assert.equal(result.lead, "Draft saved. A person reviews and sends it in Usual Mail; you can't send it.");
    assert.equal(item(result.data[0]).state, "draft");
  });

  it("replies to an outgoing message's recipients and copies the others on reply all", async () => {
    const message = service.messages.find((entry) => entry.id === "msg_1a")!;
    message.cc = [{ email: "legal@lumen.example" }, { email: "hello@northwind.example" }];
    await call(client, "write_draft", { threadId: "thr_1", messageId: "msg_1a", body: "b", replyAll: true });
    const input = service.callsTo("saveDraft")[0]!.args[0] as Record<string, unknown>;
    assert.deepEqual(input.to, [{ name: "Dana Whitfield", email: "dana@lumen.example" }]);
    assert.deepEqual(input.cc, [{ email: "legal@lumen.example" }]);
    assert.equal(input.subject, "Re: Contract renewal for 2027");
  });

  it("changes only the body of an existing draft", async () => {
    await call(client, "write_draft", { threadId: "thr_1", draftId: "drf_1", body: "New body" });
    const input = service.callsTo("saveDraft")[0]!.args[0] as Record<string, unknown>;
    assert.equal(input.id, "drf_1");
    assert.equal(input.body, "New body");
    assert.deepEqual(input.to, [{ name: "Dana Whitfield", email: "dana@lumen.example" }]);
    assert.equal(input.subject, "Re: Contract renewal for 2027");
  });

  it("refuses a draft or message that isn't in the thread", async () => {
    const draft = await call(client, "write_draft", { threadId: "thr_13", draftId: "drf_1", body: "b" });
    assert.equal(item(draft.data[0]).error, "not_found");
    const message = await call(client, "write_draft", { threadId: "thr_13", messageId: "msg_1a", body: "b" });
    assert.equal(item(message.data[0]).error, "invalid");
    assert.equal(service.callsTo("saveDraft").length, 0);
  });
});

describe("write_brief and get_brief", () => {
  it("writes a brief with times in the contract's form", async () => {
    const result = await call(client, "write_brief", {
      from: "2026-11-15T17:00:00.000Z",
      to: "2026-11-16T09:00:00+00:00",
      sections: [{ inboxId: "inb_harbor", summary: "Quiet.", highlights: [{ threadId: "thr_6", line: "An invoice is due." }] }],
    });
    assert.deepEqual(service.callsTo("writeBrief")[0]!.args, [
      {
        from: "2026-11-15T17:00:00Z",
        to: "2026-11-16T09:00:00Z",
        sections: [{ inboxId: "inb_harbor", summary: "Quiet.", highlights: [{ threadId: "thr_6", line: "An invoice is due." }] }],
      },
    ]);
    assert.equal(result.lead, "Brief saved. The person sees it in Usual Mail.");
    const sections = item(result.data[0]).sections as Array<{ highlights: Array<Record<string, unknown>> }>;
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.highlights[0]!.subject, "Invoice 2026-118, due 30 November", "the server fills in the subject");
  });

  it("refuses times that aren't times or are in the wrong order", async () => {
    const bad = await call(client, "write_brief", { from: "yesterday", to: "2026-11-16T09:00:00Z", sections: [{ inboxId: "inb_harbor" }] });
    assert.equal(item(bad.data[0]).error, "invalid");
    const order = await call(client, "write_brief", { from: "2026-11-16T09:00:00Z", to: "2026-11-15T09:00:00Z", sections: [{ inboxId: "inb_harbor" }] });
    assert.equal(item(order.data[0]).message, "from must be before to.");
    assert.equal(service.callsTo("writeBrief").length, 0);
  });

  it("shows the latest brief with inbox names, hats and highlighted subjects", async () => {
    const result = await call(client, "get_brief");
    assert.equal(service.callsTo("latestBrief").length, 1);
    assert.equal(result.lead, "Brief with 2 sections.");
    const brief = item(item(result.structured!).brief);
    assert.equal(brief.writtenBy, "Claude Code");
    const sections = brief.sections as Array<Record<string, unknown>>;
    assert.deepEqual(sections.map((section) => [section.inboxName, section.hat]), [
      ["Northwind Studio", "blue"],
      ["Harbor & Pine", "green"],
    ]);
    const highlights = sections[0]!.highlights as Array<Record<string, unknown>>;
    assert.deepEqual(highlights[0], {
      threadId: "thr_1",
      line: "Dana asks for 60 days' notice instead of 30 and an answer by Friday.",
      subject: "Contract renewal for 2027",
    });
    assert.equal(service.callsTo("thread").length, 0, "the subject comes with the brief");
    assert.deepEqual((item(result.data[0]).sections as Array<{ highlights: unknown[] }>)[0]!.highlights[0], {
      threadId: "thr_1",
      subject: "Contract renewal for 2027",
      line: "Dana asks for 60 days' notice instead of 30 and an answer by Friday.",
    });
  });

  it("shows the subject the brief was written with, even when the thread changed or is gone", async () => {
    service.threads.find((thread) => thread.id === "thr_1")!.subject = "Renamed since";
    service.threads = service.threads.filter((thread) => thread.id !== "thr_2");
    const result = await call(client, "get_brief");
    const sections = item(item(result.structured!).brief).sections as Array<{ highlights: Array<Record<string, unknown>> }>;
    assert.deepEqual(sections[0]!.highlights.map((highlight) => highlight.subject), ["Contract renewal for 2027", "Two candidates for the design role"]);
  });

  it("gets a brief by id, and says when there is none", async () => {
    await call(client, "get_brief", { briefId: "brf_1" });
    assert.deepEqual(service.callsTo("brief")[0]!.args, ["brf_1"]);
    service.briefs = [];
    const none = await call(client, "get_brief");
    assert.equal(none.lead, "No brief yet.");
    assert.deepEqual(none.structured, { notice: none.structured!.notice, kind: "brief", brief: null });
  });
});
