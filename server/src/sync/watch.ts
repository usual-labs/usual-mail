// Whether syncs of an inbox still finish (docs/contract-sync.md, "When an inbox needs attention"): `not_syncing` once
// none of an open inbox, good or failed, has finished for `notSyncingAfterMs` while this server ran. Kept in memory on
// the host's monotonic clock (`Clock.monotonic`), so time while the server was stopped or its machine asleep never
// counts, and every start (a Node process, a Cloudflare object waking) begins afresh: it can't fire right after either.
// Signs of life: an attempt finishing, a batch stored, a first sync's word of progress, a write-back done (which shares
// the inbox's queue). The first sign after the watch said `not_syncing` ends it (`onRevived`), mid-sync too.

import type { Scheduler } from "../host.ts";

/** The last sign of life of each open inbox, on the monotonic clock, and the timer that looks for silent ones. */
export class SyncWatch {
  readonly #now: () => number;
  /** How long an open inbox may go without a sign of life (`notSyncingAfterMs`). */
  readonly afterMs: number;
  readonly #signs = new Map<string, number>();
  /** Inboxes the watch said were `not_syncing` (`said`), until their next sign of life. */
  readonly #said = new Set<string>();
  /** What the engine does with silent inboxes (status.ts's `markNotSyncing`). */
  onSilent: (inboxIds: string[]) => Promise<void> = async () => {};
  /** A sign of life of an inbox the watch said was `not_syncing`: the engine settles it. */
  onRevived: (inboxId: string) => void = () => {};
  #cancel: (() => void) | null = null;
  #running = false;

  constructor(now: () => number, afterMs: number) {
    this.#now = now;
    this.afterMs = afterMs;
  }

  /** The inbox was opened: watched from now. */
  opened(inboxId: string): void {
    this.#signs.set(inboxId, this.#now());
    this.#said.delete(inboxId);
  }

  /**
   * A sign of life of an open inbox (an attempt finished, a batch stored, a first sync's word, a write-back done). One
   * of an inbox the watch isn't watching (closed meanwhile) is ignored.
   */
  alive(inboxId: string): void {
    if (!this.#signs.has(inboxId)) return;
    this.#signs.set(inboxId, this.#now());
    if (this.#said.delete(inboxId)) this.onRevived(inboxId);
  }

  /** The inbox was closed (paused, removed, given new credentials, the server stopping): nothing to watch. */
  forget(inboxId: string): void {
    this.#signs.delete(inboxId);
    this.#said.delete(inboxId);
  }

  /** Whether the inbox is open and silent now: read again inside the store's lock before saying so. */
  isSilent(inboxId: string): boolean {
    const sign = this.#signs.get(inboxId);
    return sign !== undefined && this.#now() - sign > this.afterMs;
  }

  /** `not_syncing` was stored for the inbox: its next sign of life ends it. */
  said(inboxId: string): void {
    if (this.#signs.has(inboxId)) this.#said.add(inboxId);
  }

  /** Open inboxes with no sign of life for longer than `afterMs`. */
  silent(): string[] {
    return [...this.#signs.keys()].filter((id) => this.isSilent(id));
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
