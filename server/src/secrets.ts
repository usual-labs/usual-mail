// AES-GCM sealing for provider credentials, with Web Crypto so it runs on any host. The key itself comes
// from the host: an environment variable or a key file on Node.

import type { Random, Secrets } from "./host.ts";
import { base64url, fromBase64url } from "./util.ts";

const VERSION = "v1";
export const KEY_BYTES = 32;

/** Seals with a 256-bit key. Each value gets a fresh 96-bit IV; `context` is authenticated, not stored. */
export async function aesGcmSecrets(key: Uint8Array<ArrayBuffer>, random: Random): Promise<Secrets> {
  if (key.length !== KEY_BYTES) throw new Error(`The secret key must be ${KEY_BYTES} bytes, not ${key.length}`);
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
  const encoder = new TextEncoder();
  return {
    async seal(plain, context) {
      const iv = random.bytes(12);
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
        cryptoKey,
        encoder.encode(plain),
      );
      return `${VERSION}.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
    },
    async open(sealed, context) {
      const [version, iv, data] = sealed.split(".");
      if (version !== VERSION || !iv || !data) throw new Error("This sealed value isn't in a format this server reads");
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromBase64url(iv), additionalData: encoder.encode(context) },
          cryptoKey,
          fromBase64url(data),
        );
        return new TextDecoder().decode(plain);
      } catch {
        throw new Error("The credentials can't be opened with this server's secret key");
      }
    },
  };
}

/** Reads a key given as base64 or base64url text. */
export function parseKey(text: string): Uint8Array<ArrayBuffer> {
  const key = fromBase64url(text.trim().replace(/=+$/, ""));
  if (key.length !== KEY_BYTES) throw new Error(`The secret key must be ${KEY_BYTES} bytes in base64, not ${key.length}`);
  return key;
}
