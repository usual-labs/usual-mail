// Wrong pairing codes and passwords counted per client address at the object's door on Cloudflare
// (server-cloudflare-access.md, "Pairing failures per address"). The service counts them per address too, ten each
// and a hundred from everyone (service/attempts.ts), on both hosts; here the object counts failed pairing answers
// (401: `POST /v1/pair`, `/v1/owner/sign-in`, `/v1/owner/claim`, the dashboard's `POST /sign-in` and `/claim`) per
// address, an IPv6 address by its /64 (client-address.ts), and answers 429 itself after five in ten minutes, without
// passing the request on. Attempts still in flight count too, so a burst from one address can't slip past the limit.
// In memory only, as the service's own count: an eviction forgets both.

import { PAIRING_WINDOW_MS } from "../service/attempts.ts";

export const PER_ADDRESS_LIMIT = 5;
export const PER_ADDRESS_WINDOW_MS = PAIRING_WINDOW_MS;
/** Addresses remembered at once; the oldest are forgotten first. */
const MAX_ADDRESSES = 10_000;

/** One attempt let through: `done(failed)` once its answer is known. */
export interface Attempt {
  done(failed: boolean): void;
}

/** Wrong codes per address: at most `limit` in `windowMs`, attempts in flight included. */
export class AddressCounter {
  readonly #now: () => number;
  readonly #limit: number;
  readonly #windowMs: number;
  /** Per key: when each wrong code was answered. */
  readonly #failures = new Map<string, number[]>();
  readonly #pending = new Map<string, number>();

  constructor(now: () => number, limit = PER_ADDRESS_LIMIT, windowMs = PER_ADDRESS_WINDOW_MS) {
    this.#now = now;
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** Lets an attempt through, or answers in whole seconds how long `key` must wait. */
  begin(key: string): Attempt | { retryAfter: number } {
    const now = this.#now();
    const kept = (this.#failures.get(key) ?? []).filter((at) => at > now - this.#windowMs);
    if (kept.length) this.#failures.set(key, kept);
    else this.#failures.delete(key);
    const pending = this.#pending.get(key) ?? 0;
    if (kept.length + pending >= this.#limit) {
      const oldest = kept[0] ?? now;
      return { retryAfter: Math.max(1, Math.ceil((oldest + this.#windowMs - now) / 1000)) };
    }
    this.#pending.set(key, pending + 1);
    let finished = false;
    return {
      done: (failed) => {
        if (finished) return;
        finished = true;
        const left = (this.#pending.get(key) ?? 1) - 1;
        if (left > 0) this.#pending.set(key, left);
        else this.#pending.delete(key);
        if (!failed) return;
        const list = this.#failures.get(key) ?? [];
        // Re-inserted, so the map's order is the order addresses last failed in.
        this.#failures.delete(key);
        this.#failures.set(key, [...list, this.#now()]);
        while (this.#failures.size > MAX_ADDRESSES) this.#failures.delete(this.#failures.keys().next().value!);
      },
    };
  }
}
