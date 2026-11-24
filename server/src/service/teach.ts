// Teaching: after a person corrects a thread's category, offer one question and the rule a yes would create.

import { ServiceError, type Caller, type DecidedCategory, type Rule, type RuleMatch, type TeachPrompt } from "@usualmail/core";
import { and, eq, isNull } from "drizzle-orm";
import { teachPrompts, type InboxRow, type MessageRow, type TeachRow, type ThreadRow } from "../db/index.ts";
import { requireInbox, requirePerson } from "./access.ts";
import type { Ctx } from "./context.ts";
import { normalizeListId, ruleMatches, subjectFor } from "./match.ts";
import { toTeach } from "./rows.ts";
import { createRule, firstIncoming, inboxRules, taughtByPerson } from "./rules.ts";
import { CONTROL_CHARACTERS } from "./schemas.ts";
import { CATEGORY_WORDS } from "./state.ts";

const DAY = 24 * 60 * 60_000;

/**
 * A prompt to keep treating this sender's (or list's) mail as `category`, or nothing when no useful rule fits: no
 * sender, or a rule the person taught already says the same for this mail. An older rule or an agent's rule doesn't
 * stop it: the new rule would be checked before them.
 */
export async function offerTeach(
  ctx: Ctx,
  inbox: InboxRow,
  thread: ThreadRow,
  category: DecidedCategory,
  fromActionId: string,
): Promise<TeachPrompt | undefined> {
  const first = await firstIncoming(ctx, thread.id);
  if (first && await alreadyTaught(ctx, inbox.id, first, category)) return undefined;
  // A rule's text and match are single lines (schemas.ts): a list id that isn't one is no match to offer, and a
  // sender's name has its control characters turned into spaces.
  const rawListId = normalizeListId(first?.listId);
  const listId = rawListId && !CONTROL_CHARACTERS.test(rawListId) ? rawListId : null;
  const sender = first?.from.email.toLowerCase() ?? thread.sender;
  if (!listId && !sender) return undefined;

  const words = CATEGORY_WORDS[category];
  const name = first?.from.name?.replace(new RegExp(CONTROL_CHARACTERS.source, "g"), " ").replace(/\s+/g, " ").trim();
  let match: RuleMatch;
  let who: string;
  if (listId) {
    match = { listId };
    who = name || listId;
  } else {
    match = { from: sender! };
    who = name ? `${name} (${sender})` : sender!;
  }
  const row: TeachRow = {
    id: ctx.id("tch"),
    inboxId: inbox.id,
    question: `Always treat mail from ${who} as ${words}?`,
    rule: { inboxId: inbox.id, text: `Mail from ${who} is ${words}`, match, then: [{ kind: "categorize", category }] },
    fromActionId,
    createdAt: ctx.now(),
    expiresAt: ctx.now() + DAY,
    answeredAt: null,
  };
  await ctx.db.insert(teachPrompts).values(row);
  return toTeach(row);
}

/** Whether an enabled rule the person taught matches this mail and already puts it in `category`. */
async function alreadyTaught(ctx: Ctx, inboxId: string, message: MessageRow, category: DecidedCategory): Promise<boolean> {
  const subject = subjectFor(message);
  return (await inboxRules(ctx, inboxId)).some((rule) => rule.enabled && taughtByPerson(rule)
    && ruleMatches(rule.match, subject)
    && rule.then.flatMap((action) => (action.kind === "categorize" ? [action.category] : [])).at(-1) === category);
}

export async function answerTeach(ctx: Ctx, caller: Caller, teachId: string, accept: boolean): Promise<Rule | null> {
  requirePerson(caller, "answer a teach prompt");
  if (typeof accept !== "boolean") throw new ServiceError("invalid", "accept must be true or false");
  const row = await ctx.db.select().from(teachPrompts)
    .where(and(eq(teachPrompts.id, teachId), isNull(teachPrompts.answeredAt))).get();
  if (!row) throw new ServiceError("not_found", "No such question, or it was already answered");
  await requireInbox(ctx, caller, row.inboxId);
  if (row.expiresAt <= ctx.now()) throw new ServiceError("conflict", "This question has expired");
  await ctx.db.update(teachPrompts).set({ answeredAt: ctx.now() }).where(eq(teachPrompts.id, teachId));
  return accept ? createRule(ctx, caller, row.rule, "correction") : null;
}
