// Small helpers with no host dependencies: ids, codes, hashing, base64, times, cursors and serial work.

import { ServiceError } from "@usualmail/core";
import type { Random } from "./host.ts";

/** Crockford's base32 in lower case: 32 symbols, so a random byte maps without bias. */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * An id that sorts in the order it was made: ten symbols of time, four of a counter within that millisecond,
 * then eight random ones. Lists order equal times by id, so equal times keep the order things happened in.
 */
export function orderedId(random: Random, prefix: string, time: number, counter: number): string {
  let out = `${prefix}_${fixed(time, 10)}${fixed(counter, 4)}`;
  for (const byte of random.bytes(8)) out += ID_ALPHABET[byte % 32];
  return out;
}

/** `value` in base 32, left-padded to `width` symbols. The alphabet is in ASCII order, so text order is number order. */
function fixed(value: number, width: number): string {
  let out = "";
  let rest = Math.max(0, Math.floor(value));
  for (let i = 0; i < width; i++) {
    out = ID_ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/** A pairing code a person can type: eight symbols as "ABCD-EFGH", about 40 bits. */
export function makePairingCode(random: Random): string {
  let out = "";
  for (const byte of random.bytes(8)) out += CODE_ALPHABET[byte % 32];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Accepts a code typed loosely: any case, spaces or dashes, O for 0 and I or L for 1. */
export function normalizePairingCode(input: string): string {
  const plain = input.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return plain.length === 8 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : plain;
}

export const TOKEN_PREFIX = "umt_";

export function makeToken(random: Random): string {
  return TOKEN_PREFIX + base64url(random.bytes(32));
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- Times -------------------------------------------------------------------------------------------------

/** ISO 8601 in UTC to whole seconds, like the sample: "2026-11-16T09:30:00Z". */
export function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

export function isoOrUndefined(ms: number | null | undefined): string | undefined {
  return ms === null || ms === undefined ? undefined : iso(ms);
}

/** Parses an ISO 8601 time with a zone. Throws `invalid` otherwise. */
export function parseTime(value: string, what: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ServiceError("invalid", `${what} must be an ISO 8601 time with a zone, like 2026-11-16T09:30:00Z`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new ServiceError("invalid", `${what} is not a real time`);
  return ms;
}

// --- Cursors -----------------------------------------------------------------------------------------------

/** A position in a list ordered by a number, then a tie-breaker. Opaque to callers. */
export interface Position {
  at: number;
  tie: string | number;
}

export function encodeCursor(position: Position): string {
  return base64url(new TextEncoder().encode(JSON.stringify([position.at, position.tie])));
}

export function decodeCursor(cursor: string): Position {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(cursor)));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number"
      && (typeof value[1] === "string" || typeof value[1] === "number")) {
      return { at: value[0], tie: value[1] };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ServiceError("invalid", "The cursor isn't one this server gave out");
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new ServiceError("invalid", "limit must be a whole number from 1");
  return Math.min(limit, MAX_LIMIT);
}

// --- Serial work -------------------------------------------------------------------------------------------

/** Runs functions one at a time, in the order they were given. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

/** One queue per key (an inbox), plus a way to wait until every queue and tracked promise has settled. */
export class WorkQueues {
  #tails = new Map<string, Promise<void>>();
  #pending = new Set<Promise<unknown>>();
  readonly #onError: (error: unknown) => void;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }

  enqueue(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.then(work).catch(this.#onError);
    this.#tails.set(key, next);
    this.track(next);
    void next.then(() => {
      if (this.#tails.get(key) === next) this.#tails.delete(key);
    });
    return next;
  }

  track(work: Promise<unknown>): void {
    const settled = work.catch(this.#onError).finally(() => this.#pending.delete(settled));
    this.#pending.add(settled);
  }

  /** Resolves once nothing is queued or running, including work that running work started. */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }
}

export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/**
 * Text without U+0000, which means nothing in mail and which SQLite takes for the end of a text (libSQL reads a stored
 * text back only up to it, so whatever followed would be lost).
 */
export function withoutNul(text: string): string {
  return text.includes("\u0000") ? text.replaceAll("\u0000", "") : text;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
