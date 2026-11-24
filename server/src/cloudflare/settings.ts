// The server's own settings on Cloudflare, kept in the object's key-value storage where Node keeps settings.json, with
// the Worker's plain variables winning as Node's environment does:
// - How many days of mail a new inbox's first sync takes: USUAL_MAIL_SYNC_DAYS, else what a person set (kept as
//   `usual-mail-sync-days`), else 30.
// - The server's time zone (server-cloudflare.md, "Time zone"): a Worker's own zone is UTC, so the host takes the zone
//   of the request that pairs the first person's device (`request.cf.timezone`, which the front Worker copies into a
//   header of its own), keeps it as `usual-mail-time-zone` and logs it; USUAL_MAIL_TIME_ZONE overrides it. UTC until
//   then, and the log says so.
// A variable that can't be used is left out with words in the log: the server still starts.

import { FIRST_SYNC_DEFAULT_DAYS, type FirstSyncSource } from "@usualmail/core";
import type { Log } from "../host.ts";

export const SYNC_DAYS_KEY = "usual-mail-sync-days";
export const TIME_ZONE_KEY = "usual-mail-time-zone";
/** The most days a first sync may take, as on Node. */
const MAX_SYNC_DAYS = 36_500;

/** The Worker's plain variables for these settings. */
export interface SettingsEnv {
  USUAL_MAIL_SYNC_DAYS?: string;
  USUAL_MAIL_TIME_ZONE?: string;
}

function days(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number >= 1 && number <= MAX_SYNC_DAYS ? number : null;
}

export interface FirstSync {
  days: number;
  from: FirstSyncSource;
}

/** The first sync's window: the variable, else the kept setting, else the default. */
export function firstSyncDays(kv: SyncKvStorage, env: SettingsEnv, log: Log): FirstSync {
  const given = env.USUAL_MAIL_SYNC_DAYS?.trim();
  if (given) {
    const fromEnv = days(given);
    if (fromEnv !== null) return { days: fromEnv, from: "environment" };
    log.info(`USUAL_MAIL_SYNC_DAYS isn't used: it must be a whole number from 1 to ${MAX_SYNC_DAYS}.`);
  }
  const kept = days(kv.get(SYNC_DAYS_KEY));
  return kept === null ? { days: FIRST_SYNC_DEFAULT_DAYS, from: "default" } : { days: kept, from: "settings" };
}

/** Keeps a person's new window (`saveSyncWindowDays`). */
export function saveFirstSyncDays(kv: SyncKvStorage, value: number): void {
  kv.put(SYNC_DAYS_KEY, value);
}

export function firstSyncWords(setting: FirstSync): string {
  const from = setting.from === "environment"
    ? "USUAL_MAIL_SYNC_DAYS, which wins over the saved setting"
    : setting.from === "settings" ? "the setting kept in the server's storage" : "the default";
  return `A new inbox's first sync takes the last ${setting.days} days of mail (${from}).`;
}

/** An IANA zone name this runtime knows, in its own spelling, or null. */
export function knownZone(name: string | null | undefined): string | null {
  const zone = name?.trim();
  if (!zone || zone.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The server's time zone: the variable, else the one kept from the first pairing, else none (UTC). */
export class ServerTimeZone {
  readonly #kv: SyncKvStorage;
  readonly #log: Log;
  readonly #override: string | null;

  constructor(kv: SyncKvStorage, env: SettingsEnv, log: Log) {
    this.#kv = kv;
    this.#log = log;
    const given = env.USUAL_MAIL_TIME_ZONE?.trim();
    this.#override = knownZone(given);
    if (given && !this.#override) log.info("USUAL_MAIL_TIME_ZONE isn't used: it must be a time zone name like Europe/Berlin.");
  }

  /** The zone kept from the request that paired the first person's device, or null. */
  get kept(): string | null {
    return knownZone(this.#kv.get<string>(TIME_ZONE_KEY));
  }

  /** `Host.timeZone`: undefined means UTC. */
  get current(): string | undefined {
    return this.#override ?? this.kept ?? undefined;
  }

  /** The start's line: which zone, and why. */
  startWords(): string {
    if (this.#override) return `The server's time zone is ${this.#override} (USUAL_MAIL_TIME_ZONE).`;
    const kept = this.kept;
    if (kept) return `The server's time zone is ${kept}, taken from where the first person's device paired (USUAL_MAIL_TIME_ZONE overrides it).`;
    return "The server's time zone is UTC until the first person's device pairs, whose zone it takes (USUAL_MAIL_TIME_ZONE sets one).";
  }

  /** A person's device paired while none was: keeps that request's zone, once, and says so. */
  paired(fromRequest: string | null): void {
    if (this.kept) return;
    const zone = knownZone(fromRequest);
    if (!zone) {
      if (!this.#override) this.#log.info("The first person's device paired from a request with no time zone; the server's time zone stays UTC (USUAL_MAIL_TIME_ZONE sets one).");
      return;
    }
    this.#kv.put(TIME_ZONE_KEY, zone);
    this.#log.info(this.#override
      ? `Kept ${zone}, where the first person's device paired, as the server's time zone; USUAL_MAIL_TIME_ZONE (${this.#override}) overrides it.`
      : `The server's time zone is now ${zone}, taken from where the first person's device paired (USUAL_MAIL_TIME_ZONE overrides it).`);
  }
}
