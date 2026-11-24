/**
 * How many days of mail a new inbox's first sync takes (docs/contract-sync.md, "Sync"). It is the one setting that
 * decides how much older mail the server holds, and so how much the server's AI works through: the AI processes all
 * synced mail that isn't done. Person only.
 */

/** The most days a first sync may take. The fewest is 1. */
export const FIRST_SYNC_MAX_DAYS = 36_500;
/** What a server takes when neither its host nor a person set it. */
export const FIRST_SYNC_DEFAULT_DAYS = 30;

/** Where the server took the window from. */
export type FirstSyncSource = "environment" | "settings" | "default";

export interface FirstSyncWindow {
  /** 1 to `FIRST_SYNC_MAX_DAYS`. A window counts back from when each inbox was connected. */
  days: number;
  /**
   * `environment`: USUAL_MAIL_SYNC_DAYS where the server starts, which only its host changes. `settings`: the data
   * directory's settings.json, which `usual-mail init`, `usual-mail sync-days` and `updateFirstSyncWindow` write.
   * `default`: neither, so 30.
   */
  setBy: FirstSyncSource;
  /**
   * Whether a person may change it with `updateFirstSyncWindow`: false while the environment sets it, and where the
   * host keeps no settings (demo mode).
   */
  changeable: boolean;
}

/** A new window. */
export interface FirstSyncWindowPatch {
  /** 1 to `FIRST_SYNC_MAX_DAYS`. */
  days: number;
}

/**
 * How far an inbox's first sync has got (docs/contract-sync.md, "How far a first sync has got"; the owner's decision
 * of 2026-11-23): `fetched` of the `total` messages its window holds, as the provider counts them (messages, not
 * conversations; spam and trash in the window count too).
 */
export interface FirstSyncProgress {
  /** Messages of the window fetched so far. */
  fetched: number;
  /**
   * Messages the window holds, fetched and still to fetch, as the provider counts them now. Never below `fetched`. It
   * falls when the window is made smaller while the first sync runs, or when mail in it leaves the mailbox first.
   */
  total: number;
}

/**
 * The server shows a first sync's count once it has run this long, then at most this often: each change in between
 * waits for the next. A first sync that ends sooner never shows one.
 */
export const FIRST_SYNC_PROGRESS_EVERY_MS = 2_000;

/** What every interface calls a first sync that has said how far it got. */
export const FIRST_SYNC_FETCHING = "Fetching your mail";

/** "120 of 340"; "1,200 of 3,400". */
export function firstSyncCount(progress: FirstSyncProgress): string {
  return `${grouped(progress.fetched)} of ${grouped(progress.total)}`;
}

/** "Fetching your mail · 120 of 340". */
export function firstSyncWords(progress: FirstSyncProgress): string {
  return `${FIRST_SYNC_FETCHING} · ${firstSyncCount(progress)}`;
}

/** 3400 as "3,400", the same on every machine (no locale). */
function grouped(n: number): string {
  return String(Math.max(0, Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
