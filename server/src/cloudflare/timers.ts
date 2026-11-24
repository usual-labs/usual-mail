// Timers in the Durable Object: in memory, as on Node, with the object's one alarm as the backstop. A pending timer keeps
// the object in memory, but an object can still be evicted (or replaced by a deploy), and its timers die with it. While
// the server has an inbox, the alarm stays at most `backstopMs` ahead: each alarm tops the object's CPU up and, after
// an eviction, recreates the object, whose `start()` re-arms everything durable. Without an inbox there is no alarm, so
// an unpaired server isn't woken every minute; its owner's code waits in its table (owner-code.ts).

import type { Scheduler } from "../host.ts";

/** setTimeout's longest delay, about 24.8 days; the service re-arms longer waits itself. */
export const MAX_DELAY = 2 ** 31 - 1;

/** The default backstop: an evicted server is back within a minute. */
export const BACKSTOP_MS = 60_000;

/** Plain timers, clamped as `src/node/host.ts` clamps them. The REST event stream's keep-alive uses these. */
export const plainTimers: Scheduler = {
  setTimer(delayMs, run) {
    const timer = setTimeout(run, Math.min(Math.max(0, delayMs), MAX_DELAY));
    return () => clearTimeout(timer);
  },
};

/** The object's side of the alarm: its storage and whether the server has an inbox now. */
export interface AlarmStore {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  hasInbox(): boolean;
}

/**
 * The host's scheduler: plain timers, and the alarm kept at most `backstopMs` ahead while the server has an inbox.
 * `load()` comes first, before the server sets any timer. Setting a timer looks again only when no alarm is set (so
 * connecting the first inbox arms it); each alarm and each start calls `keep()`. An alarm that is set, even one due now,
 * is left alone: overwriting an alarm while it is being delivered cancels its handler.
 */
export class AlarmTimers implements Scheduler {
  readonly #store: AlarmStore;
  readonly #backstopMs: number;
  readonly #onError: (error: unknown) => void;
  /** When the alarm is due: null when none is set, undefined until `load()` has read it. */
  #alarmAt: number | null | undefined = undefined;
  #keeping: Promise<void> | null = null;

  constructor(store: AlarmStore, backstopMs: number, onError: (error: unknown) => void) {
    this.#store = store;
    this.#backstopMs = backstopMs;
    this.#onError = onError;
  }

  setTimer(delayMs: number, run: () => void): () => void {
    const cancel = plainTimers.setTimer(delayMs, run);
    if (this.#alarmAt === null && !this.#keeping) void this.keep().catch(this.#onError);
    return cancel;
  }

  /** At start, before any timer: the alarm an earlier instance left (or the one being delivered now). */
  async load(): Promise<void> {
    this.#alarmAt = await this.#store.getAlarm();
  }

  /** The alarm just fired: it is gone until set again. */
  fired(): void {
    this.#alarmAt = null;
  }

  /** Sets the alarm `backstopMs` ahead when the server has an inbox and none is set to come within that. */
  keep(): Promise<void> {
    this.#keeping ??= this.#keep().finally(() => {
      this.#keeping = null;
    });
    return this.#keeping;
  }

  async #keep(): Promise<void> {
    const now = Date.now();
    if (this.#alarmAt === undefined) throw new Error("The alarm wasn't read before the server started");
    if (this.#alarmAt !== null && this.#alarmAt <= now + this.#backstopMs) return;
    if (!this.#store.hasInbox()) return;
    const at = now + this.#backstopMs;
    await this.#store.setAlarm(at);
    this.#alarmAt = at;
  }
}
