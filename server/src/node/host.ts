// The Node side of the host seams: timers from the process and a secret key from the environment or a file
// only the owner can read.

import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Random, Scheduler } from "../host.ts";
import { KEY_BYTES, parseKey } from "../secrets.ts";
import { base64url } from "../util.ts";

/** setTimeout caps delays at about 24.8 days; the engine re-arms long timers anyway. */
const MAX_DELAY = 2 ** 31 - 1;

export const nodeScheduler: Scheduler = {
  setTimer(delayMs, run) {
    const timer = setTimeout(run, Math.min(Math.max(0, delayMs), MAX_DELAY));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export const KEY_FILE = "secret.key";

/**
 * The key that seals mailbox credentials: USUAL_MAIL_SECRET_KEY if set, else `<dataDir>/secret.key`,
 * created on first start with owner-only permissions. Losing it means reconnecting every inbox.
 */
export async function loadSecretKey(dataDir: string, fromEnv: string | null, random: Random): Promise<Uint8Array<ArrayBuffer>> {
  if (fromEnv) return parseKey(fromEnv);
  const path = join(dataDir, KEY_FILE);
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) await chmod(path, 0o600);
    return parseKey(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = random.bytes(KEY_BYTES);
  await writeFile(path, `${base64url(key)}\n`, { mode: 0o600, flag: "wx" });
  return key;
}
