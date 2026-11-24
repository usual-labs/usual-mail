// The owner's pairing code as a file, so the `usual-mail` command can read it without the log.
// `<data-dir>/owner-pairing-code` holds the code and a newline, readable only by the owner. It is removed once
// the code is used or has expired. The code is printed once, when it is made: a later start that finds it still
// waiting keeps it and says where the file is, without printing it again.

import type { PairingCode } from "@usualmail/core";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const OWNER_CODE_FILE = "owner-pairing-code";

export function ownerCodePath(dataDir: string): string {
  return join(dataDir, OWNER_CODE_FILE);
}

/** Writes the code to a temporary file with mode 0600, then moves it into place, so no reader sees half of it. */
export async function writeOwnerCode(dataDir: string, code: string): Promise<void> {
  const path = ownerCodePath(dataDir);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${code}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function removeOwnerCode(dataDir: string): Promise<void> {
  await rm(ownerCodePath(dataDir), { force: true });
}

/** The code an earlier start wrote, for the service to keep while it is still valid; null without a file. */
export async function readOwnerCode(dataDir: string): Promise<string | null> {
  try {
    return (await readFile(ownerCodePath(dataDir), "utf8")).trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

/**
 * What the log says about the owner's code. A code made just now is printed, once. A code kept from an earlier start
 * isn't printed again: the log says one waits, until when, and where its file is. `file` is null in demo mode, which
 * writes none.
 */
export function ownerCodeLines(code: PairingCode | null, made: boolean, file: string | null): string[] {
  if (!code) return [];
  if (made) {
    return [
      `Pair your first device with the code ${code.code} (works once, until ${code.expiresAt}).`,
      `  POST /v1/pair {"code": "${code.code}", "name": "My Mac"} returns the token.`,
    ];
  }
  return [
    `An owner's pairing code made at an earlier start is waiting, until ${code.expiresAt}; it isn't printed again.`,
    `  It is in ${file ?? "the data directory"}, readable only by you. \`usual-mail init\` pairs with it.`,
  ];
}
