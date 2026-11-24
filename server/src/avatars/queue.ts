// Fetching the sites that are due for sender pictures (docs/contract-avatars.md): one domain at a time, never two at
// once, with at least five seconds between two, at most 500 a day, apart from any mail work. What a fetch finds is
// kept under the lock and the threads that may show it are settled again. Once a day, and at the start, domains no mail
// has wanted for 180 days are forgotten. Without a site icon source (demo mode, tests) nothing is fetched; pictures
// already kept still show.

import type { Ctx } from "../service/context.ts";
import type { SiteIconSource } from "../host.ts";
import { settleDomain } from "./settle.ts";
import { dueSite, forgetUnwanted, recordSite, type SiteIcon } from "./sites.ts";

export const QUEUE_LIMITS = {
  /** The least time between the start of two fetches. */
  gapMs: 5_000,
  /** The most fetches in any 24 hours. */
  perDay: 500,
  /** How often domains no mail wants are forgotten. */
  sweepEveryMs: 24 * 60 * 60_000,
};

const DAY_MS = 24 * 60 * 60_000;
/**
 * The longest timer set: nothing here waits longer (a day's retry, the daily sweep). A timer that fires late after a
 * sleep only fetches later; each round reads the times again.
 */
const MAX_TIMER_MS = DAY_MS;

export class AvatarQueue {
  readonly #ctx: Ctx;
  readonly #source: SiteIconSource | null;
  readonly #track: (work: Promise<unknown>) => void;
  readonly #limits: typeof QUEUE_LIMITS;
  #started = false;
  #running = false;
  #again = false;
  #timer: (() => void) | null = null;
  /** When recent fetches started, oldest first, for the gap and the day's cap. */
  readonly #recent: number[] = [];
  #lastSweep = Number.NEGATIVE_INFINITY;

  constructor(ctx: Ctx, source: SiteIconSource | null, track: (work: Promise<unknown>) => void, limits: Partial<typeof QUEUE_LIMITS> = {}) {
    this.#ctx = ctx;
    this.#source = source;
    this.#track = track;
    this.#limits = { ...QUEUE_LIMITS, ...limits };
  }

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
    } catch (error) {
      this.#ctx.host.log.error(`Sender pictures: a round failed (${error instanceof Error ? error.name : "unknown"})`);
      this.#arm(this.#ctx.now() + 60_000);
    } finally {
      this.#running = false;
    }
  }

  async #round(): Promise<void> {
    const ctx = this.#ctx;
    const now = ctx.now();
    if (now - this.#lastSweep >= this.#limits.sweepEveryMs) {
      this.#lastSweep = now;
      const gone = await ctx.lock.run(() => forgetUnwanted(ctx));
      for (const domain of gone) await ctx.lock.run(() => settleDomain(ctx, domain));
    }
    const sweepAt = this.#lastSweep + this.#limits.sweepEveryMs;
    if (!this.#source) return this.#arm(sweepAt);
    while (this.#recent.length && this.#recent[0]! <= now - DAY_MS) this.#recent.shift();
    const due = await dueSite(ctx);
    if (!("domain" in due)) return this.#arm(Math.min(due.nextAt ?? sweepAt, sweepAt));
    // The day's cap, then the gap: wait for whichever ends last.
    const capAt = this.#recent.length >= this.#limits.perDay ? this.#recent[0]! + DAY_MS : now;
    const gapAt = (this.#recent.at(-1) ?? Number.NEGATIVE_INFINITY) + this.#limits.gapMs;
    const ready = Math.max(capAt, gapAt);
    if (ready > now) return this.#arm(ready);
    this.#recent.push(now);
    // A source never throws; were one to, the domain is recorded as failed, so it can't come round again at once.
    const icon: SiteIcon = await this.#source.fetch(due.domain)
      .catch((): SiteIcon => ({ found: false, kind: "failed", reason: "it couldn't be fetched" }));
    if (!this.#started) return;
    await ctx.lock.run(async () => {
      if (await recordSite(ctx, due.domain, icon)) await settleDomain(ctx, due.domain);
    });
    this.#again = true;
  }

  #arm(at: number): void {
    this.#timer?.();
    this.#timer = null;
    if (!this.#started) return;
    const delay = Math.min(Math.max(0, at - this.#ctx.now()), MAX_TIMER_MS);
    this.#timer = this.#ctx.host.scheduler.setTimer(delay, () => {
      this.#timer = null;
      this.wake();
    });
  }
}
