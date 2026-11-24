/**
 * Writing Usual Mail's changes back to an IMAP mailbox. A message lives in one folder, so placement is a move:
 * screened is the Screening folder (which keeps no category: the server keeps it), else a filed category is its
 * folder under "Usual Mail/", else in the inbox is INBOX and out of it the archive folder. Stacks are keywords.
 * `untrash` is a placement out of the trash. A move returns the message's new ref.
 */
import type { ImapFlow } from "imapflow";
import { STACKS, type ProviderOp, type ProviderOpResult, type Stack } from "@usualmail/core";
import type { ImapConnection } from "./connection.ts";
import { hasFlag } from "./convert.ts";
import { decodeRef, encodeRef, type FolderRole, type MessageLocation } from "./cursor.ts";
import { CREATE_NAMES, createFolder, discoverFolders, type FolderMap } from "./folders.ts";
import { allowsKeywords, uidSearch } from "./scan.ts";
import type { OwnMoves } from "./own-moves.ts";
import { FILINGS, IN_INBOX_ONLY_UNFILED, keywordFor, type Names } from "../names.ts";

export const NO_KEYWORDS_NOTE = "This IMAP folder can't keep custom keywords, so the stack is kept only in Usual Mail.";

/**
 * Applies each op in turn. A move that gives a message a new ref is noted in `own`, so sync needn't fetch it again,
 * except a move out of the junk folder: a message that leaves spam is always sent whole, since the server ignored it
 * while it was there (docs/contract.md, "Providers").
 */
export async function applyImap(connection: ImapConnection, ops: ProviderOp[], names: Names, own?: OwnMoves): Promise<ProviderOpResult[]> {
  const results: ProviderOpResult[] = [];
  let folders: FolderMap | undefined;
  const folderMap = async () => (folders ??= await connection.run((client) => discoverFolders(client, names)));
  for (const op of ops) {
    let result: ProviderOpResult;
    try {
      result = await applyOne(connection, op, names, folderMap, () => (folders = undefined));
    } catch (error) {
      result = { ok: false, error: describe(error) };
    }
    if (result.ok && result.ref && result.ref !== op.ref && own && !(await fromJunk(op.ref, folderMap))) own.moved(op.ref, result.ref);
    results.push(result);
  }
  return results;
}

/** Whether the ref was in the junk folder. When the folders can't be listed, it says yes: a download too many is harmless. */
async function fromJunk(ref: string, folderMap: () => Promise<FolderMap>): Promise<boolean> {
  try {
    const junk = (await folderMap()).byRole.junk;
    return junk !== undefined && decodeRef(ref)?.path === junk;
  } catch {
    return true;
  }
}

async function applyOne(
  connection: ImapConnection,
  op: ProviderOp,
  names: Names,
  folderMap: () => Promise<FolderMap>,
  forgetFolders: () => void,
): Promise<ProviderOpResult> {
  const location = decodeRef(op.ref);
  if (!location) return { ok: false, error: "This isn't a ref from this IMAP mailbox." };
  // A message lives in one folder: the inbox or a category's or Screening's folder, never both
  // (docs/contract-sync.md, "Providers").
  if ((op.op === "place" || op.op === "untrash") && op.inInbox && (op.category !== null || op.screened)) {
    return { ok: false, error: IN_INBOX_ONLY_UNFILED };
  }

  const ensure = async (role: FolderRole): Promise<string> => {
    const map = await folderMap();
    const existing = map.byRole[role];
    if (existing) return existing;
    const name = (FILINGS as readonly string[]).includes(role) ? names[role as keyof Names] : CREATE_NAMES[role];
    if (!name) throw new Error(`This mailbox has no ${role} folder.`);
    const path = await connection.run((client) => createFolder(client, name));
    forgetFolders();
    return path;
  };

  if (op.op === "seen") {
    await inFolder(connection, location, async (client) => {
      const store = op.seen ? client.messageFlagsAdd.bind(client) : client.messageFlagsRemove.bind(client);
      await store(String(location.uid), ["\\Seen"], { uid: true });
    });
    return { ok: true, ref: op.ref };
  }

  if (op.op === "trash") {
    const map = await folderMap();
    if (map.byRole.trash === location.path) return { ok: true, ref: op.ref };
    const trash = await ensure("trash");
    const moved = await inFolder(connection, location, (client) => moveSelected(client, location, trash));
    return { ok: true, ...(await newRef(connection, trash, moved)) };
  }

  // "place", and "untrash", which is a placement out of the trash.
  const role: FolderRole = op.screened ? "screening" : op.category ?? (op.inInbox ? "inbox" : "archive");
  const target = role === "inbox" ? "INBOX" : await ensure(role);
  return placeIn(connection, location, target, op.stack, names);
}

/**
 * Puts a message in `target` with `stack` (or none). The keywords are set where the message is, when that
 * folder allows them, so they travel with the move. When a stack is wanted somewhere else, the target is
 * checked too and the keyword set there, since a server may drop keywords on a move or the source may not
 * have taken them. Where the target can't keep keywords, the result says so in `note`.
 */
async function placeIn(connection: ImapConnection, location: MessageLocation, target: string, stack: Stack | undefined, names: Names): Promise<ProviderOpResult> {
  const here = await inFolder(connection, location, async (client) => {
    const allowed = Boolean(client.mailbox && allowsKeywords(client.mailbox, names));
    if (allowed) await setStackKeywords(client, location.uid, stack, names);
    if (target === location.path) return { allowed, moved: undefined };
    return { allowed, moved: await moveSelected(client, location, target) };
  });
  if (!here.moved) {
    const same: ProviderOpResult = { ok: true, ref: encodeRef(location) };
    return stack && !here.allowed ? { ...same, note: NO_KEYWORDS_NOTE } : same;
  }
  const result: ProviderOpResult = { ok: true, ...(await newRef(connection, target, here.moved)) };
  if (!stack) return result;
  const kept = await connection.withMailbox(target, async (client, mailbox) => {
    if (!allowsKeywords(mailbox, names)) return false;
    const moved = result.ref ? decodeRef(result.ref) : undefined;
    if (moved) await setStackKeywords(client, moved.uid, stack, names);
    return Boolean(moved) || here.allowed;
  });
  return kept ? result : { ...result, note: NO_KEYWORDS_NOTE };
}

/** Puts the stack's keyword on and the other one off, sending only what differs. The folder is selected. */
async function setStackKeywords(client: ImapFlow, uid: number, stack: Stack | undefined, names: Names): Promise<void> {
  const item = await client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
  const flags = item ? (item.flags ?? new Set<string>()) : new Set<string>();
  const add = stack && !hasFlag(flags, keywordFor(names[stack])) ? [keywordFor(names[stack])] : [];
  const remove = STACKS.filter((s) => s !== stack && hasFlag(flags, keywordFor(names[s]))).map((s) => keywordFor(names[s]));
  if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true });
  if (add.length) await client.messageFlagsAdd(String(uid), add, { uid: true });
}

interface Moved {
  uid?: number;
  uidValidity?: string;
  messageId?: string;
  uidNextBefore?: number;
}

/** Moves one message out of the selected folder. Gives the new UID when the server says it (UIDPLUS). */
async function moveSelected(client: ImapFlow, location: MessageLocation, target: string): Promise<Moved> {
  const envelope = await client.fetchOne(String(location.uid), { uid: true, envelope: true }, { uid: true });
  const status = await client.status(target, { uidNext: true });
  const result = await client.messageMove(String(location.uid), target, { uid: true });
  if (!result) throw new Error(`The server refused to move the message to ${target}.`);
  const moved: Moved = {};
  const uid = result.uidMap?.get(location.uid);
  if (uid && result.uidValidity !== undefined) {
    moved.uid = uid;
    moved.uidValidity = result.uidValidity.toString();
  }
  const messageId = envelope ? envelope.envelope?.messageId : undefined;
  if (messageId) moved.messageId = messageId;
  if (status && status.uidNext !== undefined) moved.uidNextBefore = status.uidNext;
  return moved;
}

/** The moved message's new ref: from COPYUID, else by its Message-ID among the target's new UIDs. */
async function newRef(connection: ImapConnection, target: string, moved: Moved): Promise<{ ref?: string }> {
  if (moved.uid && moved.uidValidity) return { ref: encodeRef({ path: target, uidValidity: moved.uidValidity, uid: moved.uid }) };
  const from = moved.uidNextBefore ?? 1;
  return connection.withMailbox(target, async (client, mailbox) => {
    const query = moved.messageId ? { uid: `${from}:*`, header: { "message-id": moved.messageId } } : { uid: `${from}:*` };
    const found = (await uidSearch(client, query)).filter((uid) => uid >= from).sort((a, b) => a - b);
    const uid = moved.messageId || found.length === 1 ? found[found.length - 1] : undefined;
    return uid ? { ref: encodeRef({ path: target, uidValidity: mailbox.uidValidity.toString(), uid }) } : {};
  });
}

/** Selects the message's folder, checks it is still the same folder and the message is still there. */
async function inFolder<T>(connection: ImapConnection, location: MessageLocation, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  return connection.withMailbox(location.path, async (client, mailbox) => {
    if (mailbox.uidValidity.toString() !== location.uidValidity) throw new StaleRef();
    const found = await uidSearch(client, { uid: String(location.uid) });
    if (!found.includes(location.uid)) throw new StaleRef();
    return fn(client);
  }, false);
}

class StaleRef extends Error {
  constructor() {
    super("The message is no longer where Usual Mail last saw it. Sync again.");
  }
}

function describe(error: unknown): string {
  const e = error as { mailboxMissing?: boolean; responseText?: string; message?: string };
  if (e?.mailboxMissing) return "The message's folder no longer exists. Sync again.";
  return e?.responseText || e?.message || String(error);
}
