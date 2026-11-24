/**
 * Fetching messages from one selected folder and turning them into ProviderMessages, or, for messages the
 * server already has, into ProviderChanges from their flags alone.
 */
import type { ImapFlow } from "imapflow";
import { FILED_CATEGORIES, STACKS, type FiledCategory, type ProviderChange, type ProviderMessage, type ProviderPlacement, type Stack } from "@usualmail/core";
import { encodeRef, type FolderRole } from "./cursor.ts";
import { encodeUids } from "./uidset.ts";
import { parseOrNote } from "../message/parse.ts";
import { keywordFor, type Names } from "../names.ts";

export interface FetchedMessage {
  uid: number;
  flags: Set<string>;
  message: ProviderMessage;
}

export interface FetchedChange {
  uid: number;
  flags: Set<string>;
  change: ProviderChange;
}

export interface FolderContext {
  path: string;
  role: FolderRole;
  uidValidity: string;
  names: Names;
  ownAddresses: readonly string[];
  /** Whether this folder can keep custom keywords, so stacks. */
  keywordsAllowed: boolean;
}

/** Fetches whole sources for `uids` in the selected folder. Missing UIDs (expunged meanwhile) are left out. */
export async function fetchMessages(client: ImapFlow, uids: readonly number[], context: FolderContext): Promise<FetchedMessage[]> {
  if (!uids.length) return [];
  const raw: { uid: number; flags: Set<string>; internalDate?: Date; source: Buffer }[] = [];
  for await (const item of client.fetch(encodeUids(uids), { uid: true, flags: true, internalDate: true, source: true }, { uid: true })) {
    if (!item.source) continue;
    const internalDate = item.internalDate ? new Date(item.internalDate) : undefined;
    raw.push({ uid: item.uid, flags: item.flags ?? new Set(), internalDate, source: item.source });
  }
  const out: FetchedMessage[] = [];
  for (const item of raw.sort((a, b) => a.uid - b.uid)) {
    const ref = encodeRef({ path: context.path, uidValidity: context.uidValidity, uid: item.uid });
    // From naming the mailbox proves nothing (anyone can write it): only the Sent folder makes mail the mailbox's own.
    const { fromSelf: _fromSelf, ...parsed } = await parseOrNote(item.source, { ownAddresses: context.ownAddresses, receivedAt: item.internalDate }, ref);
    const message: ProviderMessage = {
      ...parsed,
      ref,
      seen: hasFlag(item.flags, "\\Seen"),
      outgoing: context.role === "sent",
      placement: placementFor(context.role, item.flags, context.names, context.keywordsAllowed),
    };
    out.push({ uid: item.uid, flags: item.flags, message });
  }
  return out;
}

/** Fetches only the flags of `uids`: their content can't have changed, since IMAP messages never change. */
export async function fetchChanges(client: ImapFlow, uids: readonly number[], context: FolderContext): Promise<FetchedChange[]> {
  if (!uids.length) return [];
  const out: FetchedChange[] = [];
  for await (const item of client.fetch(encodeUids(uids), { uid: true, flags: true }, { uid: true })) {
    const flags = item.flags ?? new Set<string>();
    const ref = encodeRef({ path: context.path, uidValidity: context.uidValidity, uid: item.uid });
    out.push({
      uid: item.uid,
      flags,
      change: { ref, seen: hasFlag(flags, "\\Seen"), placement: placementFor(context.role, flags, context.names, context.keywordsAllowed) },
    });
  }
  return out.sort((a, b) => a.uid - b.uid);
}

/**
 * Where a message in a folder with this role sits, in Usual Mail's terms. A message has one folder, so a category's
 * folder is that category, and the Screening folder is screened with no `category` at all: the server keeps a
 * screened message's category itself. `stack` is the stack or null, and left out where the folder can't keep
 * keywords: there the server keeps the stack itself.
 */
export function placementFor(role: FolderRole, flags: Set<string>, names: Names, keywordsAllowed: boolean): ProviderPlacement {
  const placement: ProviderPlacement = { inInbox: role === "inbox", screened: role === "screening", trashed: role === "trash", spam: role === "junk" };
  if (role !== "screening") placement.category = isCategoryRole(role) ? role : null;
  if (keywordsAllowed) placement.stack = stackFromFlags(flags, names) ?? null;
  return placement;
}

export function isCategoryRole(role: FolderRole): role is FiledCategory {
  return (FILED_CATEGORIES as readonly string[]).includes(role);
}

export function stackFromFlags(flags: Set<string>, names: Names): Stack | undefined {
  return STACKS.find((stack) => hasFlag(flags, keywordFor(names[stack])));
}

export function hasFlag(flags: Set<string>, flag: string): boolean {
  if (flags.has(flag)) return true;
  const lower = flag.toLowerCase();
  for (const f of flags) if (f.toLowerCase() === lower) return true;
  return false;
}
