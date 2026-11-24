// The key that seals mailbox and AI credentials (src/secrets.ts, AES-GCM), on Cloudflare: the Worker secret
// USUAL_MAIL_SECRET_KEY when it is set, else a key made at the first start and kept in the object's own storage, as Node
// keeps `secret.key` beside its database. Losing it means reconnecting every inbox and setting the AI key again.

import type { Random } from "../host.ts";
import { KEY_BYTES, parseKey } from "../secrets.ts";
import { base64url } from "../util.ts";

/** Its name in the object's key-value storage (the `_cf_KV` table Data Studio shows). */
export const SECRET_KEY_NAME = "usual-mail-secret-key";

/** The secret wins when set, as USUAL_MAIL_SECRET_KEY does on Node; empty counts as unset. */
export function objectSecretKey(kv: SyncKvStorage, fromEnv: string | undefined, random: Random): Uint8Array<ArrayBuffer> {
  if (fromEnv?.trim()) return parseKey(fromEnv);
  const kept = kv.get<string>(SECRET_KEY_NAME);
  if (kept) return parseKey(kept);
  const key = random.bytes(KEY_BYTES);
  kv.put(SECRET_KEY_NAME, base64url(key));
  return key;
}
