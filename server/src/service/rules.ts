// Rules: what each inbox has learned. Rules a person taught are checked first, newest first, then rules an
// agent made, newest first; the first enabled rule that matches new mail is applied. Every change raises the
// rule's version and sends `rule.changed`; a deletion sends `rule.removed`.

import { ServiceError, type Caller, type Rule, type RuleDraft, type RuleSource } from "@usualmail/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { messages, rules, type ActionRow, type InboxRow, type MessageRow, type RuleRow, type ThreadRow } from "../db/index.ts";
import { inList } from "../db/params.ts";
import { isPerson, requireInbox } from "./access.ts";
import { perform } from "./actions.ts";
import type { Ctx } from "./context.ts";
import { ruleMatches, subjectFor } from "./match.ts";
import { toRule } from "./rows.ts";
import { check, RuleDraftSchema, RulePatchSchema } from "./schemas.ts";
import { decidedBy } from "./state.ts";
import { emitThread, getThread, saveThreadState, threadState } from "./store.ts";

/** An inbox's rules in the order they were made, which is how they are listed. */
export async function inboxRules(ctx: Ctx, inboxId: string): Promise<RuleRow[]> {
  return ctx.db.select().from(rules).where(eq(rules.inboxId, inboxId)).orderBy(asc(rules.createdAt), asc(rules.id));
}

/** Rules a person taught: made by a person, or a correction they agreed to. */
export function taughtByPerson(rule: Pick<RuleRow, "source">): boolean {
  return rule.source === "person" || rule.source === "correction";
}

/** The order rules are checked in: what a person taught first, newest first; then agents' rules, newest first. */
export function checkOrder(list: RuleRow[]): RuleRow[] {
  const newestFirst = (a: RuleRow, b: RuleRow) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  return [...list.filter(taughtByPerson).sort(newestFirst), ...list.filter((rule) => !taughtByPerson(rule)).sort(newestFirst)];
}

/** The first enabled rule, in checking order, that matches this message. */
export async function firstMatch(ctx: Ctx, inboxId: string, message: MessageRow): Promise<RuleRow | undefined> {
  const subject = subjectFor(message);
  return checkOrder(await inboxRules(ctx, inboxId)).find((rule) => rule.enabled && ruleMatches(rule.match, subject));
}

/** The thread's first incoming message: what rules and screening look at. */
export async function firstIncoming(ctx: Ctx, threadId: string): Promise<MessageRow | undefined> {
  return ctx.db.select().from(messages).where(and(eq(messages.threadId, threadId), eq(messages.outgoing, false)))
    .orderBy(asc(messages.date), asc(messages.id)).limit(1).get();
}

/**
 * Applies a rule's actions to a new thread, in order: a rule the person taught always applies, an agent's rule under
 * the inbox's trust. Its hits and version rise; the
 * caller sends `rule.changed` once for the whole batch of new mail (`emitRules`). The thread's reason is the rule's
 * text; when the rule sets or proposes a category, the rule decided it. Returns whether it did.
 */
export async function applyRule(ctx: Ctx, inbox: InboxRow, thread: ThreadRow, rule: RuleRow): Promise<{ records: ActionRow[]; decidedCategory: boolean }> {
  const records: ActionRow[] = [];
  const actor = { kind: "rule" as const, ruleId: rule.id };
  for (const action of rule.then) {
    const current = await getThread(ctx, thread.id);
    if (!current || current.trashed) break;
    const record = await perform(ctx, { inbox, thread: current, action, actor, reason: rule.text, taught: taughtByPerson(rule) });
    if (record && !records.some((r) => r.id === record.id)) records.push(record);
  }
  await ctx.db.update(rules).set({ hits: sql`${rules.hits} + 1`, version: sql`${rules.version} + 1` }).where(eq(rules.id, rule.id));
  // Also when every action was already true of the thread: the rule sorted it.
  const decidedCategory = rule.then.some((action) => action.kind === "categorize");
  const after = await getThread(ctx, thread.id);
  if (after) {
    const state = await threadState(ctx, after);
    const saved = await saveThreadState(ctx, after.id, { ...state, reason: rule.text, ...(decidedCategory && decidedBy(actor)) });
    if (saved.version !== after.version) emitThread(ctx, saved);
  }
  return { records, decidedCategory };
}

/** Sends `rule.changed` for each of these rules as it is now: once per batch of new mail they sorted. */
export async function emitRules(ctx: Ctx, ids: Iterable<string>): Promise<void> {
  const list = [...new Set(ids)];
  if (list.length === 0) return;
  const rows = await ctx.db.select().from(rules).where(inList(rules.id, list)).orderBy(asc(rules.createdAt), asc(rules.id));
  for (const row of rows) ctx.emit({ type: "rule.changed", rule: toRule(row) });
}

// --- The service's rule methods ----------------------------------------------------------------------------

export async function listRules(ctx: Ctx, caller: Caller, inboxId: string): Promise<Rule[]> {
  await requireInbox(ctx, caller, inboxId);
  return (await inboxRules(ctx, inboxId)).map(toRule);
}

/**
 * A rule a person makes is on at once, with source "person" unless they say otherwise. A rule an agent makes
 * always has source "agent" and starts off: only a person turns a rule on.
 */
export async function createRule(ctx: Ctx, caller: Caller, input: RuleDraft, source?: RuleSource): Promise<Rule> {
  const draft = check(RuleDraftSchema, input, "Rule");
  await requireInbox(ctx, caller, draft.inboxId);
  const person = isPerson(caller);
  const row: RuleRow = {
    id: ctx.id("rul"),
    inboxId: draft.inboxId,
    text: draft.text,
    match: draft.match,
    then: draft.then,
    source: person ? source ?? "person" : "agent",
    enabled: person,
    hits: 0,
    createdBy: caller.actor,
    createdAt: ctx.now(),
    version: 1,
  };
  await ctx.db.insert(rules).values(row);
  const rule = toRule(row);
  ctx.emit({ type: "rule.changed", rule });
  return rule;
}

async function requireRule(ctx: Ctx, caller: Caller, id: string): Promise<RuleRow> {
  const row = await ctx.db.select().from(rules).where(eq(rules.id, id)).get();
  if (!row) throw new ServiceError("not_found", "No such rule");
  try {
    await requireInbox(ctx, caller, row.inboxId);
  } catch {
    throw new ServiceError("not_found", "No such rule");
  }
  if (!isPerson(caller) && row.source !== "agent") {
    throw new ServiceError("needs_person", "Only a person can change or delete a rule a person taught");
  }
  return row;
}

/**
 * An agent may change only rules an agent made, and may switch one off but not on. When an agent changes what
 * an enabled rule matches or does, the rule switches off until a person turns it on again.
 */
export async function updateRule(
  ctx: Ctx,
  caller: Caller,
  id: string,
  input: Partial<Pick<Rule, "text" | "match" | "then" | "enabled">>,
): Promise<Rule> {
  const patch = check(RulePatchSchema, input, "Rule change");
  const row = await requireRule(ctx, caller, id);
  const person = isPerson(caller);
  if (!person && patch.enabled === true && !row.enabled) throw new ServiceError("needs_person", "Only a person can turn a rule on");
  const next: RuleRow = {
    ...row,
    ...(patch.text !== undefined && { text: patch.text }),
    ...(patch.match !== undefined && { match: patch.match }),
    ...(patch.then !== undefined && { then: patch.then }),
    ...(patch.enabled !== undefined && { enabled: patch.enabled }),
  };
  const rewritten = JSON.stringify([next.match, next.then]) !== JSON.stringify([row.match, row.then]);
  if (!person && rewritten) next.enabled = false;
  // A change that changes nothing raises nothing.
  if (next.text === row.text && !rewritten && next.enabled === row.enabled) return toRule(row);
  next.version = row.version + 1;
  await ctx.db.update(rules).set({ text: next.text, match: next.match, then: next.then, enabled: next.enabled, version: next.version })
    .where(eq(rules.id, id));
  const rule = toRule(next);
  ctx.emit({ type: "rule.changed", rule });
  return rule;
}

export async function deleteRule(ctx: Ctx, caller: Caller, id: string): Promise<void> {
  const row = await requireRule(ctx, caller, id);
  await ctx.db.delete(rules).where(eq(rules.id, id));
  ctx.emit({ type: "rule.removed", ruleId: id, inboxId: row.inboxId });
}
