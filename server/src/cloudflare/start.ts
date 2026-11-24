// Starting the server in its Durable Object, and what a failed start does. Requests and alarms wait on the start's
// promise. The migrations run first inside it, not inside `blockConcurrencyWhile`: requests and alarms already wait
// on the promise, so blocking adds no order; `blockConcurrencyWhile` would reset the object on a throw, before anyone
// could answer it or log why, and after 30 seconds of wall time on top of the CPU limit; and every start failure then
// takes one path. The durable migrator runs synchronously, in one transaction, so nothing else runs in the middle of it
// either way.
//
// A start that fails answers every request waiting on it with 503 and core's `internal` error, and resets the object a
// second later, so the next request or alarm makes a new instance that starts again from nothing (a half-started
// server's timers go with the old one). A start the runtime cuts off (the CPU or memory limit, a migration too slow)
// can't answer anything, so each start first notes itself durably as a failure (`usual-mail-start` in the object's
// key-value storage) and clears the note once it succeeds: once the server answers and what it began in the background
// (search's first catch-up) has finished too, so a reset during that catch-up counts as a failed start. After one failure the next start may run at once; after more,
// starts wait for the backstop, doubling up to an hour, and a request meanwhile is answered 503 at once, without a try.
// So a start that always fails or is always cut off is tried a bounded number of times, never in a loop. While the
// server has an inbox, the alarm is set for the next try, so a failed start never leaves it without one (an alarm
// handler that throws is retried only six times).

import { errorMessage } from "../util.ts";
import type { Log } from "../host.ts";

/** Its name in the object's key-value storage. */
export const START_RECORD = "usual-mail-start";
/** The longest wait between two starts after failures. */
export const MAX_START_WAIT_MS = 60 * 60_000;
/** How long a failed instance lives on, so the requests waiting on it are answered before it is reset. */
export const RESET_AFTER_MS = 1_000;

/** Failed (or cut-off) starts in a row, when the last began, and why it failed. */
interface StartRecord {
  failures: number;
  at: number;
  reason: string;
}

const CUT_OFF = "it was cut off before it finished (the CPU or memory limit, or a migration too slow)";

/** How long after the last failed start the next may run: at once after one failure, then the backstop doubling to an hour. */
export function startWait(failures: number, backstopMs: number): number {
  return failures <= 1 ? 0 : Math.min(backstopMs * 2 ** (failures - 2), MAX_START_WAIT_MS);
}

/** A start that wasn't tried, because the failures before it ask to wait. */
export class StartDeferred extends Error {
  override readonly name = "StartDeferred";
  readonly retryAt: number;

  constructor(retryAt: number, failures: number, last: string) {
    super(`The server's start waits until ${new Date(retryAt).toISOString()}: it failed ${failures} times in a row (the last time: ${last}).`);
    this.retryAt = retryAt;
  }
}

/** A start that succeeded: what it answers with, and the work it began that still counts as part of it. */
export interface Started<T> {
  value: T;
  /** Resolves once that work has finished (search's first catch-up); until then the start's record stays. */
  settled: Promise<unknown>;
}

/** The object's side of a start: its storage, whether it has an inbox, and how it is reset. */
export interface StartHost {
  storage: Pick<DurableObjectStorage, "kv" | "sync" | "getAlarm" | "setAlarm">;
  hasInbox(): boolean;
  reset(reason: string): void;
  log: Log;
}

/**
 * The server's starts in one object instance: the first begins at once; a deferred one begins again, in the same
 * instance (it did nothing), once its time has come; a failed one resets the instance.
 */
export class Starts<T> {
  readonly #host: StartHost;
  readonly #backstopMs: number;
  readonly #start: () => Promise<Started<T>>;
  readonly #startedByAlarm: () => boolean;
  #running: Promise<T>;
  #deferredUntil: number | null = null;

  constructor(host: StartHost, backstopMs: number, start: () => Promise<Started<T>>, startedByAlarm: () => boolean) {
    this.#host = host;
    this.#backstopMs = backstopMs;
    this.#start = start;
    this.#startedByAlarm = startedByAlarm;
    this.#running = this.#begin();
  }

  /** The running server, or the start's failure; a deferred start begins again once it may. */
  current(): Promise<T> {
    if (this.#deferredUntil !== null && Date.now() >= this.#deferredUntil) {
      this.#deferredUntil = null;
      this.#running = this.#begin();
    }
    return this.#running;
  }

  /**
   * After an alarm whose start failed or waits: the alarm set again for the next try while the server has an inbox.
   * Inside the alarm's own handler, after its delivery, so it never overwrites the alarm being delivered.
   */
  async rearm(error: unknown): Promise<void> {
    if (!this.#hasInbox()) return;
    await this.#host.storage.setAlarm(this.#retryAt(error));
  }

  #begin(): Promise<T> {
    const running = this.#attempt();
    running.catch((error: unknown) => this.#failed(error));
    return running;
  }

  async #attempt(): Promise<T> {
    const kv = this.#host.storage.kv;
    const now = Date.now();
    const last = kv.get<StartRecord>(START_RECORD);
    if (last) {
      const at = last.at + startWait(last.failures, this.#backstopMs);
      if (at > now) throw new StartDeferred(at, last.failures, last.reason);
    }
    // Noted as a failure, durably, before anything runs: a start the runtime cuts off can't note it afterwards.
    kv.put(START_RECORD, { failures: (last?.failures ?? 0) + 1, at: now, reason: CUT_OFF } satisfies StartRecord);
    await this.#host.storage.sync();
    const { value, settled } = await this.#start();
    // Cleared only once the background work is done as well: a reset before then leaves the record, and the next start
    // counts it as a failure, so a catch-up that never fits backs off like any start that fails.
    const clear = () => {
      try {
        kv.delete(START_RECORD);
      } catch {
        // The store refused: the next start counts one failure too many, and runs at once.
      }
    };
    void settled.then(clear, clear);
    return value;
  }

  #failed(error: unknown): void {
    if (error instanceof StartDeferred) {
      this.#deferredUntil = error.retryAt;
      this.#host.log.info(error.message);
    } else {
      try {
        const record = this.#host.storage.kv.get<StartRecord>(START_RECORD) ?? { failures: 1, at: Date.now(), reason: CUT_OFF };
        this.#host.storage.kv.put(START_RECORD, { ...record, reason: errorMessage(error) });
      } catch {
        // The store refused even that: the record says it was cut off.
      }
      this.#host.log.error("The server couldn't start; the object is reset to start again", error);
      setTimeout(() => this.#host.reset("The server couldn't start"), RESET_AFTER_MS);
    }
    // An instance an alarm started sets the alarm in that alarm's handler (`rearm`), after its delivery.
    if (!this.#startedByAlarm()) void this.#armIfNone(error).catch((failure) => this.#host.log.error("Couldn't set the server's alarm", failure));
  }

  /** Sets the alarm for the next try, unless one is set (it may be about to be delivered). */
  async #armIfNone(error: unknown): Promise<void> {
    if (!this.#hasInbox() || (await this.#host.storage.getAlarm()) !== null) return;
    await this.#host.storage.setAlarm(this.#retryAt(error));
  }

  /** When the next start may run, and never sooner than the backstop from now. */
  #retryAt(error: unknown): number {
    let at = Date.now();
    if (error instanceof StartDeferred) at = error.retryAt;
    else {
      const record = this.#host.storage.kv.get<StartRecord>(START_RECORD);
      if (record) at = record.at + startWait(record.failures, this.#backstopMs);
    }
    return Math.max(at, Date.now() + this.#backstopMs);
  }

  /** Whether the server has an inbox; false when the store can't say (its tables not made yet). */
  #hasInbox(): boolean {
    try {
      return this.#host.hasInbox();
    } catch {
      return false;
    }
  }
}

/** The answer to a request while the server couldn't start: 503 with core's error shape. */
export function startRefusal(error: unknown): Response {
  const when = error instanceof StartDeferred ? ` It tries again after ${new Date(error.retryAt).toISOString()}.` : "";
  return Response.json(
    { error: { code: "internal", message: `The server couldn't start; its log says why.${when}` } },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
