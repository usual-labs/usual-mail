// Wrong passwords and wrong pairing codes, counted per client address (docs/contract.md, "Pairing and sign-in"): ten
// from one address (an IPv6 address by its /64; client-address.ts) in ten minutes, and that address waits until the
// oldest of them is ten minutes old; a hundred from everyone, and everyone waits. One address can't lock the owner out of
// signing in, and guessing stays slow: at most 14,400 tries a day across every address, against a 12-character password
// or a 40-bit code. In memory, as before: a restart forgets the counts.

/** Wrong passwords or codes from one address in the window before that address waits. */
export const PAIRING_LIMIT = 10;
/** Wrong passwords or codes from every address together in the window before everyone waits. */
export const PAIRING_GLOBAL_LIMIT = 100;
export const PAIRING_WINDOW_MS = 10 * 60_000;
/** Addresses remembered at once; those that failed longest ago are forgotten first. */
const MAX_ADDRESSES = 10_000;

/** Who has to wait, and for how many whole seconds. */
export interface Wait {
  scope: "address" | "everyone";
  retryAfter: number;
}

export class FailedAttempts {
  readonly #byKey = new Map<string, number[]>();
  readonly #all: number[] = [];

  /** Null while `key` may try again; otherwise who waits and for how long. */
  wait(key: string, now: number): Wait | null {
    const cutoff = now - PAIRING_WINDOW_MS;
    while (this.#all.length > 0 && this.#all[0]! <= cutoff) this.#all.shift();
    if (this.#all.length >= PAIRING_GLOBAL_LIMIT) return { scope: "everyone", retryAfter: seconds(this.#all[0]!, now) };
    const kept = (this.#byKey.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) this.#byKey.delete(key);
    else this.#byKey.set(key, kept);
    if (kept.length >= PAIRING_LIMIT) return { scope: "address", retryAfter: seconds(kept[0]!, now) };
    return null;
  }

  /** Counts one wrong password or code from `key`. */
  count(key: string, now: number): void {
    this.#all.push(now);
    const list = this.#byKey.get(key) ?? [];
    // Re-inserted, so the map's order is the order addresses last failed in.
    this.#byKey.delete(key);
    this.#byKey.set(key, [...list, now]);
    while (this.#byKey.size > MAX_ADDRESSES) this.#byKey.delete(this.#byKey.keys().next().value!);
  }
}

function seconds(oldest: number, now: number): number {
  return Math.max(1, Math.ceil((oldest + PAIRING_WINDOW_MS - now) / 1000));
}
