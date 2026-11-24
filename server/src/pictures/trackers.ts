// The list of email trackers: who makes them, and patterns over a picture's address. It comes from
// MailTrackerBlocker (BSD-3-Clause; trackers.json carries the licence, trackers.LICENSE beside it says so), written
// by `scripts/update-trackers.mjs` from a pinned commit. Any list in the same shape can take its place.

import list from "./trackers.json" with { type: "json" };

export interface TrackerList {
  source: { name: string; repository: string; commit: string; license: string; licenseText: string };
  trackers: Array<{ name: string; patterns: string[] }>;
}

/** Tells which tracker, if any, a picture's address belongs to. */
export class Trackers {
  readonly #list: TrackerList;
  #compiled: Array<{ name: string; patterns: RegExp[] }> | null = null;

  constructor(trackerList: TrackerList) {
    this.#list = trackerList;
  }

  /** Where the list came from, with its licence. */
  get source(): TrackerList["source"] {
    return this.#list.source;
  }

  /** The maker's name when the address matches one of the list's patterns (ignoring case), else null. */
  match(url: string): string | null {
    this.#compiled ??= this.#list.trackers.map((tracker) => ({
      name: tracker.name,
      patterns: tracker.patterns.map((pattern) => new RegExp(pattern, "i")),
    }));
    for (const tracker of this.#compiled) {
      if (tracker.patterns.some((pattern) => pattern.test(url))) return tracker.name;
    }
    return null;
  }
}

/** The list the server ships. */
export const trackers = new Trackers(list as TrackerList);
