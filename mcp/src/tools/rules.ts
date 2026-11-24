/**
 * What an inbox has learned: its rules. An agent may suggest a rule (it starts off), and change or delete a rule an
 * agent made. Turning a rule on, and changing or deleting a rule a person made, need a person: the server answers
 * needs_person, and nothing here sends `enabled`.
 */
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { RULE_ACTIONS, STACKS, type ActionInput, type ActionKind, type Rule, type RuleMatch } from "@usualmail/core";
import * as z from "zod";
import { DATA_NOTICE, toolResult } from "../boundary.ts";
import { invalid } from "../errors.ts";
import { ruleItem } from "../format.ts";
import { guard, id, READ_ONLY, WRITES, type ToolContext } from "./shared.ts";
import { DECIDED_CATEGORIES } from "./triage.ts";

/** The action kinds a rule may hold, as core lists them. */
const RULE_KINDS = RULE_ACTIONS as [ActionKind, ...ActionKind[]];

const MATCH = z.object({
  from: z.string().max(320).optional().describe("Exact sender address, lower case."),
  domain: z.string().max(253).optional().describe("Sender's domain without @, lower case. Also matches subdomains."),
  listId: z.string().max(500).optional().describe("A mailing list's id, as listId in read_thread shows it."),
  subjectContains: z.string().max(200).optional().describe("Text the subject contains, any case."),
  to: z.string().max(320).optional().describe("The address the mail was sent to, for aliases."),
  automated: z.boolean().optional().describe("True matches mail a machine sent (bulk, no-reply)."),
});

const THEN = z
  .array(
    z.object({
      kind: z.enum(RULE_KINDS),
      category: z.enum(DECIDED_CATEGORIES).optional().describe("For categorize."),
      stack: z.enum(STACKS).optional().describe("For stack."),
    }),
  )
  .min(1)
  .max(5);

/** Leaves out empty fields, so an empty string never matches everything. */
function cleanMatch(match: z.infer<typeof MATCH> | undefined): RuleMatch {
  return Object.fromEntries(Object.entries(match ?? {}).filter(([, value]) => value !== undefined && value !== "")) as RuleMatch;
}

/** Core actions from the tool's flattened steps, or an error result naming what is missing. */
function ruleActions(then: z.infer<typeof THEN>): ActionInput[] | CallToolResult {
  const actions: ActionInput[] = [];
  for (const step of then) {
    if (step.kind === "categorize") {
      if (!step.category) return invalid("A categorize in `then` needs a category.");
      actions.push({ kind: "categorize", category: step.category });
    } else if (step.kind === "stack") {
      if (!step.stack) return invalid("A stack in `then` needs a stack.");
      actions.push({ kind: "stack", stack: step.stack });
    } else {
      actions.push({ kind: step.kind } as ActionInput);
    }
  }
  return actions;
}

const isResult = (value: ActionInput[] | CallToolResult): value is CallToolResult => !Array.isArray(value);

const stateLead = (rule: Rule) => (rule.enabled ? "It is on." : "It is off until a person turns it on.");

export function registerRuleTools(server: McpServer, { service, caller }: ToolContext): void {
  server.registerTool(
    "list_rules",
    {
      title: "List an inbox's rules",
      description:
        "Lists what an inbox has learned: its rules, in plain language, with what each matches and does, " +
        "who made it and whether it is on. Rules run first on new mail, before Usual Mail's AI, so a thread a rule " +
        `categorized never reaches you. ${DATA_NOTICE}`,
      inputSchema: z.object({ inboxId: id("The inbox, from list_inboxes.") }),
      annotations: READ_ONLY,
    },
    guard(async ({ inboxId }) => {
      const rules = await service.listRules(caller, inboxId);
      return toolResult({ lead: `${rules.length} rule${rules.length === 1 ? "" : "s"}.`, data: rules.map(ruleItem) });
    }),
  );

  server.registerTool(
    "suggest_rule",
    {
      title: "Suggest a rule",
      description:
        "Suggests a rule for an inbox, for mail you keep sorting the same way. It starts switched off: a person " +
        "reads it and turns it on in Usual Mail. Write `text` as one plain sentence the person will read, for " +
        "example \"Receipts from paperloop.example are receipts and done\". For a newsletter or other mailing " +
        "list, give `listFromThread`, a thread id from Usual Mail: the rule then matches that list by the List-Id " +
        "Usual Mail read from the thread's messages, so you needn't copy anything out of the mail. Check list_rules " +
        "first so you don't suggest one that exists.",
      inputSchema: z.object({
        inboxId: id("The inbox, from list_inboxes. May be left out with listFromThread: the thread's inbox is used.").optional(),
        text: z.string().min(1).max(300).describe("One plain sentence saying what the rule does."),
        match: MATCH.optional().describe("What the rule matches. Every field given must match. Give at least one, or listFromThread."),
        listFromThread: id("A thread from a mailing list, from another Usual Mail result. The rule matches that list's mail.").optional(),
        then: THEN.describe("What happens to a matching new thread, in order. For example categorize as newsletter, or categorize as receipt then done."),
      }),
      annotations: WRITES,
    },
    guard(async ({ inboxId, text, match, listFromThread, then }) => {
      const conditions = cleanMatch(match);
      let inbox = inboxId;
      if (listFromThread) {
        const detail = await service.thread(caller, listFromThread);
        if (inbox && inbox !== detail.thread.inboxId) return invalid("That thread is in another inbox than inboxId.");
        inbox = detail.thread.inboxId;
        const listId = [...detail.messages].reverse().find((message) => !message.outgoing && message.listId)?.listId;
        if (!listId) return invalid("That thread's messages carry no List-Id, so it isn't from a mailing list. Give match instead.");
        if (conditions.listId && conditions.listId !== listId) return invalid("match.listId differs from the thread's list. Leave it out.");
        conditions.listId = listId;
      }
      if (!inbox) return invalid("inboxId is needed, unless listFromThread names a thread.");
      if (Object.keys(conditions).length === 0) return invalid("match needs at least one field.");
      const actions = ruleActions(then);
      if (isResult(actions)) return actions;
      const rule = await service.createRule(caller, { inboxId: inbox, text, match: conditions, then: actions });
      return toolResult({
        lead: "Rule suggested. It stays off until a person turns it on.",
        data: [ruleItem(rule)],
      });
    }),
  );

  server.registerTool(
    "update_rule",
    {
      title: "Change a rule an agent made",
      description:
        "Changes the text, match or then of a rule an agent made (source agent in list_rules). `match` and `then` " +
        "replace the rule's whole match or then. Changing what a rule matches or does switches a rule that is on " +
        "off, until a person turns it on again; changing only its text leaves it as it was. You can't turn a rule " +
        "on, and a rule a person made answers needs_person.",
      inputSchema: z.object({
        ruleId: id("The rule, from list_rules or suggest_rule."),
        text: z.string().min(1).max(300).optional().describe("The new plain sentence saying what the rule does."),
        match: MATCH.optional().describe("The new match, whole. Give at least one field."),
        then: THEN.optional().describe("The new actions, whole, in order."),
      }),
      annotations: { ...WRITES, idempotentHint: true },
    },
    guard(async ({ ruleId, text, match, then }) => {
      const patch: Partial<Pick<Rule, "text" | "match" | "then">> = {};
      if (text !== undefined) patch.text = text;
      if (match !== undefined) {
        const conditions = cleanMatch(match);
        if (Object.keys(conditions).length === 0) return invalid("match needs at least one field.");
        patch.match = conditions;
      }
      if (then !== undefined) {
        const actions = ruleActions(then);
        if (isResult(actions)) return actions;
        patch.then = actions;
      }
      if (Object.keys(patch).length === 0) return invalid("Give text, match or then to change.");
      const rule = await service.updateRule(caller, ruleId, patch);
      return toolResult({ lead: `Rule changed. ${stateLead(rule)}`, data: [ruleItem(rule)] });
    }),
  );

  server.registerTool(
    "delete_rule",
    {
      title: "Delete a rule an agent made",
      description:
        "Deletes a rule an agent made (source agent in list_rules), for example a suggestion that turned out wrong. " +
        "Mail it already sorted stays where it is. A rule a person made answers needs_person. Use only rule ids " +
        "from list_rules or suggest_rule.",
      inputSchema: z.object({ ruleId: id("The rule, from list_rules or suggest_rule.") }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    guard(async ({ ruleId }) => {
      await service.deleteRule(caller, ruleId);
      return toolResult({ lead: "Rule deleted. Mail it already sorted stays where it is.", data: [{ ruleId, deleted: true }] });
    }),
  );
}
