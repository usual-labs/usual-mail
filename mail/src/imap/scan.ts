/**
 * Looking at one folder without downloading messages: what is new since the cursor, what is left of the
 * backlog, which reported messages are gone, and which changed their flags. Runs with the folder selected.
 */
import type { ImapFlow, MailboxObject, SearchObject } from "imapflow";
import { STACKS } from "@usualmail/core";
import type { BacklogKind, FolderRole, FolderState, GoneFolder } from "./cursor.ts";
import { decodeUids } from "./uidset.ts";
import { keywordFor, type Names } from "../names.ts";

export interface FolderScan {
  path: string;
  role: FolderRole;
  uidValidity: string;
  /** UIDNEXT when the scan began, or past the newest arrival if that is higher. */
  uidNext: number;
  /** The state the scan started from: a fresh one for a new folder or after a UIDVALIDITY reset. */
  prev: FolderState;
  /** The old state, when UIDVALIDITY changed: all of its messages are gone. */
  reset?: GoneFolder;
  /** New mail: present UIDs at or above prev.n, ascending. */
  arrivals: number[];
  /** The backlog still to send: UIDs below prev.b (inside the window where it has one), newest first. */
  backlog: number[];
  /** Reported UIDs that are no longer there. Empty unless the count below prev.n dropped. */
  removed: number[];
  /** Present messages below prev.n, when that was counted again. */
  presentBelow?: number;
  /** Reported UIDs whose flags changed, ascending. */
  changed: number[];
  /** CONDSTORE in use for this folder: the HIGHESTMODSEQ seen when the scan began. */
  modseq?: bigint;
  /** Without CONDSTORE: reported UIDs that are unseen now, and those carrying each stack keyword. */
  unseenNow?: Set<number>;
  keywordsNow?: Set<number>[];
  /** Whether messages here can carry custom keywords. */
  keywordsAllowed: boolean;
}

export interface ScanOptions {
  names: Names;
  /** The window for "first" and "reset" backlogs. */
  since?: Date;
  /** A narrower window for "first" backlogs: the window was made smaller while the first sync was being sent. */
  firstSince?: Date;
}

/** A folder the cursor doesn't know yet: everything below UIDNEXT is its backlog. `x` is set by the scan. */
export function freshState(path: string, role: FolderRole, mailbox: MailboxObject, kind: BacklogKind): FolderState {
  const top = Math.max(1, mailbox.uidNext);
  return { p: path, r: role, v: mailbox.uidValidity.toString(), n: top, x: 0, u: "", b: top, bk: kind };
}

export async function scanFolder(
  client: ImapFlow,
  mailbox: MailboxObject,
  role: FolderRole,
  existing: FolderState | undefined,
  firstSync: boolean,
  options: ScanOptions,
): Promise<FolderScan> {
  const path = mailbox.path;
  const uidValidity = mailbox.uidValidity.toString();
  let reset: GoneFolder | undefined;
  let prev = existing;
  if (prev && (prev.v !== uidValidity || prev.r !== role)) {
    reset = { p: prev.p, v: prev.v, u: prev.u };
    prev = undefined;
  }
  const fresh = prev === undefined;
  const state = prev ?? freshState(path, role, mailbox, firstSync ? "first" : reset ? "reset" : "new");

  const arrivals = (await uidSearch(client, { uid: `${state.n}:*` })).filter((uid) => uid >= state.n).sort((a, b) => a - b);
  const exists = client.mailbox ? client.mailbox.exists : mailbox.exists;
  if (fresh) state.x = Math.max(0, exists - arrivals.length);
  const uidNext = Math.max(mailbox.uidNext, (arrivals[arrivals.length - 1] ?? 0) + 1);

  let backlog: number[] = [];
  if (state.b !== undefined && state.b > 1) {
    const top = state.b;
    const query: SearchObject = { uid: `1:${top - 1}` };
    const window = state.bk === "first" ? (options.firstSince ?? options.since) : state.bk === "reset" ? options.since : undefined;
    if (window) query.since = window;
    backlog = (await uidSearch(client, query)).filter((uid) => uid < top).sort((a, b) => b - a);
  }

  const known = new Set(decodeUids(state.u));
  const removed: number[] = [];
  let presentBelow: number | undefined;
  if (state.n > 1 && exists - arrivals.length !== state.x) {
    const present = await uidSearch(client, { uid: `1:${state.n - 1}` });
    presentBelow = present.length;
    const presentSet = new Set(present);
    for (const uid of known) if (!presentSet.has(uid)) removed.push(uid);
    removed.sort((a, b) => a - b);
  }
  const removedSet = new Set(removed);
  const live = (uid: number) => known.has(uid) && !removedSet.has(uid);

  const keywordsAllowed = allowsKeywords(mailbox, options.names);
  const scan: FolderScan = {
    path, role, uidValidity, uidNext, prev: state, arrivals, backlog, removed, changed: [], keywordsAllowed,
  };
  if (reset) scan.reset = reset;
  if (presentBelow !== undefined) scan.presentBelow = presentBelow;
  if (state.n <= 1 || known.size === 0) {
    if (usesModseq(mailbox)) scan.modseq = mailbox.highestModseq!;
    return scan;
  }

  const below = `1:${state.n - 1}`;
  if (usesModseq(mailbox) && state.m !== undefined) {
    const modseq = mailbox.highestModseq!;
    scan.modseq = modseq;
    if (modseq > BigInt(state.m) || state.ms !== undefined) {
      const after = state.mc ?? 0;
      const current = new Set(decodeUids(state.mx ?? ""));
      const changed: number[] = [];
      for await (const item of client.fetch(below, { uid: true, flags: true }, { uid: true, changedSince: BigInt(state.m) })) {
        if (item.uid > after && live(item.uid) && !current.has(item.uid)) changed.push(item.uid);
      }
      scan.changed = changed.sort((a, b) => a - b);
    }
    return scan;
  }
  if (usesModseq(mailbox)) {
    // CONDSTORE just appeared: start tracking from here on.
    scan.modseq = mailbox.highestModseq!;
    return scan;
  }

  const unseenNow = new Set((await uidSearch(client, { seen: false, uid: below })).filter(live));
  const keywordsNow: Set<number>[] = [];
  for (const stack of STACKS) {
    const uids = keywordsAllowed ? await uidSearch(client, { keyword: keywordFor(options.names[stack]), uid: below }) : [];
    keywordsNow.push(new Set(uids.filter(live)));
  }
  scan.unseenNow = unseenNow;
  scan.keywordsNow = keywordsNow;
  if (state.s === undefined) return scan; // CONDSTORE went away: the sets start from here on.
  const changed = new Set<number>();
  diffInto(changed, new Set(decodeUids(state.s)), unseenNow, live);
  STACKS.forEach((_, i) => diffInto(changed, new Set(decodeUids(state.k?.[i] ?? "")), keywordsNow[i]!, live));
  scan.changed = [...changed].sort((a, b) => a - b);
  return scan;
}

function diffInto(out: Set<number>, before: Set<number>, now: Set<number>, live: (uid: number) => boolean): void {
  for (const uid of before) if (!now.has(uid) && live(uid)) out.add(uid);
  for (const uid of now) if (!before.has(uid)) out.add(uid);
}

export function usesModseq(mailbox: MailboxObject): boolean {
  return mailbox.highestModseq !== undefined && !mailbox.noModseq;
}

/** Whether a selected folder lets messages carry the stack keywords (PERMANENTFLAGS, RFC 3501). */
export function allowsKeywords(mailbox: MailboxObject, names: Names): boolean {
  const flags = mailbox.permanentFlags;
  if (!flags) return true;
  if (flags.has("\\*")) return true;
  return STACKS.every((stack) => [...flags].some((flag) => flag.toLowerCase() === keywordFor(names[stack]).toLowerCase()));
}

export async function uidSearch(client: ImapFlow, query: SearchObject): Promise<number[]> {
  const result = await client.search(query, { uid: true });
  if (result === false || result === undefined) throw new Error(`The IMAP server refused a search in ${client.mailbox ? client.mailbox.path : "a folder"}.`);
  return result;
}
