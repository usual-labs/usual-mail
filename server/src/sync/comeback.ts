// Come back: a thread waits out of Now until its time, then sorts at the top of Now by that time. The time stays
// on the thread after it passes, so nothing in the store changes when it comes except the version (not the
// revision, so it ends no undo); an event goes out and the thread goes back into the provider's inbox. Which
// times have been announced is stored, so a time that passed while the server was stopped is announced at the
// next start. Callers hold `ctx.lock`.

import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { threads, type ThreadRow } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { announceComeBack, emitThread } from "../service/store.ts";

/** Threads whose come-back time has passed by `until` and not been announced: each gets a new version and an event. */
export async function announceComeBacks(ctx: Ctx, until: number): Promise<ThreadRow[]> {
  const due = await ctx.db.select({ id: threads.id }).from(threads).where(and(
    isNotNull(threads.comeBackAt),
    lte(threads.comeBackAt, until),
    eq(threads.comeBackAnnounced, false),
    eq(threads.trashed, false),
    eq(threads.removed, false),
  ));
  const out: ThreadRow[] = [];
  for (const { id } of due) {
    const row = await announceComeBack(ctx, id);
    emitThread(ctx, row);
    out.push(row);
  }
  return out;
}

/** The soonest come-back time not yet announced, if any. */
export async function nextComeBack(ctx: Ctx): Promise<number | null> {
  const row = await ctx.db.select({ at: threads.comeBackAt }).from(threads).where(and(
    isNotNull(threads.comeBackAt),
    eq(threads.comeBackAnnounced, false),
    eq(threads.trashed, false),
    eq(threads.removed, false),
  )).orderBy(asc(threads.comeBackAt)).limit(1).get();
  return row?.at ?? null;
}
