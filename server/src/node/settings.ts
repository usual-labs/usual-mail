// The server's own settings in its data directory: `<data-dir>/settings.json`, which `usual-mail init` writes and
// `usual-mail sync-days` changes. The data directory is what both ways of running the server keep (Node mode's folder,
// Docker's volume), so a plain start finds the settings every time. Today it holds one: how many days of mail a new
// inbox's first sync takes (`syncDays`). USUAL_MAIL_SYNC_DAYS, where the server starts, wins over it.

import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SETTINGS_FILE = "settings.json";
export const DEFAULT_SYNC_DAYS = 30;
/** The most days a first sync may take, as for USUAL_MAIL_SYNC_DAYS. */
export const MAX_SYNC_DAYS = 36_500;

export interface FirstSyncDays {
  days: number;
  /** Where it came from: USUAL_MAIL_SYNC_DAYS, settings.json, or neither. */
  from: "environment" | "settings" | "default";
}

/**
 * How many days of mail a new inbox's first sync takes: the environment's value when it was set, else `syncDays` in
 * the data directory's settings.json, else 30. A settings file that can't be read as JSON, or a value outside 1 to
 * 36,500, stops the start with words that say so. `dataDir` is null in demo mode, which reads no file.
 */
export async function firstSyncDays(fromEnv: number | null, dataDir: string | null): Promise<FirstSyncDays> {
  if (fromEnv !== null) return { days: fromEnv, from: "environment" };
  if (dataDir === null) return { days: DEFAULT_SYNC_DAYS, from: "default" };
  const path = join(dataDir, SETTINGS_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { days: DEFAULT_SYNC_DAYS, from: "default" };
    throw new Error(`Can't read ${path}: ${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path} isn't valid JSON. Fix it, or set the first sync's days again with \`usual-mail sync-days <days>\`.`);
  }
  const days = data && typeof data === "object" ? (data as { syncDays?: unknown }).syncDays : undefined;
  if (days === undefined) return { days: DEFAULT_SYNC_DAYS, from: "default" };
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_SYNC_DAYS) {
    throw new Error(`syncDays in ${path} must be a whole number from 1 to ${MAX_SYNC_DAYS}. Set it with \`usual-mail sync-days <days>\`.`);
  }
  return { days, from: "settings" };
}

/** The start's line about it, so the log says how many days a new inbox's first sync takes, and why. */
export function firstSyncWords(setting: FirstSyncDays, dataDir: string | null): string {
  const from = setting.from === "environment"
    ? "USUAL_MAIL_SYNC_DAYS, which wins over the saved setting"
    : setting.from === "settings"
      ? `${join(dataDir ?? "", SETTINGS_FILE)}`
      : "the default";
  return `A new inbox's first sync takes the last ${setting.days} days of mail (${from}).`;
}

/**
 * Keeps a person's new first-sync window (`updateFirstSyncWindow`) as `syncDays` in the data directory's settings.json,
 * keeping anything else the file holds, owner-only, written whole and then renamed into place, as `usual-mail
 * sync-days` writes it.
 */
export async function saveFirstSyncDays(dataDir: string, days: number): Promise<void> {
  const path = join(dataDir, SETTINGS_FILE);
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch {
    // No file yet, or one that isn't JSON: the new one holds the days.
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...current, syncDays: days }, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
