// Routes for an inbox's rules: the page, adding a rule, turning one on or off, and deleting one.
import type { ActionInput, DecidedCategory, RuleDraft, RuleMatch, Stack } from "@usualmail/core";
import { STACKS } from "@usualmail/core";
import type { Hono } from "hono";
import { messageOf, safePath, statusOf, text, texts, type Deps, type Env, type Form } from "../http/context.ts";
import { notFoundPage } from "../pages/errors.ts";
import { rulesPage, type RuleFormValues, type RulesPageOptions } from "../pages/rules.ts";
import { showHome } from "./home.ts";
import { attempt, callerOf, doneOf, findInbox, formOf, go, render, viewOf, type Ctx } from "./shared.ts";
import { DECIDED_CATEGORIES } from "../view/words.ts";

const MAX_TEXT = 200;

const isCategory = (value: string): value is DecidedCategory => (DECIDED_CATEGORIES as string[]).includes(value);
const isStack = (value: string): value is Stack => (STACKS as readonly string[]).includes(value);

/** Reads the add-a-rule form into a draft, or says what is missing. */
export function readRuleForm(form: Form, inboxId: string): {
  values: RuleFormValues;
  errors: Partial<Record<string, string>>;
  draft?: RuleDraft;
} {
  const on = (name: string) => texts(form, name).includes("on");
  const category = text(form, "category");
  const stack = text(form, "stack");
  const values: RuleFormValues = {
    text: text(form, "text").trim(),
    from: text(form, "from").trim().toLowerCase(),
    domain: text(form, "domain").trim().toLowerCase().replace(/^@+/, ""),
    listId: text(form, "listId").trim(),
    subjectContains: text(form, "subjectContains").trim(),
    to: text(form, "to").trim().toLowerCase(),
    automated: on("automated"),
    category: isCategory(category) ? category : "",
    stack: isStack(stack) ? stack : "",
    read: on("read"),
    done: on("done"),
    allowSender: on("allowSender"),
    blockSender: on("blockSender"),
    trash: on("trash"),
  };

  const match: RuleMatch = {};
  if (values.from) match.from = values.from;
  if (values.domain) match.domain = values.domain;
  if (values.listId) match.listId = values.listId;
  if (values.subjectContains) match.subjectContains = values.subjectContains;
  if (values.to) match.to = values.to;
  if (values.automated) match.automated = true;

  // Applied in order: let in first, then its category, then flags, and the two that always wait for a person last.
  const then: ActionInput[] = [];
  if (values.allowSender) then.push({ kind: "allow_sender" });
  if (values.category) then.push({ kind: "categorize", category: values.category });
  if (values.stack) then.push({ kind: "stack", stack: values.stack });
  if (values.read) then.push({ kind: "read" });
  if (values.done) then.push({ kind: "done" });
  if (values.blockSender) then.push({ kind: "block_sender" });
  if (values.trash) then.push({ kind: "trash" });

  const errors: Partial<Record<string, string>> = {};
  if (!values.text || values.text.length > MAX_TEXT) errors.text = `Write the rule in up to ${MAX_TEXT} characters.`;
  if (!Object.keys(match).length) errors.match = "Fill in at least one, or the rule would match every message.";
  if (!then.length) errors.then = "Choose what the rule does.";
  else if (values.stack && values.done) errors.then = "A thread on a stack is never done: choose one of the two.";

  const ok = Object.keys(errors).length === 0;
  return { values, errors, draft: ok ? { inboxId, text: values.text, match, then } : undefined };
}

export function ruleRoutes(app: Hono<Env>, deps: Deps): void {
  const { service } = deps;

  async function showRules(c: Ctx, inboxId: string, o: RulesPageOptions = {}, status: Parameters<typeof render>[2] = 200) {
    const caller = callerOf(c);
    const { inbox } = await findInbox(deps, caller, inboxId);
    if (!inbox) return render(c, notFoundPage(viewOf(c), true, "This inbox isn't on this server."), 404);
    return render(c, rulesPage(viewOf(c), inbox, await service.listRules(caller, inbox.id), o), status);
  }

  /** Where a rule's form returns to: Home or the inbox's rules page. */
  const back = (form: Form) => {
    const inboxId = text(form, "inbox");
    const fallback = `/inboxes/${encodeURIComponent(inboxId)}/rules`;
    const path = safePath(text(form, "return"), fallback);
    return { inboxId, path: path === "/" ? "/" : fallback };
  };

  const showError = (c: Ctx, where: { inboxId: string; path: string }, message: string, status: Parameters<typeof render>[2]) =>
    where.path === "/" ? showHome(c, deps, { error: message }, status) : showRules(c, where.inboxId, { error: message }, status);

  app.get("/inboxes/:id/rules", (c) => showRules(c, c.req.param("id"), { done: doneOf(c) }));

  app.post("/inboxes/:id/rules", async (c) => {
    const inboxId = c.req.param("id");
    const read = readRuleForm(formOf(c), inboxId);
    if (!read.draft) {
      return showRules(c, inboxId, { values: read.values, errors: read.errors, error: "The rule needs a look." }, 400);
    }
    const draft = read.draft;
    const outcome = await attempt(() => service.createRule(callerOf(c), draft, "person"));
    if (!outcome.ok) return showRules(c, inboxId, { values: read.values, error: messageOf(outcome.error) }, statusOf(outcome.error));
    return go(c, deps, `/inboxes/${encodeURIComponent(inboxId)}/rules`, "rule-added");
  });

  app.post("/rules/:id/enable", async (c) => {
    const form = formOf(c);
    const where = back(form);
    const enabled = text(form, "enabled") === "on";
    const outcome = await attempt(() => service.updateRule(callerOf(c), c.req.param("id"), { enabled }));
    if (!outcome.ok) return showError(c, where, messageOf(outcome.error), statusOf(outcome.error));
    return go(c, deps, where.path, enabled ? "rule-on" : "rule-off");
  });

  app.post("/rules/:id/delete", async (c) => {
    const where = back(formOf(c));
    const outcome = await attempt(() => service.deleteRule(callerOf(c), c.req.param("id")));
    if (!outcome.ok) return showError(c, where, messageOf(outcome.error), statusOf(outcome.error));
    return go(c, deps, where.path, "rule-deleted");
  });
}
