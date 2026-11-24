// Counts, the AI's status and the triage queues as clients copy them. Each change raises a version (kept in the
// store, so it never goes back after a restart), and clients hear the latest at most once a second:
// `counts.changed` (each receiver getting the inboxes it may see), `ai.status.changed` and `triage.pending`.

import type { AiStatus, InboxCounts } from "@usualmail/core";
import { loadState, saveState } from "../ai/state.ts";
import { currentStatus } from "../ai/status.ts";
import type { Changes, Ctx } from "./context.ts";
import { computeCounts, totalCounts } from "./counts.ts";
import { triageCounts } from "./views.ts";

const AT_MOST_EVERY_MS = 1_000;

interface Snapshot<T> {
  value: T;
  json: string;
  version: number;
}

export class ChangeNotifier implements Changes {
  readonly #ctx: Ctx;
  readonly #track: (work: Promise<unknown>) => void;
  #started = false;
  #timer: (() => void) | null = null;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  #counts: Snapshot<InboxCounts[]> | null = null;
  #status: Snapshot<Omit<AiStatus, "version">> | null = null;
  #sentCounts = 0;
  #sentStatus = 0;
  readonly #sentTriage = new Map<string, number>();

  constructor(ctx: Ctx, track: (work: Promise<unknown>) => void) {
    this.#ctx = ctx;
    this.#track = track;
  }

  /** Takes the current counts and status as they are, at their stored versions, and starts listening. */
  async start(): Promise<void> {
    await this.#ctx.lock.run(async () => {
      // Counts and status as they are now, at the versions given out last (or that a change since started raised).
      const counts = await this.counts();
      const status = await this.status();
      this.#sentCounts = counts.version;
      this.#sentStatus = status.version;
      for (const [inboxId, count] of await triageCounts(this.#ctx, status.state === "working")) this.#sentTriage.set(inboxId, count);
    });
    this.#started = true;
  }

  stop(): void {
    this.#started = false;
    this.#timer?.();
    this.#timer = null;
  }

  touch(): void {
    if (!this.#started || this.#timer) return;
    const delay = Math.max(0, this.#lastSentAt + AT_MOST_EVERY_MS - this.#ctx.now());
    this.#timer = this.#ctx.host.scheduler.setTimer(delay, () => {
      this.#timer = null;
      this.#track(this.#flush());
    });
  }

  /** Every inbox's counts as they are now, at a version that rose if they changed. Under the lock. */
  async counts(): Promise<{ inboxes: InboxCounts[]; version: number }> {
    const value = await computeCounts(this.#ctx);
    const json = JSON.stringify(value);
    // Before `start`, the counts as they are now are the ones the stored version was given out for.
    if (!this.#counts) this.#counts = { value, json, version: (await loadState(this.#ctx)).countsVersion };
    if (this.#counts.json !== json) {
      const version = (await loadState(this.#ctx)).countsVersion + 1;
      await saveState(this.#ctx, { countsVersion: version });
      this.#counts = { value, json, version };
      this.touch();
    }
    return { inboxes: this.#counts.value, version: this.#counts.version };
  }

  /** The AI's status as it is now, at a version that rose if it changed. Under the lock. */
  async status(): Promise<AiStatus> {
    const value = await currentStatus(this.#ctx);
    const json = JSON.stringify(value);
    if (!this.#status) this.#status = { value, json, version: (await loadState(this.#ctx)).statusVersion };
    if (this.#status.json !== json) {
      const version = (await loadState(this.#ctx)).statusVersion + 1;
      await saveState(this.#ctx, { statusVersion: version });
      this.#status = { value, json, version };
      this.touch();
    }
    return { ...structuredClone(this.#status.value), version: this.#status.version };
  }

  async #flush(): Promise<void> {
    const ctx = this.#ctx;
    const { counts, status, triage } = await ctx.lock.run(async () => {
      const counts = await this.counts();
      const status = await this.status();
      return { counts, status, triage: await triageCounts(ctx, status.state === "working") };
    });
    if (!this.#started) return;
    let sent = false;
    if (counts.version !== this.#sentCounts) {
      this.#sentCounts = counts.version;
      // Every inbox here; each receiver hears only the inboxes it may see (`MailServer.subscribe` filters it).
      ctx.emit({ type: "counts.changed", counts: totalCounts(counts.inboxes, counts.version) });
      sent = true;
    }
    if (status.version !== this.#sentStatus) {
      this.#sentStatus = status.version;
      ctx.emit({ type: "ai.status.changed", status });
      sent = true;
    }
    for (const inboxId of new Set([...this.#sentTriage.keys(), ...triage.keys(), ...ctx.agentAccess.keys()])) {
      const count = triage.get(inboxId) ?? 0;
      if ((this.#sentTriage.get(inboxId) ?? 0) === count) continue;
      this.#sentTriage.set(inboxId, count);
      if (ctx.agentAccess.has(inboxId)) ctx.emit({ type: "triage.pending", inboxId, count });
      sent = true;
    }
    if (sent) this.#lastSentAt = ctx.now();
  }
}
