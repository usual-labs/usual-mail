// What differs between hosts. The service and the sync loop use only these; `src/node/` builds them for a
// Node process, and a Cloudflare side would build its own (D1 or Durable Object SQLite, alarms, a Durable
// Object broadcasting to its sockets). Nothing outside `src/node/` imports `node:` modules.

import type { MailEvent } from "@usualmail/core";
import type { SiteIcon } from "./avatars/sites.ts";
import type { Database } from "./db/index.ts";

export interface Clock {
  /** Unix milliseconds. */
  now(): number;
}

export interface Scheduler {
  /** Calls `run` once, about `delayMs` from now. Returns a function that cancels it. */
  setTimer(delayMs: number, run: () => void): () => void;
}

export interface Random {
  bytes(length: number): Uint8Array<ArrayBuffer>;
}

/** Fans events out to every subscriber in this process (or, on Cloudflare, this Durable Object). */
export interface EventBus {
  publish(event: MailEvent): void;
  subscribe(listener: (event: MailEvent) => void): () => void;
}

/** Seals provider credentials at rest. `context` binds a sealed value to its owner (the inbox id). */
export interface Secrets {
  seal(plain: string, context: string): Promise<string>;
  open(sealed: string, context: string): Promise<string>;
}

export interface Log {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

/** A picture from the web as the server serves it: its bytes, and the type read from the bytes themselves. */
export interface WebPicture {
  data: Uint8Array;
  mimeType: string;
}

/** A kept picture a host serves from its store a part at a time, without holding it whole: its type, size and bytes. */
export interface StreamedPicture {
  mimeType: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
}

/** A picture from the web as a picture source gives it: its bytes, or a stream of them (`StreamedPicture`). */
export type ServedPicture = WebPicture | StreamedPicture;

/**
 * Fetches the pictures from the web that messages show, and keeps them for each inbox (docs/contract.md, "Pictures
 * from the web"). Node's is in `src/node/pictures/`. A picture it won't or can't give throws `PictureRefused`
 * (src/pictures/refused.ts) with words a person may read.
 */
export interface PictureSource {
  /** The picture at `url` for this inbox: from the inbox's cache, or fetched now and kept. */
  get(inboxId: string, url: string): Promise<ServedPicture>;
  /** Forgets every picture kept for an inbox, once it is removed. */
  forget(inboxId: string): Promise<void>;
}

/**
 * Fetches a site's own icon for sender pictures (docs/contract-avatars.md), under the same rules as pictures from the
 * web. Node's is in `src/node/avatars/`. Never throws: what it couldn't find, or why, is in the answer.
 */
export interface SiteIconSource {
  /** The icon of the site at this registrable domain (ASCII). */
  fetch(domain: string): Promise<SiteIcon>;
}

/**
 * How much the server holds in memory and keeps in the store at once, where a host has less room than a Mac (a
 * Cloudflare isolate has 128 MB, a Durable Object's rows at most 8 MB). Every field is optional; one left out takes
 * Node's value (`NODE_LIMITS`), so a Node process behaves as it always has.
 */
export interface HostLimits {
  /**
   * Messages asked of a provider in one sync batch. The batch is held converted, each message's text and HTML, until it
   * is stored. Node: 200.
   */
  syncBatch?: number;
  /**
   * The most a stored message may take, in UTF-8 bytes: its text, HTML and headers together, as the store writes them.
   * Over it the HTML is left out (the text kept), then the text is cut, each with a note (`sync/fit.ts`), so no row is
   * too large for the store. Node: no limit.
   */
  storedMessageBytes?: number;
  /**
   * Characters of served HTML and picture plans kept for recently served messages (`pictures/present.ts`). Node:
   * `MAX_KEPT_CHARS` (24,000,000), in the plans the whole process shares.
   */
  keptPictureChars?: number;
  /** Threads the search index reads, with their messages, and writes together. Node: 100. */
  searchChunk?: number;
  /**
   * Characters of message text and HTML the search index reads at once (a round of bodies; at least one message). It
   * changes only how many reads an index entry takes, never what it holds. Node: 4,000,000.
   */
  searchReadChars?: number;
  /**
   * Whether the search index's catch-up at start runs in the background, chunk by chunk with a turn of the event loop
   * between chunks, instead of inside `start()`. A search still waits until what is stale is indexed. Node: false.
   */
  searchInBackground?: boolean;
}

/** Node's values for the limits a host leaves out; `keptPictureChars` left out keeps the shared plans. */
export const NODE_LIMITS: Required<Omit<HostLimits, "keptPictureChars">> = {
  syncBatch: 200,
  storedMessageBytes: Number.POSITIVE_INFINITY,
  searchChunk: 100,
  searchInBackground: false,
  searchReadChars: 4_000_000,
};

export interface Host {
  db: Database;
  clock: Clock;
  scheduler: Scheduler;
  random: Random;
  events: EventBus;
  secrets: Secrets;
  log: Log;
  /** Pictures from the web. Absent (demo mode, most tests): the picture route answers that the server has none. */
  pictures?: PictureSource;
  /** Sender pictures from organisations' sites. Absent (demo mode, most tests): none is fetched, kept ones still show. */
  siteIcons?: SiteIconSource;
  /**
   * The server's own time zone, an IANA name ("Europe/Berlin"): the day each message was sent, as AI requests state it,
   * and the date the server gives a time said "today" (docs/contract-ai.md). Absent, or not a zone: UTC.
   */
  timeZone?: string;
  /** Lower limits on memory and stored size (`HostLimits`). Absent: Node's. */
  limits?: HostLimits;
}

// --- Implementations that run on any host ----------------------------------------------------------------

export const systemClock: Clock = { now: () => Date.now() };

export const webRandom: Random = {
  bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
};

export const consoleLog: Log = {
  info: (message) => console.log(message),
  error: (message, error) => console.error(message, error ?? ""),
};

export class MemoryEventBus implements EventBus {
  #listeners = new Set<(event: MailEvent) => void>();

  publish(event: MailEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("An event listener failed", error);
      }
    }
  }

  subscribe(listener: (event: MailEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }
}
