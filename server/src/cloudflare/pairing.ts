// Wrong pairing codes counted per client address on Cloudflare (server-cloudflare.md, "Pairing failures per address"):
// the service locks pairing for everyone after ten wrong codes in ten minutes (`PAIRING_LIMIT` in service/devices.ts),
// so one address could lock out the owner. The object counts failed `POST /v1/pair` and dashboard `POST /sign-in`
// answers (401) per address, an IPv6 address by its /64, and answers 429 itself after five in ten minutes, without
// passing the request on, so one address never reaches the global ten. The service is unchanged on both hosts.
// Attempts still in flight count too, so a burst from one address can't slip past the limit. In memory only, as the
// service's own count: an eviction forgets both.

import { PAIRING_WINDOW_MS } from "../service/devices.ts";

export const PER_ADDRESS_LIMIT = 5;
export const PER_ADDRESS_WINDOW_MS = PAIRING_WINDOW_MS;
/** Addresses remembered at once; the oldest are forgotten first. */
const MAX_ADDRESSES = 10_000;

/** Eight 16-bit groups of an IPv6 address, or null when it isn't one. */
function ipv6Groups(text: string): number[] | null {
  let address = text.toLowerCase().replace(/%.*$/, "");
  // An IPv4 tail (::ffff:192.0.2.1) as its two groups.
  const tail = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (tail) {
    const bytes = tail.slice(2).map(Number);
    if (bytes.some((byte) => byte > 255)) return null;
    address = `${tail[1]}${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const part = (half: string) => (half === "" ? [] : half.split(":"));
  const head = part(halves[0]!);
  const rest = halves.length === 2 ? part(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

/**
 * The key an address is counted under: an IPv4 address as it is, an IPv6 address by its /64 (one household or one
 * server's whole range), an IPv4-mapped IPv6 address as its IPv4 address. No address at all shares one key.
 */
export function addressKey(address: string | null): string {
  const text = address?.trim() ?? "";
  if (!text) return "unknown";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return text;
  const groups = ipv6Groups(text);
  if (!groups) return `other:${text.slice(0, 64).toLowerCase()}`;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join(".");
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

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
