/**
 * The IMAP sync cursor and message refs. Both are opaque to the server.
 *
 * A ref names a message's place: folder, UIDVALIDITY and UID. A move gives the message a new ref.
 *
 * The cursor keeps, per synced folder: its path and role, UIDVALIDITY, the UID from which mail counts as
 * new, how many messages sat below it, the UIDs reported (compact ranges), the backlog still to list
 * newest first, and how flag changes are tracked: the HIGHESTMODSEQ baseline where CONDSTORE works, or the
 * unseen and stack-keyword sets where it doesn't. Folders that vanished or changed UIDVALIDITY wait in
 * "gone" until their removals are reported.
 */
import { decodeUids } from "./uidset.ts";
import { FILINGS, type Filing } from "../names.ts";

/** A synced folder's role: the five filed categories and Screening each have a folder under "Usual Mail/". */
export type FolderRole = "inbox" | "archive" | "sent" | "trash" | "junk" | Filing;
export const FOLDER_ROLES: readonly FolderRole[] = ["inbox", "archive", "sent", "trash", "junk", ...FILINGS];

/**
 * Roles a cursor from before the fifth revision may hold for the pile folders. Read as the categories they became, so
 * such a cursor isn't refused as damaged. Their old folders ("Reads") aren't the new ones' names, so the sync finds
 * them gone; no real mailbox was ever connected to a build with piles (docs/contract-sync.md).
 */
const LEGACY_ROLES: Record<string, FolderRole> = { reads: "newsletter", receipts: "receipt" };

/**
 * Why a folder has a backlog. "first": the first sync, limited to the `since` window. "reset": its
 * UIDVALIDITY changed, also limited to the window. "new": it appeared after the first sync and is taken
 * whole. Backlogs of "reset" and "new" folders may hold the new copies of moved messages, so removals wait
 * for them; the first sync's backlog never holds removals back.
 */
export type BacklogKind = "first" | "reset" | "new";
const BACKLOG_KINDS: readonly BacklogKind[] = ["first", "reset", "new"];

export interface FolderState {
  /** Path. */
  p: string;
  /** Role when last synced. */
  r: FolderRole;
  /** UIDVALIDITY, as a decimal string. */
  v: string;
  /** UIDs from here up are new mail, sent oldest first. Below it, everything is handled except the backlog. */
  n: number;
  /** How many messages had a UID below `n` at the last check. Fewer now means something was removed. */
  x: number;
  /** UIDs below `n` that were reported and not yet reported removed. */
  u: string;
  /** Backlog: UIDs below this (inside the window, for "first" and "reset") are still to send, newest first. */
  b?: number;
  /** Set exactly when `b` is. */
  bk?: BacklogKind;
  /** CONDSTORE: every flag change up to this mod-sequence has been reported. */
  m?: string;
  /** CONDSTORE: the mod-sequence the unfinished flag round will advance `m` to. */
  ms?: string;
  /** CONDSTORE: the unfinished flag round has re-sent every changed UID up to this one. */
  mc?: number;
  /** CONDSTORE: UIDs sent whole while the flag round is unfinished, so already current. */
  mx?: string;
  /** Without CONDSTORE: reported UIDs that were unseen. */
  s?: string;
  /** Without CONDSTORE: reported UIDs carrying each stack keyword, in STACKS order. */
  k?: string[];
}

export interface GoneFolder {
  p: string;
  v: string;
  u: string;
}

export interface ImapCursor {
  v: 1;
  /**
   * The first sync's window, kept so the cursor alone describes the sync. A folder whose UIDVALIDITY changes is
   * listed again inside it, so nothing the first sync fetched is reported gone, also after the window was made smaller.
   */
  since?: string;
  /**
   * The window the first sync's backlog was narrowed to, when the window was made smaller while it was being sent.
   * Kept while a "first" backlog remains.
   */
  w?: string;
  /**
   * How many messages of the first sync's backlogs were sent so far (`SyncBatch.progress`). Kept while a "first"
   * backlog remains; a cursor written before it was kept has none, and counts from 0 when it is read.
   */
  fs?: number;
  f: FolderState[];
  g?: GoneFolder[];
}

const PREFIX = "imap1.";

export function encodeCursor(cursor: ImapCursor): string {
  return PREFIX + Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string): ImapCursor {
  if (!value.startsWith(PREFIX)) throw new Error("This cursor doesn't belong to an IMAP mailbox.");
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(value.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("The IMAP cursor is damaged.");
  }
  if (data && typeof data === "object" && Array.isArray((data as { f?: unknown }).f)) {
    for (const folder of (data as { f: Array<{ r?: unknown }> }).f) {
      if (typeof folder?.r === "string" && LEGACY_ROLES[folder.r]) folder.r = LEGACY_ROLES[folder.r];
    }
  }
  if (!isCursor(data)) throw new Error("The IMAP cursor is damaged.");
  return data;
}

function isCursor(data: unknown): data is ImapCursor {
  if (!data || typeof data !== "object") return false;
  const cursor = data as Partial<ImapCursor>;
  if (cursor.v !== 1 || !Array.isArray(cursor.f)) return false;
  if (cursor.since !== undefined && (typeof cursor.since !== "string" || Number.isNaN(Date.parse(cursor.since)))) return false;
  if (cursor.w !== undefined && (typeof cursor.w !== "string" || Number.isNaN(Date.parse(cursor.w)))) return false;
  if (cursor.fs !== undefined && !isCount(cursor.fs)) return false;
  if (cursor.g !== undefined && (!Array.isArray(cursor.g) || !cursor.g.every(isGone))) return false;
  return cursor.f.every(isFolder);
}

function isGone(data: unknown): boolean {
  const gone = data as Partial<GoneFolder>;
  return Boolean(gone) && typeof gone.p === "string" && isDecimal(gone.v) && validSet(gone.u);
}

function isFolder(data: unknown): boolean {
  const f = data as Partial<FolderState>;
  if (!f || typeof f.p !== "string" || !FOLDER_ROLES.includes(f.r as FolderRole) || !isDecimal(f.v)) return false;
  if (!isCount(f.n) || f.n < 1 || !isCount(f.x) || !validSet(f.u)) return false;
  if ((f.b === undefined) !== (f.bk === undefined)) return false;
  if (f.b !== undefined && (!isCount(f.b) || f.b < 1 || f.b > f.n || !BACKLOG_KINDS.includes(f.bk!))) return false;
  if (f.m !== undefined && !isDecimal(f.m)) return false;
  if (f.ms !== undefined && !isDecimal(f.ms)) return false;
  if (f.mc !== undefined && !isCount(f.mc)) return false;
  if (f.mx !== undefined && !validSet(f.mx)) return false;
  if (f.s !== undefined && !validSet(f.s)) return false;
  if (f.k !== undefined && (!Array.isArray(f.k) || !f.k.every(validSet))) return false;
  return true;
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSet(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  if (!/^\d+(?::\d+)?(?:,\d+(?::\d+)?)*$/.test(value)) return false;
  try {
    decodeUids(value);
    return true;
  } catch {
    return false;
  }
}

export interface MessageLocation {
  path: string;
  uidValidity: string;
  uid: number;
}

export function encodeRef(location: MessageLocation): string {
  return `${location.uidValidity}:${location.uid}:${location.path}`;
}

export function decodeRef(ref: string): MessageLocation | undefined {
  const match = /^(\d{1,20}):(\d{1,10}):(.+)$/s.exec(ref);
  if (!match) return undefined;
  const uid = Number(match[2]);
  if (!Number.isSafeInteger(uid) || uid < 1) return undefined;
  return { uidValidity: match[1]!, uid, path: match[3]! };
}
