// The server's own settings in its data directory: `<data-dir>/settings.json`, which the server reads at every start
// (server/src/node/settings.ts). The data directory is what Node mode and Docker mode both keep, so a plain
// `usual-mail start` finds the settings every time. Today it holds how many days of mail a new inbox's first sync takes
// (`syncDays`); USUAL_MAIL_SYNC_DAYS, where the server starts, wins over it.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.ts";
import { Failure, UsageError } from "./errors.ts";

export const SETTINGS_FILE = "settings.json";
export const DEFAULT_SYNC_DAYS = 30;
export const MAX_SYNC_DAYS = 36_500;

export const settingsPath = (dataDir: string) => join(dataDir, SETTINGS_FILE);

/** A number of days from what a person typed, 1 to 36,500, or a usage error naming `what`. */
export function syncDaysFrom(value: string, what: string): number {
  const days = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isInteger(days) || days < 1 || days > MAX_SYNC_DAYS) {
    throw new UsageError(`${what} takes a whole number of days from 1 to ${MAX_SYNC_DAYS}, not "${value}".`);
  }
  return days;
}

/** The settings file as an object, or null when there is none. */
function readSettings(dataDir: string): Record<string, unknown> | null {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Said below.
  }
  throw new Failure(`${path} isn't valid JSON, so the server won't start with it. Set the days again with \`usual-mail sync-days <days>\`.`);
}

/** The days saved in the data directory, or undefined when none are saved. */
export function savedSyncDays(dataDir: string): number | undefined {
  const days = readSettings(dataDir)?.syncDays;
  return typeof days === "number" && Number.isInteger(days) ? days : undefined;
}

/** USUAL_MAIL_SYNC_DAYS where this command runs, when it is set to a valid number. */
export function envSyncDays(ctx: Context): number | undefined {
  const value = ctx.env.USUAL_MAIL_SYNC_DAYS;
  if (!value) return undefined;
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= MAX_SYNC_DAYS ? days : undefined;
}

/**
 * Saves the days in the data directory, keeping whatever else the file holds, owner-only, written whole through a
 * temporary file. True when it changed anything.
 */
export function saveSyncDays(dataDir: string, days: number): boolean {
  const current = readSettings(dataDir);
  if (current?.syncDays === days) return false;
  const path = settingsPath(dataDir);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...current, syncDays: days }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return true;
}

/** The words before `init` asks, so the person knows what the number means. */
export const SYNC_DAYS_WORDS =
  "When you connect an inbox, the server first copies its recent mail and sorts it. How many days back should that " +
  "first sync go? Older mail stays in your mailbox, and new mail always arrives. `usual-mail sync-days` changes it later.";
