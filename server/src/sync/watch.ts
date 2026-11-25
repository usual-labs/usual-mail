// Whether syncs of an inbox still finish (docs/contract-sync.md, "When an inbox needs attention"): `not_syncing` once
// none of an open inbox, good or failed, has finished for `notSyncingAfterMs` while this server ran. Kept in memory on
// the host's monotonic clock (`Clock.monotonic`), so time while the server was stopped or its machine asleep never
// counts, and every start (a Node process, a Cloudflare object waking) begins afresh: it can't fire right after either.
// A first sync that is fetching counts as alive with each batch and each word of progress.

import type { Scheduler } from "../host.ts";

/** The last sign of life of each open inbox, on the monotonic clock, and the timer that looks for silent ones. */
export class SyncWatch {
  readonly #now: () => number;
  /** How long an open inbox may go without a sign of life (`notSyncingAfterMs`). */
  readonly afterMs: number;
  readonly #signs = new Map<string, number>();
  /** What the engine does with silent inboxes (status.ts's `markNotSyncing`). */
  onSilent: (inboxIds: string[]) => Promise<void> = async () => {};
  #cancel: (() => void) | null = null;
  #running = false;

  constructor(now: () => number, afterMs: number) {
    this.#now = now;
    this.afterMs = afterMs;
  }

  /** The inbox is open, or a sync of it finished, stored a batch or heard how far a first sync got. */
  alive(inboxId: string): void {
    this.#signs.set(inboxId, this.#now());
  }

  /** The inbox was closed (paused, removed, given new credentials, the server stopping): nothing to watch. */
  forget(inboxId: string): void {
    this.#signs.delete(inboxId);
  }

  /** Open inboxes with no sign of life for longer than `afterMs`. */
  silent(): string[] {
    const now = this.#now();
    return [...this.#signs].filter(([, sign]) => now - sign > this.afterMs).map(([id]) => id);
  }

  /** How often it looks: a third of `afterMs`, so a silent inbox is said within a third more. */
  get everyMs(): number {
    return Math.max(1_000, Math.round(this.afterMs / 3));
  }

  /**
   * Looks every `everyMs` until `stop`, the next look armed once this one is done. `track` hands each look to the
   * engine's background work, so `idle` and `stop` wait for it. On Cloudflare the timer keeps the object's alarm, as
   * the polls already do while it has an inbox.
   */
  start(scheduler: Scheduler, track: (work: Promise<unknown>) => void): void {
    this.stop();
    const arm = () => {
      this.#cancel = scheduler.setTimer(this.everyMs, () => {
        this.#cancel = null;
        const silent = this.silent();
        track((silent.length ? this.onSilent(silent) : Promise.resolve()).finally(() => {
          if (this.#cancel === null && this.#running) arm();
        }));
      });
    };
    this.#running = true;
    arm();
  }

  stop(): void {
    this.#running = false;
    this.#cancel?.();
    this.#cancel = null;
  }

}
