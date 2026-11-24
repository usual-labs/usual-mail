// How many threads each list holds, per inbox (docs/contract.md, "Lists"). Each count uses the list's own condition
// (lists.ts), so it is always the length of that list.

import { CATEGORIES, STACKS, type Caller, type Category, type Counts, type InboxCounts, type ThreadCounts } from "@usualmail/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { inboxes, threads } from "../db/index.ts";
import { canSee } from "./access.ts";
import type { Ctx } from "./context.ts";
import { categoryListed, homeWhere, screeningWhere, stackWhere, visible, waitingWhere } from "./lists.ts";

function zero(): ThreadCounts {
  return {
    home: 0,
    unread: 0,
    categories: Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<Category, number>,
    stacks: { reply_later: 0, set_aside: 0 },
    waiting: 0,
    screened: 0,
  };
}

const count = (where: unknown) => sql<number>`coalesce(sum(case when ${where} then 1 else 0 end), 0)`;

/** Every inbox's counts, in the inbox list's order. */
export async function computeCounts(ctx: Ctx): Promise<InboxCounts[]> {
  const now = ctx.now();
  const order = await ctx.db.select({ id: inboxes.id }).from(inboxes).orderBy(asc(inboxes.position), asc(inboxes.id));
  const rows = await ctx.db.select({
    inboxId: threads.inboxId,
    category: threads.category,
    home: count(homeWhere(now)),
    unread: count(and(homeWhere(now), eq(threads.unread, true))),
    // Grouped by category, this is each category's list (`categoryWhere`): not screened, done or waiting.
    listed: count(categoryListed(now)),
    replyLater: count(stackWhere("reply_later")),
    setAside: count(stackWhere("set_aside")),
    waiting: count(waitingWhere(now)),
    screened: count(screeningWhere()),
  }).from(threads).where(visible()).groupBy(threads.inboxId, threads.category);
  const byInbox = new Map(order.map((row) => [row.id, { inboxId: row.id, ...zero() } as InboxCounts]));
  for (const row of rows) {
    const counts = byInbox.get(row.inboxId);
    if (!counts) continue;
    counts.home += row.home;
    counts.unread += row.unread;
    counts.categories[row.category] += row.listed;
    counts.stacks.reply_later += row.replyLater;
    counts.stacks.set_aside += row.setAside;
    counts.waiting += row.waiting;
    counts.screened += row.screened;
  }
  return [...byInbox.values()];
}

/** The counts a caller may see: only their inboxes, and `all` as the sum of those. */
export function countsFor(ctx: Ctx, caller: Caller, inboxCounts: InboxCounts[], version: number): Counts {
  return totalCounts(inboxCounts.filter((entry) => canSee(ctx, caller, entry.inboxId)), version);
}

/** These inboxes' counts with `all` as their sum. */
export function totalCounts(inboxCounts: InboxCounts[], version: number): Counts {
  const all = zero();
  for (const entry of inboxCounts) {
    all.home += entry.home;
    all.unread += entry.unread;
    for (const category of CATEGORIES) all.categories[category] += entry.categories[category];
    for (const stack of STACKS) all.stacks[stack] += entry.stacks[stack];
    all.waiting += entry.waiting;
    all.screened += entry.screened;
  }
  return { all, inboxes: structuredClone(inboxCounts), version };
}
