// The Public Suffix List the server ships, in suffixes.json, written by `scripts/update-suffixes.mjs` from a pinned
// commit. Until that has been run the file holds no rules (`source` null), and the server shows no sender pictures at
// all: it never guesses a registrable domain, so it never fetches anything for one (docs/contract-avatars.md).

import list from "./suffixes.json" with { type: "json" };
import { SuffixList, type SuffixRules } from "./suffixes.ts";

interface ShippedList extends SuffixRules {
  source: { name: string; repository: string; commit: string; path: string; license: string } | null;
}

const shipped = list as ShippedList;

/** The shipped list, or null when this build carries none. */
export const SHIPPED_SUFFIXES: SuffixList | null = shipped.source && shipped.icann.length > 0 ? new SuffixList(shipped) : null;

/** Where the shipped list came from, or null. */
export const SHIPPED_SUFFIXES_SOURCE = shipped.source;
