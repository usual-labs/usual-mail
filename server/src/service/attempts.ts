// Wrong passwords and wrong pairing codes, counted per client address (docs/contract.md, "Pairing and sign-in"), in
// ten-minute windows: ten from one address (an IPv6 address by its /64; client-address.ts), and that address waits until
// the oldest of them is ten minutes old; thirty from one IPv6 /48, which holds 65,536 /64s, and that whole /48 waits; a
// thousand from everyone, and everyone waits. So no handful of addresses locks the owner out of signing in: it takes a
// hundred IPv4 addresses, or thirty-four /48s, all guessing at once, and devices already signed in keep working.
//
// The ceiling is what keeps guessing slow. A thousand in ten minutes is at most 144,000 tries a day across every address.
// A pairing code is eight symbols of 32 (40 bits, 2^40 ≈ 1.1 × 10^12 codes), so a day of guessing at the ceiling finds
// one waiting code with a chance of 144,000 / 2^40 ≈ 1.3 × 10^-7, about one in 7.6 million (an owner's code waits a day
// at most, a person's or a recovery code minutes). A password of 12 characters or more is out of reach of 144,000 tries
// a day unless it is a common one. In memory, as before: a restart forgets the counts.

/** Wrong passwords or codes from one address in the window before that address waits. */
export const PAIRING_LIMIT = 10;
/** Wrong passwords or codes from one IPv6 /48 in the window before that /48 waits. */
export const PAIRING_BLOCK_LIMIT = 30;
/** Wrong passwords or codes from every address together in the window before everyone waits. */
export const PAIRING_GLOBAL_LIMIT = 1_000;
export const PAIRING_WINDOW_MS = 10 * 60_000;
/** Addresses, and /48s, remembered at once; those that failed longest ago are forgotten first. */
const MAX_KEYS = 10_000;

/** Who has to wait, and for how many whole seconds. */
export interface Wait {
  scope: "address" | "network" | "everyone";
  retryAfter: number;
}

/** What one client counts under (client-address.ts's `clientKey`): its address, and its IPv6 /48 or null. */
export interface Counted {
  address: string;
  block: string | null;
}

/**
 * Failures per key in the window, each key's list holding at most its limit (the newest ones: once the list is full,
 * the key waits until the oldest of them leaves the window), and at most `MAX_KEYS` keys.
 */
class Recent {
  readonly #byKey = new Map<string, number[]>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** When `key` may try again, or null; forgets what has left the window. */
  wait(key: string, now: number): number | null {
    const kept = (this.#byKey.get(key) ?? []).filter((at) => at > now - PAIRING_WINDOW_MS);
    if (kept.length === 0) this.#byKey.delete(key);
    else this.#byKey.set(key, kept);
    return kept.length >= this.#limit ? seconds(kept[0]!, now) : null;
  }

  count(key: string, now: number): void {
    const list = [...(this.#byKey.get(key) ?? []), now].slice(-this.#limit);
    // Re-inserted, so the map's order is the order keys last failed in.
    this.#byKey.delete(key);
    this.#byKey.set(key, list);
    while (this.#byKey.size > MAX_KEYS) this.#byKey.delete(this.#byKey.keys().next().value!);
  }
}

export class FailedAttempts {
  readonly #addresses = new Recent(PAIRING_LIMIT);
  readonly #blocks = new Recent(PAIRING_BLOCK_LIMIT);
  readonly #all: number[] = [];

  /** Null while `client` may try again; otherwise who waits and for how long. */
  wait(client: Counted, now: number): Wait | null {
    while (this.#all.length > 0 && this.#all[0]! <= now - PAIRING_WINDOW_MS) this.#all.shift();
    if (this.#all.length >= PAIRING_GLOBAL_LIMIT) return { scope: "everyone", retryAfter: seconds(this.#all[0]!, now) };
    const address = this.#addresses.wait(client.address, now);
    if (address !== null) return { scope: "address", retryAfter: address };
    const block = client.block === null ? null : this.#blocks.wait(client.block, now);
    if (block !== null) return { scope: "network", retryAfter: block };
    return null;
  }

  /** Counts one wrong password or code from `client`. */
  count(client: Counted, now: number): void {
    this.#all.push(now);
    if (this.#all.length > PAIRING_GLOBAL_LIMIT) this.#all.shift();
    this.#addresses.count(client.address, now);
    if (client.block !== null) this.#blocks.count(client.block, now);
  }
}

function seconds(oldest: number, now: number): number {
  return Math.max(1, Math.ceil((oldest + PAIRING_WINDOW_MS - now) / 1000));
}
