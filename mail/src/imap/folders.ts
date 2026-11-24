/**
 * Finding the folders that matter: the inbox, archive, sent, trash, junk (special-use flags from RFC 6154,
 * else ImapFlow's match on common and localised names, else plain names), and the folders under "Usual Mail/" for
 * the filed categories and Screening. "All Mail" style folders are never used: they hold copies of everything.
 */
import type { ImapFlow, ListResponse } from "imapflow";
import type { FolderRole } from "./cursor.ts";
import { FILINGS, type Filing, type Names } from "../names.ts";

export interface FolderMap {
  /** The existing folder for each role. */
  byRole: Partial<Record<FolderRole, string>>;
  /** Every selectable path, to tell whether a folder still exists. */
  paths: Set<string>;
  /** The path each category's or Screening's folder has, or would have once created. */
  filingPaths: Record<Filing, string>;
}

const SPECIAL_USE: Partial<Record<FolderRole, string>> = {
  archive: "\\Archive",
  sent: "\\Sent",
  trash: "\\Trash",
  junk: "\\Junk",
};

const FALLBACK_NAMES: Partial<Record<FolderRole, string[]>> = {
  archive: ["archive", "archives"],
  sent: ["sent", "sent items", "sent messages", "sent mail"],
  trash: ["trash", "deleted items", "deleted messages", "deleted"],
  junk: ["junk", "spam", "junk e-mail", "junk email", "bulk mail"],
};

/** Names for folders this provider creates when the server has none. */
export const CREATE_NAMES: Partial<Record<FolderRole, string>> = { archive: "Archive", sent: "Sent", trash: "Trash" };

export async function discoverFolders(client: ImapFlow, names: Names): Promise<FolderMap> {
  const listed = await client.list();
  const selectable = listed.filter((entry) => !hasFlag(entry, "\\Noselect") && !hasFlag(entry, "\\NonExistent"));
  const paths = new Set(selectable.map((entry) => entry.path));
  const filingPaths = {} as Record<Filing, string>;
  const byRole: Partial<Record<FolderRole, string>> = { inbox: "INBOX" };
  const taken = new Set(["INBOX"]);

  for (const filing of FILINGS) {
    const wanted = serverPath(client, names[filing]);
    const found =
      selectable.find((entry) => entry.path === wanted) ??
      selectable.find((entry) => entry.path.toLowerCase() === wanted.toLowerCase());
    filingPaths[filing] = found?.path ?? wanted;
    if (found) {
      byRole[filing] = found.path;
      taken.add(found.path);
    }
  }

  for (const role of ["archive", "sent", "trash", "junk"] as const) {
    const candidates = selectable.filter((entry) => !taken.has(entry.path));
    const flag = SPECIAL_USE[role]!;
    const bySource = (source: ListResponse["specialUseSource"]) =>
      candidates.filter((entry) => entry.specialUse === flag && entry.specialUseSource === source);
    const byName = candidates.filter((entry) => FALLBACK_NAMES[role]!.includes(leafName(client, entry.path).toLowerCase()));
    const pick = [...bySource("user"), ...bySource("extension"), ...bySource("name"), ...byName].sort(shallowFirst)[0];
    if (pick) {
      byRole[role] = pick.path;
      taken.add(pick.path);
    }
  }
  return { byRole, paths, filingPaths };
}

function shallowFirst(a: ListResponse, b: ListResponse): number {
  return a.parent.length - b.parent.length;
}

function hasFlag(entry: ListResponse, flag: string): boolean {
  for (const f of entry.flags) if (f.toLowerCase() === flag.toLowerCase()) return true;
  return false;
}

function leafName(client: ImapFlow, path: string): string {
  const delimiter = client.namespace?.delimiter;
  const parts = delimiter ? path.split(delimiter) : [path];
  return parts[parts.length - 1] ?? path;
}

/** "Usual Mail/Newsletters" as this server spells it: personal namespace prefix and its own delimiter. */
export function serverPath(client: ImapFlow, name: string): string {
  const prefix = client.namespace?.prefix ?? "";
  const delimiter = client.namespace?.delimiter;
  const segments = name.split("/").filter(Boolean);
  const joined = delimiter ? segments.join(delimiter) : segments.join("/");
  return prefix && !joined.startsWith(prefix) ? prefix + joined : joined;
}

/** Creates a folder by name (segments split on "/") and returns its path; fine if it already exists. */
export async function createFolder(client: ImapFlow, name: string): Promise<string> {
  const segments = name.split("/").filter(Boolean);
  const created = await client.mailboxCreate(segments);
  return created.path;
}
