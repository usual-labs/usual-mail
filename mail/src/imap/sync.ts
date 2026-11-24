/**
 * IMAP sync: one call scans every folder that matters, picks up to `limit` messages (new mail first, then
 * flag changes, then the backlog newest first), fetches them, and moves the cursor on. New mail and the
 * backlog are fetched whole; a flag change is only the flags, sent as `changed`, since an IMAP message's
 * content never changes. A message this provider moved itself (`OwnMoves`) is new in its folder but already
 * held by the server under the ref `apply` returned, so it too is only its flags, sent as `changed`.
 *
 * A message moved in another app shows up as a removal in one folder and a new message in another. The
 * server must see the new copy before or with the removal, so removals are held back while new mail, or the
 * backlog of a folder that is new or was reset, is still waiting. The first sync's backlog doesn't hold
 * them: a message moved after it was sent always comes back as new mail. Before removals are reported, the
 * folders are checked once more for mail that arrived while the others were being scanned.
 */
import type { ImapFlow } from "imapflow";
import { STACKS, type ProviderChange, type ProviderMessage, type SyncBatch, type SyncProgress } from "@usualmail/core";
import type { ImapConnection } from "./connection.ts";
import { decodeCursor, decodeRef, encodeCursor, encodeRef, type FolderRole, type FolderState, type GoneFolder, type ImapCursor } from "./cursor.ts";
import { fetchChanges, fetchMessages, hasFlag, type FolderContext } from "./convert.ts";
import { discoverFolders } from "./folders.ts";
import type { OwnMoves } from "./own-moves.ts";
import { scanFolder, type FolderScan } from "./scan.ts";
import { decodeUids, encodeUids } from "./uidset.ts";
import { keywordFor, type Names } from "../names.ts";

export interface SyncContext {
  names: Names;
  ownAddresses: readonly string[];
  /** ProviderOptions.since, for the first sync. */
  since?: string;
  /** Messages this provider moved itself: sent as changes, since the server already holds their new refs. */
  own?: OwnMoves;
}

export const DEFAULT_LIMIT = 100;
const SYNC_ORDER: readonly FolderRole[] = [
  "inbox", "sent", "archive", "newsletter", "invoice", "receipt", "notification", "otp", "screening", "junk", "trash",
];

interface Pick {
  arrivals: number[];
  changed: number[];
  backlog: number[];
}

export async function syncImap(connection: ImapConnection, cursorText: string | null, limit: number, context: SyncContext): Promise<SyncBatch> {
  const cursor: ImapCursor = cursorText ? decodeCursor(cursorText) : { v: 1, f: [] };
  if (!cursorText && context.since) cursor.since = new Date(context.since).toISOString();
  const firstSync = cursorText === null;
  const since = cursor.since ? new Date(cursor.since) : undefined;
  const firstSince = narrowedWindow(cursor, context.since);

  const map = await connection.run((client) => discoverFolders(client, context.names));
  const targets = SYNC_ORDER.flatMap((role) => (map.byRole[role] ? [{ role, path: map.byRole[role]! }] : []));
  const oldByPath = new Map(cursor.f.map((state) => [state.p, state]));
  const gone: GoneFolder[] = [...(cursor.g ?? [])];
  for (const state of cursor.f) {
    if (!targets.some((t) => t.path === state.p)) gone.push({ p: state.p, v: state.v, u: state.u });
  }

  const scans: FolderScan[] = [];
  for (const target of targets) {
    try {
      const scan = await connection.withMailbox(
        target.path,
        (client, mailbox) => scanFolder(client, mailbox, target.role, oldByPath.get(target.path), firstSync, { names: context.names, since, ...(firstSince && { firstSince }) }),
        true,
        true,
      );
      if (scan.reset) gone.push(scan.reset);
      scans.push(scan);
    } catch (error) {
      if (!(error as { mailboxMissing?: boolean }).mailboxMissing) throw error;
      const old = oldByPath.get(target.path);
      if (old) gone.push({ p: old.p, v: old.v, u: old.u });
    }
  }

  const picks = await pickWork(connection, scans, limit);
  const upserted: ProviderMessage[] = [];
  const changed: ProviderChange[] = [];
  const fetchedFlags = new Map<string, Map<number, Set<string>>>();
  const ownReported: string[] = [];
  for (const scan of scans) {
    const pick = picks.get(scan.path)!;
    const picked = [...pick.arrivals, ...pick.backlog];
    if (!picked.length && !pick.changed.length) continue;
    // A message this provider moved here itself is only its flags: the server holds it under this ref already.
    const own = picked.filter((uid) => context.own?.has(encodeRef({ path: scan.path, uidValidity: scan.uidValidity, uid })));
    const whole = picked.filter((uid) => !own.includes(uid));
    const folder: FolderContext = {
      path: scan.path, role: scan.role, uidValidity: scan.uidValidity, names: context.names, ownAddresses: context.ownAddresses, keywordsAllowed: scan.keywordsAllowed,
    };
    const flags = new Map<number, Set<string>>();
    await connection.withMailbox(scan.path, async (client) => {
      for (const item of await fetchChanges(client, [...pick.changed, ...own], folder)) {
        if (own.includes(item.uid)) ownReported.push(item.change.ref);
        changed.push(item.change);
        flags.set(item.uid, item.flags);
      }
      for (const item of await fetchMessages(client, whole, folder)) {
        upserted.push(item.message);
        flags.set(item.uid, item.flags);
      }
    });
    fetchedFlags.set(scan.path, flags);
  }

  let pendingWork = 0;
  let holding = 0;
  for (const scan of scans) {
    const pick = picks.get(scan.path)!;
    const arrivalsLeft = scan.arrivals.length - pick.arrivals.length;
    const backlogLeft = scan.backlog.length - pick.backlog.length;
    pendingWork += arrivalsLeft + backlogLeft + scan.changed.length - pick.changed.length;
    holding += arrivalsLeft + (scan.prev.bk === "first" ? 0 : backlogLeft);
  }
  const found = gone.length > 0 || scans.some((scan) => scan.removed.length > 0);
  const raced = found && holding === 0 && (await arrivedSinceScan(connection, scans));
  const reportRemovals = holding === 0 && !raced;

  const removed: string[] = [];
  const next: ImapCursor = { v: 1, f: [] };
  if (cursor.since) next.since = cursor.since;
  for (const scan of scans) {
    if (reportRemovals) {
      for (const uid of scan.removed) removed.push(encodeRef({ path: scan.path, uidValidity: scan.uidValidity, uid }));
      const gone = ownGone(scan, context.own);
      removed.push(...gone);
      context.own?.reported(gone);
    }
    next.f.push(advance(scan, picks.get(scan.path)!, fetchedFlags.get(scan.path) ?? new Map(), reportRemovals, context.names));
  }
  if (firstSince && next.f.some((folder) => folder.bk === "first")) next.w = firstSince.toISOString();
  const progress = firstSyncProgress(cursor, scans, picks, firstSync);
  if (progress && next.f.some((folder) => folder.bk === "first")) next.fs = progress.sent;
  if (reportRemovals) {
    for (const folder of gone) {
      for (const uid of decodeUids(folder.u)) removed.push(encodeRef({ path: folder.p, uidValidity: folder.v, uid }));
    }
  } else if (gone.length) {
    next.g = gone;
  }
  upserted.sort((a, b) => b.date.localeCompare(a.date));
  context.own?.reported(ownReported);
  const batch: SyncBatch = { upserted, changed, removed, cursor: encodeCursor(next), more: pendingWork > 0 || raced };
  if (progress) batch.progress = progress;
  return batch;
}

/**
 * How far the first sync has got once this batch is in, while it is still sending its "first" backlogs (and on the
 * batch that sends the last of them): what earlier batches sent (`fs`) and this one picks, of that and what the scans
 * found still to send inside the window. Each scan searches its backlog again, so a smaller window, or mail removed
 * meanwhile, lowers the total. Undefined on later syncs.
 */
function firstSyncProgress(cursor: ImapCursor, scans: FolderScan[], picks: Map<string, Pick>, firstSync: boolean): SyncProgress | undefined {
  const first = scans.filter((scan) => scan.prev.bk === "first");
  if (!firstSync && cursor.fs === undefined && first.length === 0) return undefined;
  const picked = first.reduce((sum, scan) => sum + picks.get(scan.path)!.backlog.length, 0);
  const left = first.reduce((sum, scan) => sum + scan.backlog.length, 0) - picked;
  const sent = (cursor.fs ?? 0) + picked;
  return { sent, total: sent + left };
}

/**
 * The window the first sync's backlog now takes, when it is narrower than the one it began with: the provider was
 * opened with a later `since` while a "first" backlog remained (the window was made smaller meanwhile), or an earlier
 * call narrowed it. A larger window never widens it. Undefined when nothing was narrowed. The cursor's own `since`
 * stays the window the first sync began with, for folders listed again after a UIDVALIDITY change.
 */
function narrowedWindow(cursor: ImapCursor, given: string | undefined): Date | undefined {
  const earlier = cursor.w ? new Date(cursor.w) : undefined;
  if (!given || !cursor.f.some((folder) => folder.bk === "first")) return earlier;
  const wanted = new Date(given);
  const current = earlier ?? (cursor.since ? new Date(cursor.since) : undefined);
  if (Number.isNaN(wanted.getTime()) || (current && wanted <= current)) return earlier;
  return wanted;
}

/** New mail first (oldest first, so the cursor can move past it), then flag changes, then the backlog newest first. */
async function pickWork(connection: ImapConnection, scans: FolderScan[], limit: number): Promise<Map<string, Pick>> {
  const picks = new Map<string, Pick>(scans.map((scan) => [scan.path, { arrivals: [], changed: [], backlog: [] }]));
  let budget = Math.max(1, limit);
  budget = await merge(connection, scans, budget, (scan) => scan.arrivals, (scan, uid) => picks.get(scan.path)!.arrivals.push(uid), "oldest");
  for (const scan of scans) {
    const take = scan.changed.slice(0, budget);
    picks.get(scan.path)!.changed = take;
    budget -= take.length;
  }
  await merge(connection, scans, budget, (scan) => scan.backlog, (scan, uid) => picks.get(scan.path)!.backlog.push(uid), "newest");
  return picks;
}

/** Takes up to `budget` items across folders, each folder's in its own order, merged by arrival time. */
async function merge(
  connection: ImapConnection,
  scans: FolderScan[],
  budget: number,
  items: (scan: FolderScan) => number[],
  take: (scan: FolderScan, uid: number) => void,
  order: "oldest" | "newest",
): Promise<number> {
  if (budget <= 0) return budget;
  const queues: { scan: FolderScan; items: { uid: number; at: number }[] }[] = [];
  for (const scan of scans) {
    const head = items(scan).slice(0, budget);
    if (!head.length) continue;
    const dates = await connection.withMailbox(scan.path, (client) => arrivalTimes(client, head));
    queues.push({ scan, items: head.map((uid) => ({ uid, at: dates.get(uid) ?? 0 })) });
  }
  const better = (a: number, b: number) => (order === "oldest" ? a < b : a > b);
  while (budget > 0) {
    let best: (typeof queues)[number] | undefined;
    for (const queue of queues) {
      if (queue.items.length && (!best || better(queue.items[0]!.at, best.items[0]!.at))) best = queue;
    }
    if (!best) break;
    take(best.scan, best.items.shift()!.uid);
    budget--;
  }
  return budget;
}

async function arrivalTimes(client: ImapFlow, uids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for await (const item of client.fetch(encodeUids(uids), { uid: true, internalDate: true }, { uid: true })) {
    const time = item.internalDate ? new Date(item.internalDate).getTime() : 0;
    out.set(item.uid, Number.isNaN(time) ? 0 : time);
  }
  return out;
}

/**
 * Whether mail arrived in any folder after it was scanned. A message moved out of a folder scanned late
 * may have landed in one scanned early; its new copy must be sent before its removal is reported.
 */
async function arrivedSinceScan(connection: ImapConnection, scans: FolderScan[]): Promise<boolean> {
  return connection.run(async (client) => {
    for (const scan of scans) {
      const status = await client.status(scan.path, { uidNext: true });
      if (status && status.uidNext !== undefined && status.uidNext > scan.uidNext) return true;
    }
    return false;
  });
}

/** The folder's state after this batch. */
function advance(scan: FolderScan, pick: Pick, fetchedFlags: Map<number, Set<string>>, reportRemovals: boolean, names: Names): FolderState {
  const prev = scan.prev;
  const state: FolderState = { p: scan.path, r: scan.role, v: scan.uidValidity, n: prev.n, x: prev.x, u: prev.u };
  const known = new Set(decodeUids(prev.u));

  // Removals: only once they are reported. A recount that found nothing missing can be kept either way.
  if (scan.presentBelow !== undefined && (reportRemovals || scan.removed.length === 0)) {
    for (const uid of scan.removed) known.delete(uid);
    state.x = scan.presentBelow;
  }

  // New mail: everything below the next one not yet sent has been handled.
  const remaining = scan.arrivals.slice(pick.arrivals.length);
  const nextN = remaining.length ? remaining[0]! : Math.max(scan.uidNext, prev.n);
  state.x += scan.arrivals.filter((uid) => uid < nextN).length;
  state.n = nextN;

  // Backlog: what is left lies below the oldest one sent.
  if (prev.b !== undefined && scan.backlog.length > pick.backlog.length) {
    state.b = pick.backlog.length ? pick.backlog[pick.backlog.length - 1]! : prev.b;
    state.bk = prev.bk!;
  }
  for (const uid of [...pick.arrivals, ...pick.backlog]) if (fetchedFlags.has(uid)) known.add(uid);
  state.u = encodeUids(known);

  // Flags.
  if (scan.modseq !== undefined) {
    const snapshot = prev.ms ?? scan.modseq.toString();
    if (prev.m === undefined) {
      state.m = scan.modseq.toString();
    } else if (pick.changed.length < scan.changed.length) {
      // The round goes on. Messages sent whole meanwhile are current already; don't send them again as changes.
      state.m = prev.m;
      state.ms = snapshot;
      state.mc = pick.changed[pick.changed.length - 1] ?? prev.mc ?? 0;
      const sentWhole = [...decodeUids(prev.mx ?? ""), ...[...pick.arrivals, ...pick.backlog].filter((uid) => fetchedFlags.has(uid))];
      if (sentWhole.length) state.mx = encodeUids(sentWhole);
    } else {
      state.m = snapshot;
    }
    return state;
  }
  const unseen = new Set(prev.s !== undefined ? decodeUids(prev.s) : (scan.unseenNow ?? []));
  const keywords = STACKS.map((_, i) => new Set(prev.k?.[i] !== undefined ? decodeUids(prev.k[i]!) : (scan.keywordsNow?.[i] ?? [])));
  for (const uid of [...unseen]) if (!known.has(uid)) unseen.delete(uid);
  for (const set of keywords) for (const uid of [...set]) if (!known.has(uid)) set.delete(uid);
  for (const [uid, flags] of fetchedFlags) {
    if (!known.has(uid)) continue;
    toggle(unseen, uid, !hasFlag(flags, "\\Seen"));
    STACKS.forEach((stack, i) => toggle(keywords[i]!, uid, hasFlag(flags, keywordFor(names[stack]))));
  }
  state.s = encodeUids(unseen);
  state.k = keywords.map((set) => encodeUids(set));
  return state;
}

function toggle(set: Set<number>, uid: number, on: boolean): void {
  if (on) set.add(uid);
  else set.delete(uid);
}

/**
 * Refs this provider gave by its own moves into the scanned folder that are no longer there: above what the cursor
 * covers (at or above `prev.n`, below UIDNEXT) and not among the arrivals. Another app moved or deleted the message
 * before a sync saw it, so no scan will ever report it.
 */
function ownGone(scan: FolderScan, own: OwnMoves | undefined): string[] {
  if (!own) return [];
  const present = new Set(scan.arrivals);
  return own.in(scan.path, scan.uidValidity).filter((ref) => {
    const uid = decodeRef(ref)?.uid;
    return uid !== undefined && uid >= scan.prev.n && uid < scan.uidNext && !present.has(uid);
  });
}
