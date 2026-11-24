/** Every service error becomes a tool error that says what happened and what to do next. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ServiceError, type ErrorCode } from "@usualmail/core";
import { asServiceError } from "../src/errors.ts";
import { call, connect, setup } from "./helpers.ts";

const NEXT: Record<ErrorCode, RegExp> = {
  not_found: /wasn't given/,
  needs_person: /Only a person can do this/,
  invalid: /Fix the arguments/,
  conflict: /read_thread/,
  forbidden: /Don't retry/,
  unauthorized: /new token/,
  rate_limited: /Wait a minute/,
  provider_error: /Try again later/,
  internal: /Try again later/,
};

describe("service errors", () => {
  for (const code of Object.keys(NEXT) as ErrorCode[]) {
    it(`turns ${code} into a tool error with a next step`, async () => {
      const { handler, service } = setup();
      const client = await connect(handler, "umt_agent");
      service.failNext("thread", code, `Message for ${code}.`);
      const result = await call(client, "read_thread", { threadId: "thr_1" });
      assert.equal(result.isError, true);
      assert.match(result.next, NEXT[code]);
      const message = code === "internal" ? "Internal error." : `Message for ${code}.`;
      assert.deepEqual(result.data, [{ error: code, message }]);
      assert.doesNotMatch(result.lead, /Message for/, "the service's words stay inside the data block");
    });
  }

  it("says how long to wait when the server gives a wait with rate_limited", async () => {
    const { handler, service } = setup();
    const client = await connect(handler, "umt_agent");
    service.failNext("thread", new ServiceError("rate_limited", "Slow down.", { retryAfter: 42 }));
    const result = await call(client, "read_thread", { threadId: "thr_1" });
    assert.equal(result.next, "Wait 42 seconds, then try again.");
    assert.deepEqual(result.data, [{ error: "rate_limited", message: "Slow down." }]);
    const foreign = Object.assign(new Error("x"), { name: "ServiceError", code: "rate_limited", retryAfter: 1.2 });
    assert.deepEqual(asServiceError(foreign), { code: "rate_limited", message: "x", retryAfter: 2 });
    assert.equal(asServiceError(Object.assign(new Error("x"), { name: "ServiceError", code: "rate_limited", retryAfter: "soon" }))!.retryAfter, undefined);
  });

  it("never shows the text of an unexpected error", async () => {
    const { handler, service } = setup();
    const client = await connect(handler, "umt_agent");
    service.failNext("listInboxes", new Error("SQLITE_BUSY at /var/lib/usual-mail/usual-mail.db"));
    const result = await call(client, "list_inboxes");
    assert.equal(result.isError, true);
    assert.deepEqual(result.data, [{ error: "internal", message: "Internal error." }]);
    assert.doesNotMatch(result.text, /SQLITE|var\/lib/);
  });

  it("recognises a ServiceError thrown by another copy of core", () => {
    class ServiceError extends Error {
      code = "conflict";
      override name = "ServiceError";
    }
    assert.deepEqual(asServiceError(new ServiceError("changed")), { code: "conflict", message: "changed" });
    assert.equal(asServiceError({ name: "ServiceError", code: "made_up", message: "x" }), undefined);
    assert.equal(asServiceError("boom"), undefined);
  });

  it("reports arguments the schema refuses as a tool error, not a protocol error", async () => {
    const { handler, service } = setup();
    const client = await connect(handler, "umt_agent");
    const result = await call(client, "act_on_threads", { threadIds: [], action: "explode", reason: "" });
    assert.equal(result.isError, true);
    assert.match(result.text, /threadIds|action|reason/);
    assert.equal(service.callsTo("act").length, 0);
  });

  it("turns a service error into a tool error in every tool", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["list_inboxes", {}, "listInboxes"],
      ["update_guide", { inboxId: "inb_harbor", guide: "g" }, "updateInbox"],
      ["list_rules", { inboxId: "inb_harbor" }, "listRules"],
      ["suggest_rule", { inboxId: "inb_harbor", text: "t", match: { from: "a@b.example" }, then: [{ kind: "done" }] }, "createRule"],
      ["suggest_rule", { text: "t", listFromThread: "thr_4", then: [{ kind: "done" }] }, "thread"],
      ["update_rule", { ruleId: "rul_4", text: "t" }, "updateRule"],
      ["delete_rule", { ruleId: "rul_4" }, "deleteRule"],
      ["take_triage_batch", {}, "triageQueue"],
      ["sort_threads", { decisions: [{ threadId: "thr_16", category: "conversation", reason: "r" }] }, "decide"],
      ["get_ai_status", {}, "aiStatus"],
      ["read_thread", { threadId: "thr_1" }, "thread"],
      ["search_threads", { q: "x" }, "search"],
      ["list_threads", {}, "home"],
      ["act_on_threads", { threadIds: ["thr_1"], action: "done", reason: "r" }, "act"],
      ["undo_action", { actionId: "act_1" }, "undo"],
      ["list_handled", {}, "handled"],
      ["write_draft", { threadId: "thr_1", body: "b" }, "saveDraft"],
      ["list_drafts", {}, "listDrafts"],
      ["delete_draft", { draftId: "drf_1" }, "deleteDraft"],
      ["write_brief", { from: "2026-11-15T00:00:00Z", to: "2026-11-16T00:00:00Z", sections: [{ inboxId: "inb_harbor" }] }, "writeBrief"],
      ["get_brief", {}, "latestBrief"],
    ];
    const { handler, service } = setup();
    const client = await connect(handler, "umt_agent");
    for (const [name, args, method] of cases) {
      service.failNext(method, "conflict", "Changed meanwhile.");
      const result = await call(client, name, args);
      assert.equal(result.isError, true, name);
      assert.deepEqual(result.data, [{ error: "conflict", message: "Changed meanwhile." }], name);
      assert.equal(result.lead, "Conflict. Nothing was changed.", name);
    }
  });
});
