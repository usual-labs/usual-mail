/** An agent sees only its inboxes, and nothing that needs a person is offered or reachable. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NARROW_AGENT } from "./fake-service.ts";
import { call, connect, setup } from "./helpers.ts";

const OFFERED = [
  "list_inboxes",
  "update_guide",
  "list_rules",
  "suggest_rule",
  "update_rule",
  "delete_rule",
  "take_triage_batch",
  "sort_threads",
  "get_ai_status",
  "read_thread",
  "search_threads",
  "list_threads",
  "act_on_threads",
  "undo_action",
  "list_handled",
  "write_draft",
  "list_drafts",
  "delete_draft",
  "write_brief",
  "get_brief",
];

/** Service methods only a person may call, or that the connector has no business calling. */
const NEVER_CALLED = [
  "connectInbox",
  "removeInbox",
  "approve",
  "reject",
  "answerTeach",
  "sendDraft",
  "listDevices",
  "createPairingCode",
  "pair",
  "revokeDevice",
  "syncInbox",
  "subscribe",
  // The AI's settings and testing are a person's; an agent may read only its status.
  "aiSettings",
  "updateAiSettings",
  "testAi",
];

const GUESSES = [
  "send_draft",
  "sendDraft",
  "send",
  "send_mail",
  "approve",
  "approve_actions",
  "approve_proposals",
  "reject",
  "reject_actions",
  "connect_inbox",
  "connectInbox",
  "remove_inbox",
  "update_inbox",
  "reconnect_inbox",
  "update_credentials",
  "set_trust",
  "set_agent_access",
  "enable_rule",
  "turn_on_rule",
  "set_rule_enabled",
  "answer_teach",
  "list_devices",
  "create_pairing_code",
  "revoke_device",
  "revoke_token",
  "pair",
  "get_ai_settings",
  "ai_settings",
  "set_ai_key",
  "update_ai_settings",
  "set_ai_model",
  "test_ai",
  "pause_ai",
  "set_ai_processing",
  "turn_on_ai",
];

describe("what is offered", () => {
  it("offers exactly the agent's tools, in a fixed order", async () => {
    const { handler } = setup();
    const client = await connect(handler, "umt_agent");
    const first = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(first, OFFERED);
    const legacy = await connect(handler, "umt_agent", { era: "legacy" });
    assert.deepEqual((await legacy.listTools()).tools.map((tool) => tool.name), OFFERED);
  });

  it("every tool has a title, a description and annotations", async () => {
    const { handler } = setup();
    const client = await connect(handler, "umt_agent");
    for (const tool of (await client.listTools()).tools) {
      assert.ok(tool.title, tool.name);
      assert.ok((tool.description ?? "").length > 80, tool.name);
      assert.equal(tool.annotations?.openWorldHint, false, tool.name);
    }
  });

  it("can't reach a person-only action by guessing its name", async () => {
    const { handler, service } = setup();
    const client = await connect(handler, "umt_agent");
    for (const name of GUESSES) {
      const outcome = await client.callTool({ name, arguments: { id: "drf_1", ruleId: "rul_1", actionIds: ["act_4"], inboxId: "inb_harbor" } }).then(
        (result) => result,
        (error: unknown) => error,
      );
      if (outcome instanceof Error) assert.match(outcome.message, /not found|unknown/i, name);
      else assert.equal((outcome as { isError?: boolean }).isError, true, name);
    }
    const reached = service.calls.filter((entry) => NEVER_CALLED.includes(entry.method));
    assert.deepEqual(reached, []);
  });

  it("offers only the two view resources", async () => {
    const { handler } = setup();
    const client = await connect(handler, "umt_agent");
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((resource) => resource.uri).sort(), ["ui://usual-mail/brief.html", "ui://usual-mail/threads.html"]);
    await assert.rejects(client.readResource({ uri: "ui://usual-mail/settings.html" }));
    assert.equal(client.getServerCapabilities()?.prompts, undefined, "no prompts");
  });

  it("never calls a person-only service method across a whole session of tool calls", async () => {
    const { handler, service } = setup();
    const client = await connect(handler, "umt_agent");
    await call(client, "list_inboxes");
    await call(client, "take_triage_batch");
    await call(client, "sort_threads", { decisions: [{ threadId: "thr_16", category: "conversation", reason: "r" }] });
    await call(client, "get_ai_status");
    await call(client, "act_on_threads", { threadIds: ["thr_6"], action: "trash", reason: "r" });
    await call(client, "write_draft", { threadId: "thr_1", body: "b" });
    await call(client, "get_brief");
    assert.deepEqual(
      service.calls.filter((entry) => NEVER_CALLED.includes(entry.method)),
      [],
    );
  });
});

describe("what an agent may change", () => {
  it("never turns a rule on, even when asked to, and a rule a person made is refused by the server", async () => {
    const { handler, service } = setup();
    const client = await connect(handler, "umt_agent");
    const suggested = await call(client, "suggest_rule", {
      inboxId: "inb_northwind",
      text: "Fernhill goes to Receipts",
      match: { domain: "fernhill.example" },
      then: [{ kind: "categorize", category: "receipt" }],
    });
    const ruleId = (suggested.data[0] as { ruleId: string }).ruleId;
    const changed = await call(client, "update_rule", { ruleId, text: "Fernhill receipts go to Receipts", enabled: true });
    assert.equal(changed.isError, false);
    assert.deepEqual(service.callsTo("updateRule")[0]!.args, [ruleId, { text: "Fernhill receipts go to Receipts" }]);
    assert.equal((changed.data[0] as { enabled: boolean }).enabled, false);

    const person = await call(client, "update_rule", { ruleId: "rul_1", text: "Mine now" });
    assert.equal(person.isError, true);
    assert.equal((person.data[0] as { error: string }).error, "needs_person");
    const deleted = await call(client, "delete_rule", { ruleId: "rul_2" });
    assert.equal((deleted.data[0] as { error: string }).error, "needs_person");
    assert.ok(service.rules.some((rule) => rule.id === "rul_2"), "a person's rule stays");
    assert.ok(service.callsTo("updateRule").every((entry) => !("enabled" in (entry.args[1] as object))));
  });

  it("leaves a draft a person wrote alone: the service refuses deleting or changing it", async () => {
    const { handler, service } = setup();
    service.drafts.push({ ...service.drafts[0]!, id: "drf_person", createdBy: { kind: "person", deviceId: "dev_mac" } });
    const client = await connect(handler, "umt_agent");
    const result = await call(client, "delete_draft", { draftId: "drf_person" });
    assert.equal(result.isError, true);
    assert.equal(result.lead, "Needs a person. Nothing was changed.");
    assert.ok(service.drafts.some((draft) => draft.id === "drf_person"));
    const changed = await call(client, "write_draft", { threadId: "thr_1", draftId: "drf_person", body: "Rewritten by an agent" });
    assert.equal(changed.lead, "Needs a person. Nothing was changed.");
    assert.notEqual(service.drafts.find((draft) => draft.id === "drf_person")!.body, "Rewritten by an agent");
  });
});

describe("what an agent sees", () => {
  it("sees only the inboxes its token lists, with agent access on", async () => {
    const { handler, service } = setup();
    const client = await connect(handler, "umt_narrow");
    const inboxes = await call(client, "list_inboxes");
    assert.deepEqual(inboxes.data.map((inbox) => (inbox as { inboxId: string }).inboxId), ["inb_harbor"]);
    const home = await call(client, "list_threads", { view: "conversation" });
    assert.ok(home.data.length > 0);
    assert.ok(home.data.every((thread) => (thread as { inboxId: string }).inboxId === "inb_harbor"));
    assert.equal(home.structured!.singleInbox, true);
    assert.ok(service.calls.every((entry) => entry.caller === undefined || entry.caller === NARROW_AGENT));
  });

  it("sees why an inbox needs attention, with its words, so it can say what fixes it", async () => {
    const { handler, service } = setup();
    const failing = service.inboxes.find((inbox) => inbox.id === "inb_harbor")!;
    Object.assign(failing, { status: "needs_attention", statusDetail: "Connection refused", statusReason: "provider_error" });
    const client = await connect(handler, "umt_agent");
    const inboxes = (await call(client, "list_inboxes")).data as Array<Record<string, unknown>>;
    const harbor = inboxes.find((inbox) => inbox.inboxId === "inb_harbor")!;
    assert.deepEqual([harbor.status, harbor.statusReason, harbor.statusDetail], ["needs_attention", "provider_error", "Connection refused"]);
    const northwind = inboxes.find((inbox) => inbox.inboxId === "inb_northwind")!;
    assert.equal("statusReason" in northwind, false, "only with needs_attention");
  });

  it("gets not_found for another inbox's thread, inbox, rules or brief section", async () => {
    const { handler } = setup();
    const client = await connect(handler, "umt_narrow");
    for (const [name, args] of [
      ["read_thread", { threadId: "thr_1" }],
      ["list_rules", { inboxId: "inb_northwind" }],
      ["update_guide", { inboxId: "inb_northwind", guide: "x" }],
      ["act_on_threads", { threadIds: ["thr_1"], action: "done", reason: "r" }],
      ["write_draft", { threadId: "thr_1", body: "b" }],
    ] as const) {
      const result = await call(client, name, args);
      assert.equal(result.isError, true, name);
      assert.equal((result.data[0] as { error: string }).error, "not_found", name);
    }
    const brief = await call(client, "get_brief");
    const sections = (brief.structured!.brief as { sections: Array<{ inboxId: string }> }).sections;
    assert.deepEqual(sections.map((section) => section.inboxId), ["inb_harbor"]);
    const highlightSubjects = brief.text.includes("Contract renewal");
    assert.equal(highlightSubjects, false);
  });

  it("an inbox whose agent access is off is invisible even when the token lists it", async () => {
    const { handler, service } = setup();
    service.inboxes.find((inbox) => inbox.id === "inb_harbor")!.agentAccess = false;
    const client = await connect(handler, "umt_narrow");
    const inboxes = await call(client, "list_inboxes");
    assert.equal(inboxes.lead, "0 inboxes this agent may see.");
    assert.match(inboxes.next, /turn on its agent access/);
  });
});
