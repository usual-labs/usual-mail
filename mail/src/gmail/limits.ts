/**
 * Staying inside Gmail's limits: a per-user quota of 6,000 units a minute (Google's quota page, read
 * 2026-11-16), a handful of requests at a time, and backoff when Google says slow down anyway.
 */

/**
 * Quota units per call, from Google's quota page (read again 2026-11-16, and on 2026-11-21 for the rows below it):
 * messages.get costs 60 in the raw (and full) form and 20 in the minimal or metadata form.
 */
export const COST = {
  getProfile: 1,
  labelsList: 1,
  labelsCreate: 5,
  historyList: 2,
  messagesList: 5,
  messagesGetRaw: 60,
  messagesGet: 20,
  messagesModify: 5,
  messagesTrash: 20,
  messagesUntrash: 5,
  messagesSend: 100,
  /** Read 2026-11-21: messages.get in the full form (60, as raw) and messages.attachments.get (20). */
  messagesGetFull: 60,
  attachmentsGet: 20,
  /**
   * Search (docs/contract-search.md): threads.list 10. threads.get was counted as 20 from 2026-11-20 without reading
   * Google's page; the page read on 2026-11-21 says 40 (120 in the full form, which isn't used).
   */
  threadsList: 10,
  threadsGet: 40,
} as const;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * A token bucket for quota units. The defaults (80 units a second, bursts of 600) stay under 6,000 units in
 * any minute, leaving room for the person's other Gmail apps.
 */
export class QuotaBucket {
  readonly perSecond: number;
  readonly burst: number;
  readonly clock: Clock;
  #tokens: number;
  #last: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(perSecond: number, burst: number, clock: Clock) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.clock = clock;
    this.#tokens = burst;
    this.#last = clock.now();
  }

  /** Waits until `units` are available, in arrival order. */
  take(units: number): Promise<void> {
    const turn = this.#queue.then(async () => {
      const need = Math.min(units, this.burst);
      this.#refill();
      if (this.#tokens < need) {
        await this.clock.sleep(Math.ceil(((need - this.#tokens) / this.perSecond) * 1000));
        this.#refill();
      }
      this.#tokens -= need;
    });
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  #refill(): void {
    const now = this.clock.now();
    this.#tokens = Math.min(this.burst, this.#tokens + ((now - this.#last) / 1000) * this.perSecond);
    this.#last = now;
  }
}

/** At most `size` tasks at once. */
export class Gate {
  readonly size: number;
  #active = 0;
  #waiting: (() => void)[] = [];

  constructor(size: number) {
    this.size = size;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    // A finished task hands its slot straight to the next waiter, so no newcomer can slip in between.
    if (this.#active >= this.size) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#active++;
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }
}

/** Exponential backoff from 1 s, doubling to 32 s, with up to a second of jitter; Retry-After wins when longer. */
export function backoffMs(attempt: number, retryAfter: string | null, now: number, random = Math.random): number {
  const base = Math.min(32_000, 1000 * 2 ** attempt) + Math.floor(random() * 1000);
  const hinted = retryAfterMs(retryAfter, now);
  return hinted !== undefined ? Math.max(base, Math.min(hinted, 5 * 60_000)) : base;
}

function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
