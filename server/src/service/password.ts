// The owner's password as a hash (docs/contract.md, "The owner's password"): PBKDF2 with SHA-256 through WebCrypto,
// which both hosts have. Workers refuse more than 100,000 iterations, so that is the count, below what OWASP
// recommends for PBKDF2-SHA256 (600,000; known-issues.md): wrong passwords count with wrong pairing codes, which caps
// guessing online. The stored form names the scheme and the count, so a later build can raise it and re-hash at the
// next sign-in. The password is normalised to Unicode NFKC first, so the same characters typed on another keyboard
// match.

import { OWNER_PASSWORD_MAX, OWNER_PASSWORD_MIN, ServiceError } from "@usualmail/core";
import type { Random } from "../host.ts";
import { base64url, fromBase64url } from "../util.ts";

const SCHEME = "pbkdf2-sha256";
export const PASSWORD_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

/** The password as the server compares it, or `invalid` when it is too short or too long. */
export function checkedPassword(password: unknown): string {
  if (typeof password !== "string") throw new ServiceError("invalid", "The password must be text");
  const normal = password.normalize("NFKC");
  const length = [...normal].length;
  if (length < OWNER_PASSWORD_MIN) {
    throw new ServiceError("invalid", `The password needs at least ${OWNER_PASSWORD_MIN} characters`);
  }
  if (length > OWNER_PASSWORD_MAX) {
    throw new ServiceError("invalid", `The password can have at most ${OWNER_PASSWORD_MAX} characters`);
  }
  return normal;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

/** `pbkdf2-sha256$100000$<salt>$<hash>`, both in base64url, of the password normalised (as `checkedPassword` does). */
export async function hashPassword(password: string, random: Random): Promise<string> {
  const salt = random.bytes(SALT_BYTES);
  const hash = await derive(password.normalize("NFKC"), salt, PASSWORD_ITERATIONS);
  return `${SCHEME}$${PASSWORD_ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

/** Whether `password` is the one `stored` was made from. A stored form it can't read never matches. */
export async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [scheme, count, salt, hash] = stored.split("$");
  const iterations = Number(count);
  if (scheme !== SCHEME || !salt || !hash || !Number.isInteger(iterations) || iterations < 1 || iterations > PASSWORD_ITERATIONS) {
    return false;
  }
  let expected: Uint8Array;
  let actual: Uint8Array;
  try {
    expected = fromBase64url(hash);
    actual = await derive(password.normalize("NFKC"), fromBase64url(salt), iterations);
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}
