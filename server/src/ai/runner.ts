// The AI's queue (docs/contract-ai.md, "What the AI processes, and when"): new mail at once, as it arrives; then
// history in the background, newest first within the history window. One thread at a time. It runs only while the AI
// may send anything (credentials set, not paused, not waiting after a failure); a failure stops it until the wait
// ends, and the threads that were new then become history. While it can't run, a stranger's thread held at the
// screening gate is let go: screened in `unknown` and written back.

import { eq } from "drizzle-orm";
import { inboxes, threads } from "../db/index.ts";
import type { AiQueue, Ctx } from "../service/context.ts";
import type { AiModels } from "./models.ts";
import { processableNow, processThread, releaseGate } from "./process.ts";
import { loadState, mayRun, openCredentials } from "./state.ts";
import { historyBatch } from "./work.ts";

/** Timers longer than this are re-armed, so a sleeping laptop can't drift too far. */
const MAX_TIMER_MS = 6 * 60 * 60_000;

export class AiRunner implements AiQueue {
  readonly #ctx: Ctx;
  readonly #track: (work: Promise<unknown>) => void;
  #urgent: string[] = [];
  #started = false;
  #running = false;
  #again = false;
  #timer: (() => void) | null = null;
  #models: { version: number; models: AiModels } | null = null;

  constructor(ctx: Ctx, track: (work: Promise<unknown>) => void) {
    this.#ctx = ctx;
    this.#track = track;
  }

  /** Starts, first with any stranger's thread still held at the screening gate (a stop left it waiting). */
  start(): void {
    this.#started = true;
    this.#track((async () => {
      const held = await this.#ctx.db.select({ id: threads.id }).from(threads).where(eq(threads.gatePending, true));
      this.enqueue(held.map((row) => row.id));
    })());
  }

  stop(): void {
    this.#started = false;
    this.#timer?.();
    this.#timer = null;
  }

  enqueue(threadIds: string[]): void {
    for (const id of threadIds) if (!this.#urgent.includes(id)) this.#urgent.push(id);
    this.wake();
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
        await this.#drain();
      } while (this.#again && this.#started);
    } finally {
      this.#running = false;
    }
  }

  async #drain(): Promise<void> {
    const ctx = this.#ctx;
    // Each thread at most once a round, so nothing can loop on the service.
    const tried = new Set<string>();
    for (;;) {
      if (!this.#started) return;
      const gate = mayRun(await loadState(ctx), ctx.now());
      if (!gate.ok) {
        // New mail that couldn't be processed is history now.
        this.#urgent = [];
        await ctx.lock.run(() => this.#releaseGates(true));
        this.#arm(gate.retryAt);
        return;
      }
      await ctx.lock.run(() => this.#releaseGates(false));
      const next = await this.#next(tried);
      if (!next) return;
      tried.add(next);
      await processThread(ctx, next, () => this.#open());
    }
  }

  async #next(tried: Set<string>): Promise<string | null> {
    while (this.#urgent.length) {
      const id = this.#urgent.shift()!;
      if (!tried.has(id)) return id;
    }
    if (!this.#ctx.options.aiHistory) return null;
    for (const { id } of await historyBatch(this.#ctx)) if (!tried.has(id)) return id;
    return null;
  }

  /** Models for the stored credentials, opened once per version of the settings. */
  async #open(): Promise<AiModels | null> {
    const ctx = this.#ctx;
    const row = await loadState(ctx);
    if (this.#models?.version === row.settingsVersion) return this.#models.models;
    const credentials = await openCredentials(ctx, row);
    if (!credentials) return null;
    const models = ctx.models.open(credentials);
    this.#models = { version: row.settingsVersion, models };
    return models;
  }

  /**
   * Lets go of threads held at the screening gate that the AI won't answer for: all of them while it can't run, and
   * otherwise those it may not process (their inbox's AI processing is off, or they are done or trashed). Under the
   * lock.
   */
  async #releaseGates(all: boolean): Promise<void> {
    const ctx = this.#ctx;
    const held = await ctx.db.select({ thread: threads, inbox: inboxes }).from(threads)
      .innerJoin(inboxes, eq(inboxes.id, threads.inboxId))
      .where(eq(threads.gatePending, true));
    for (const { thread, inbox } of held) {
      if (all || !processableNow(thread, inbox)) await releaseGate(ctx, thread.id);
    }
  }

  #arm(retryAt: number | null): void {
    this.#timer?.();
    this.#timer = null;
    if (retryAt === null || !this.#started) return;
    const delay = Math.min(Math.max(0, retryAt - this.#ctx.now()), MAX_TIMER_MS);
    this.#timer = this.#ctx.host.scheduler.setTimer(delay, () => {
      this.#timer = null;
      this.wake();
    });
  }
}
