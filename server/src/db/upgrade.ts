// What migration 0004 can't rewrite in SQL alone: the thread states records keep for undo, and rules' and teach
// prompts' actions, from a store of the fourth revision (piles). Runs at every start and touches only rows that still
// hold the old shapes (docs/contract-sync.md, "Earlier revisions' piles"): a pile becomes its category (people
// conversation, reads newsletter, receipts receipt; screening is screened in unknown), the triage state becomes who
// decided the category, a `move` becomes a `categorize`, and a move into screening, which has none, leaves its rule;
// a rule left with no action is switched off.

import type { ActionInput, Category, CategorySource } from "@usualmail/core";
import { eq, like, sql } from "drizzle-orm";
import { actions, rules, teachPrompts } from "./index.ts";
import type { Ctx } from "../service/context.ts";
import type { Before, ThreadState } from "../service/state.ts";

const PILE_CATEGORY: Record<string, Category> = { people: "conversation", reads: "newsletter", receipts: "receipt", screening: "unknown" };
const TRIAGE_SOURCE: Record<string, CategorySource | null> = { by_rule: "rule", by_agent: "agent", by_person: "person", pending: null };

type LegacyState = Omit<ThreadState, "category" | "categorizedBy" | "screened" | "summary"> & { pile?: string; triage?: string };
type LegacyAction = ActionInput | { kind: "move"; pile: string };

/** A thread state from before the fifth revision, in today's shape. Nobody had decided a pending thread: it is unknown. */
export function upgradeState(state: ThreadState | LegacyState): ThreadState {
  if (!("pile" in state) || state.pile === undefined) return state as ThreadState;
  const { pile, triage, ...rest } = state as LegacyState;
  const categorizedBy = TRIAGE_SOURCE[triage ?? "pending"] ?? null;
  return {
    ...rest,
    category: categorizedBy === null ? "unknown" : PILE_CATEGORY[pile!] ?? "unknown",
    categorizedBy,
    screened: pile === "screening",
    screenedByMailbox: false,
    summary: null,
  };
}

/** A rule's or prompt's actions in today's shape: a move becomes a categorize, a move into screening goes. */
export function upgradeActions(list: LegacyAction[]): ActionInput[] {
  return list.flatMap((action): ActionInput[] => {
    if (action.kind !== "move") return [action as ActionInput];
    const category = PILE_CATEGORY[(action as { pile: string }).pile];
    return category && category !== "unknown" ? [{ kind: "categorize", category }] : [];
  });
}

export async function upgradeStore(ctx: Ctx): Promise<void> {
  const old = await ctx.db.select({ id: actions.id, before: actions.before }).from(actions).where(like(sql`${actions.before}`, '%"pile"%'));
  for (const row of old) {
    const before: Before = {
      ...row.before,
      threads: row.before.threads.map((entry) => ({
        ...entry,
        state: upgradeState(entry.state),
        ...(entry.after && { after: upgradeState(entry.after) }),
      })),
    };
    await ctx.db.update(actions).set({ before }).where(eq(actions.id, row.id));
  }
  const oldRules = await ctx.db.select().from(rules).where(like(sql`${rules.then}`, '%"move"%'));
  for (const rule of oldRules) {
    const then = upgradeActions(rule.then as LegacyAction[]);
    await ctx.db.update(rules).set({
      then,
      ...(then.length === 0 && { enabled: false }),
      version: rule.version + 1,
    }).where(eq(rules.id, rule.id));
  }
  const prompts = await ctx.db.select().from(teachPrompts).where(like(sql`${teachPrompts.rule}`, '%"move"%'));
  for (const prompt of prompts) {
    const then = upgradeActions(prompt.rule.then as LegacyAction[]);
    if (then.length === 0) await ctx.db.delete(teachPrompts).where(eq(teachPrompts.id, prompt.id));
    else await ctx.db.update(teachPrompts).set({ rule: { ...prompt.rule, then } }).where(eq(teachPrompts.id, prompt.id));
  }
}
