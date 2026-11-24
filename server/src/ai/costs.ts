// Looking up the cost of the AI's requests at Vercel's AI Gateway (docs/contract-ai.md, "Usage"). No AI service puts a
// cost in its answer; the gateway gives one generation's cost through a separate lookup by its id. So after a request
// that came back with a generation id, the id waits in `ai_cost_lookups` (with the hour, job and model it counted in,
// and nothing else) and is looked up apart from the mail work, a little later: a lookup never delays or fails a
// categorize or a summary. One that fails or isn't ready is tried again with growing pauses, then given up, and that
// request's cost stays unreported. Lookups aren't requests in the usage, send only the id with the key, and run only
// while the AI may send anything (a key set, not paused, not in a failure's wait). Without a key, or with a service
// that has no lookups, what waits is dropped.

import { asc, eq, lte, min } from "drizzle-orm";
import { aiCostLookups } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { loadState, mayRun, openCredentials } from "./state.ts";
import { addCost } from "./usage.ts";

/** The pause before each try after the first (which comes 10 seconds after the request): 5 tries in about 2.5 hours. */
const RETRY_PAUSES_MS = [60_000, 5 * 60_000, 30 * 60_000, 120 * 60_000];
export const MOST_TRIES = RETRY_PAUSES_MS.length + 1;
/** Timers longer than this are re-armed, so a sleeping laptop can't drift too far. */
const MAX_TIMER_MS = 6 * 60 * 60_000;
/** How many lookups one round makes, so a long wait never blocks a stop for long. */
const BATCH = 20;

export class CostLookups {
  readonly #ctx: Ctx;
  readonly #track: (work: Promise<unknown>) => void;
  #started = false;
  #running = false;
  #again = false;
  #timer: (() => void) | null = null;

  constructor(ctx: Ctx, track: (work: Promise<unknown>) => void) {
    this.#ctx = ctx;
    this.#track = track;
  }

  /** Starts with whatever waited when the server stopped. */
  start(): void {
    this.#started = true;
    this.wake();
  }

  stop(): void {
    this.#started = false;
    this.#timer?.();
    this.#timer = null;
  }

  wake(): void {
    if (!this.#started) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    this.#track(this.#loop());
  }

  async #loop(): Promise<void> {
    try {
      do {
        this.#again = false;
        await this.#round();
      } while (this.#again && this.#started);
    } finally {
      this.#running = false;
    }
  }

  async #round(): Promise<void> {
    const ctx = this.#ctx;
    const row = await loadState(ctx);
    if (row.aiCredentials === null) {
      // No key: nothing more goes to the service, ids included. Those costs stay unreported.
      await ctx.lock.run(() => ctx.db.delete(aiCostLookups));
      return this.#arm(null);
    }
    const gate = mayRun(row, ctx.now());
    if (!gate.ok) return this.#arm(gate.retryAt);
    const credentials = await openCredentials(ctx, row);
    const models = credentials ? ctx.models.open(credentials) : null;
    if (!models?.lookupCost) {
      await ctx.lock.run(() => ctx.db.delete(aiCostLookups));
      return this.#arm(null);
    }
    const due = await ctx.db.select().from(aiCostLookups)
      .where(lte(aiCostLookups.nextAt, ctx.now()))
      .orderBy(asc(aiCostLookups.nextAt), asc(aiCostLookups.generationId)).limit(BATCH);
    let givenUp = 0;
    for (const lookup of due) {
      if (!this.#started) return;
      let cost: number | null = null;
      try {
        cost = await models.lookupCost(lookup.generationId);
      } catch {
        // Not found yet, refused or unreachable: the same answer for all, tried again later.
      }
      await ctx.lock.run(async () => {
        if (cost !== null) {
          await addCost(ctx, lookup, cost);
          await ctx.db.delete(aiCostLookups).where(eq(aiCostLookups.generationId, lookup.generationId));
          return;
        }
        const tries = lookup.tries + 1;
        if (tries >= MOST_TRIES) {
          givenUp += 1;
          await ctx.db.delete(aiCostLookups).where(eq(aiCostLookups.generationId, lookup.generationId));
          return;
        }
        await ctx.db.update(aiCostLookups)
          .set({ tries, nextAt: ctx.now() + RETRY_PAUSES_MS[tries - 1]! })
          .where(eq(aiCostLookups.generationId, lookup.generationId));
      });
    }
    // No id, no content: how many requests' costs stay unreported.
    if (givenUp) ctx.host.log.info(`AI cost lookup given up after ${MOST_TRIES} tries: no cost for ${givenUp} request${givenUp === 1 ? "" : "s"}`);
    if (due.length === BATCH) this.#again = true;
    const next = await ctx.db.select({ at: min(aiCostLookups.nextAt) }).from(aiCostLookups).get();
    this.#arm(next?.at ?? null);
  }

  #arm(at: number | null): void {
    this.#timer?.();
    this.#timer = null;
    if (at === null || !this.#started) return;
    const delay = Math.min(Math.max(0, at - this.#ctx.now()), MAX_TIMER_MS);
    this.#timer = this.#ctx.host.scheduler.setTimer(delay, () => {
      this.#timer = null;
      this.wake();
    });
  }
}
