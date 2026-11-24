// The AI's usage of the person's account (docs/contract-ai.md, "Usage"): one row per UTC hour, job and model, written
// where a request's outcome is known (answered, whatever the server then made of the answer, or failed), and read as
// today, the last 7 days and the last 30 days in the person's time zone. Only what the service reported is counted;
// nothing is estimated. No thread, no mail, no name or address. Kept for 90 days.

import { AI_USAGE_JOBS, AI_USAGE_KEPT_DAYS, ServiceError, type AiUsageJob, type AiUsage, type AiUsageQuery, type AiUsageRow, type Caller } from "@usualmail/core";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { aiCostLookups, aiUsage } from "../db/index.ts";
import { requirePerson } from "../service/access.ts";
import type { Ctx } from "../service/context.ts";
import { iso } from "../util.ts";
import type { AiUsageReport } from "./models.ts";
import { loadState, saveState } from "./state.ts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** The last hour each server dropped old usage in, so it does that at most once an hour. */
const prunedIn = new WeakMap<Ctx, number>();

/**
 * What one request came to: the service answered, reporting what it used and maybe a generation id whose cost the
 * gateway can be asked for later, or the request failed.
 */
export type UsageOutcome = { usage: AiUsageReport; generation?: string | null } | { failed: true };

/** How long after a request its cost is first looked up. */
export const FIRST_LOOKUP_MS = 10_000;

/** Counts one request the server made to the service. Takes the lock: call it outside one. */
export async function recordUsage(ctx: Ctx, job: AiUsageJob, model: string, outcome: UsageOutcome): Promise<void> {
  const now = ctx.now();
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const usage = "usage" in outcome ? outcome.usage : null;
  const input = usage?.inputTokens ?? null;
  const output = usage?.outputTokens ?? null;
  const cost = usage?.costUsd ?? null;
  const row = {
    requests: 1,
    failed: usage ? 0 : 1,
    inputTokens: input ?? 0,
    inputReported: input === null ? 0 : 1,
    outputTokens: output ?? 0,
    outputReported: output === null ? 0 : 1,
    costUsd: cost ?? 0,
    costReported: cost === null ? 0 : 1,
  };
  await ctx.lock.run(async () => {
    await ctx.db.insert(aiUsage).values({ hour, job, model, ...row }).onConflictDoUpdate({
      target: [aiUsage.hour, aiUsage.job, aiUsage.model],
      set: {
        requests: sql`${aiUsage.requests} + ${row.requests}`,
        failed: sql`${aiUsage.failed} + ${row.failed}`,
        inputTokens: sql`${aiUsage.inputTokens} + ${row.inputTokens}`,
        inputReported: sql`${aiUsage.inputReported} + ${row.inputReported}`,
        outputTokens: sql`${aiUsage.outputTokens} + ${row.outputTokens}`,
        outputReported: sql`${aiUsage.outputReported} + ${row.outputReported}`,
        costUsd: sql`${aiUsage.costUsd} + ${row.costUsd}`,
        costReported: sql`${aiUsage.costReported} + ${row.costReported}`,
      },
    });
    // The cost, if the gateway can say it, is looked up apart from the mail work: only the id is kept for that.
    const generation = "usage" in outcome ? outcome.generation : null;
    if (generation && cost === null) {
      await ctx.db.insert(aiCostLookups).values({ generationId: generation, hour, job, model, nextAt: now + FIRST_LOOKUP_MS }).onConflictDoNothing();
    }
    if (prunedIn.get(ctx) !== hour) await prune(ctx, hour);
  });
  if ("usage" in outcome && outcome.generation) ctx.costLookups.wake();
}

/** A looked-up cost, added to the row of the hour, job and model its request counted in. Under the lock. */
export async function addCost(ctx: Ctx, at: { hour: number; job: AiUsageJob; model: string }, costUsd: number): Promise<void> {
  await ctx.db.update(aiUsage)
    .set({ costUsd: sql`${aiUsage.costUsd} + ${costUsd}`, costReported: sql`${aiUsage.costReported} + 1` })
    .where(and(eq(aiUsage.hour, at.hour), eq(aiUsage.job, at.job), eq(aiUsage.model, at.model)));
}

/** At a start: notes when keeping usage began, the first time, and drops hours older than 90 days. Under the lock. */
export async function startUsage(ctx: Ctx): Promise<void> {
  const row = await loadState(ctx);
  if (row.aiUsageSince === null) await saveState(ctx, { aiUsageSince: ctx.now() });
  await prune(ctx, Math.floor(ctx.now() / HOUR_MS) * HOUR_MS);
}

async function prune(ctx: Ctx, hour: number): Promise<void> {
  const before = hour - AI_USAGE_KEPT_DAYS * DAY_MS;
  await ctx.db.delete(aiUsage).where(lt(aiUsage.hour, before));
  await ctx.db.delete(aiCostLookups).where(lt(aiCostLookups.hour, before));
  prunedIn.set(ctx, hour);
}

/** `GET /v1/ai/usage`: today, the last 7 and the last 30 days in the time zone asked for. Person only. */
export async function readUsage(ctx: Ctx, caller: Caller, query: AiUsageQuery): Promise<AiUsage> {
  requirePerson(caller, "see the AI's usage");
  const timeZone = zoneOf(query.tz);
  const now = ctx.now();
  const row = await loadState(ctx);
  const period = async (daysBack: number) => rowsSince(ctx, Math.floor(localMidnight(now, timeZone, daysBack) / HOUR_MS) * HOUR_MS);
  const [today, last7Days, last30Days] = await Promise.all([period(0), period(6), period(29)]);
  return { since: iso(row.aiUsageSince ?? now), timeZone, periods: { today, last7Days, last30Days } };
}

/** The time zone asked for, as `Intl` names it, or UTC. Anything `Intl` doesn't know is `invalid`. */
function zoneOf(tz: string | undefined): string {
  if (tz === undefined || tz === "") return "UTC";
  if (tz.length > 64) throw new ServiceError("invalid", "tz is an IANA time zone, like Europe/Berlin");
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    throw new ServiceError("invalid", "tz is an IANA time zone, like Europe/Berlin");
  }
}

/** How far the zone's wall clock is ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return wall - Math.floor(instant / 1000) * 1000;
}

/** The instant of midnight `daysBack` days before today's, in the zone. Twice, so a change of offset that day holds. */
export function localMidnight(now: number, timeZone: string, daysBack: number): number {
  const local = new Date(now + offsetAt(now, timeZone));
  const wallMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysBack);
  const guess = wallMidnight - offsetAt(wallMidnight, timeZone);
  return wallMidnight - offsetAt(guess, timeZone);
}

async function rowsSince(ctx: Ctx, from: number): Promise<AiUsageRow[]> {
  const sums = await ctx.db.select({
    job: aiUsage.job,
    model: aiUsage.model,
    requests: sql<number>`sum(${aiUsage.requests})`,
    failed: sql<number>`sum(${aiUsage.failed})`,
    inputTokens: sql<number>`sum(${aiUsage.inputTokens})`,
    inputReported: sql<number>`sum(${aiUsage.inputReported})`,
    outputTokens: sql<number>`sum(${aiUsage.outputTokens})`,
    outputReported: sql<number>`sum(${aiUsage.outputReported})`,
    costUsd: sql<number>`sum(${aiUsage.costUsd})`,
    costReported: sql<number>`sum(${aiUsage.costReported})`,
  }).from(aiUsage).where(gte(aiUsage.hour, from)).groupBy(aiUsage.job, aiUsage.model);
  return sums
    .filter((sum) => sum.requests > 0)
    .map((sum): AiUsageRow => {
      const partial = (reported: number) => reported > 0 && reported < sum.requests;
      return {
        job: sum.job,
        model: sum.model,
        requests: sum.requests,
        failed: sum.failed,
        inputTokens: sum.inputReported > 0 ? sum.inputTokens : null,
        outputTokens: sum.outputReported > 0 ? sum.outputTokens : null,
        tokensPartial: partial(sum.inputReported) || partial(sum.outputReported),
        cost: sum.costReported > 0 ? { amount: Math.round(sum.costUsd * 1e8) / 1e8, currency: "USD" } : null,
        costPartial: partial(sum.costReported),
      };
    })
    .sort((a, b) => AI_USAGE_JOBS.indexOf(a.job) - AI_USAGE_JOBS.indexOf(b.job) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}
