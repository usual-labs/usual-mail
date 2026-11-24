// The Cloudflare host's picture source: pictures from the web kept for each inbox in two tables of the object's own
// SQLite, which this host owns (R2 would need a subscription of its own, which the Deploy button can't take out). It
// keeps Node's rules (src/node/pictures/cache.ts, src/pictures/kept.ts): fetched once, when a person first opens the
// message, then served from the store whatever the site's caching headers say; a picture the rules or its content refuse
// is kept as refused and served blank; a site that fails is tried at most three times (at once, after ten minutes, after
// a day), then kept as failed. Pictures: at most 256 MB in all (the least recently served go first, down to 90%),
// nothing unserved for 30 days. Records of refusals and failures: outside that cap, at most 50,000, a year unserved.
//
// `host_pictures` holds one row per inbox and address (both as SHA-256, never the address itself): its kind, type, size,
// the failure's words and tries, when it was last served. `host_picture_parts` holds a picture's bytes in parts of at
// most 1 MB, since a row of a Durable Object's SQLite holds at most 8 MB. A picture's row and parts are written in one
// transaction. Removing an inbox deletes its rows. A kept picture is served as a stream that reads one part per pull, so
// serving it never holds it whole (a sweep or a removal between two pulls ends the stream with an error).

import type { PictureSource, ServedPicture, StreamedPicture, WebPicture } from "../../host.ts";
import { BLANK, CACHE_LIMITS, checkedPicture, KEPT_TYPES, RECORD_LIMITS, RETRY_AFTER_MS } from "../../pictures/kept.ts";
import { PictureRefused } from "../../pictures/refused.ts";
import { fetchWebBytes } from "./fetch.ts";

export const PICTURES_TABLE = "host_pictures";
export const PARTS_TABLE = "host_picture_parts";

/** The largest part a picture is kept in. */
export const PART_BYTES = 1_048_576;
const SWEEP_EVERY_MS = 60 * 60_000;

/** The host's own tables, beside the migrated schema; created before the server starts. */
export function createPictureTables(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${PICTURES_TABLE} (
    inbox_key TEXT NOT NULL,
    url_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('picture', 'refused', 'failed')),
    mime_type TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    tries INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (inbox_key, url_key)
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${PICTURES_TABLE}_used ON ${PICTURES_TABLE} (kind, used_at)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${PARTS_TABLE} (
    inbox_key TEXT NOT NULL,
    url_key TEXT NOT NULL,
    n INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (inbox_key, url_key, n)
  )`);
}

export interface SqlPictureOptions {
  /** How a picture's bytes are fetched. Default: the Worker's fetcher under every rule (`fetchWebBytes`). */
  fetch?: (url: string) => Promise<Uint8Array>;
  now?: () => number;
  maxBytes?: number;
  maxIdleMs?: number;
  /** How many pictures are fetched from the web at once. */
  concurrency?: number;
  records?: { count: number; maxIdleMs: number };
}

/** What is written for an address: a picture's bytes, a refusal or a failure. */
type Keep =
  | { kind: "picture"; picture: WebPicture }
  | { kind: "refused" }
  | { kind: "failed"; reason: string; tries: number; retryAt: number | null };

/** What is read back: the same, a picture as a stream of its parts. */
type Kept = Exclude<Keep, { kind: "picture" }> | { kind: "picture"; picture: StreamedPicture };

interface Row extends Record<string, SqlStorageValue> {
  kind: string;
  mime_type: string | null;
  size: number;
  reason: string | null;
  tries: number;
  retry_at: number | null;
}

const hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

export class SqlPictureSource implements PictureSource {
  readonly #storage: DurableObjectStorage;
  readonly #fetch: (url: string) => Promise<Uint8Array>;
  readonly #now: () => number;
  readonly #limits: typeof CACHE_LIMITS;
  readonly #records: { count: number; maxIdleMs: number };
  readonly #inFlight = new Map<string, Promise<WebPicture>>();
  /** Inboxes forgotten in this instance's life: nothing is written for them again (inbox ids aren't reused). */
  readonly #forgotten = new Set<string>();
  #running = 0;
  readonly #waiting: Array<() => void> = [];
  #lastSweep = Number.NEGATIVE_INFINITY;

  constructor(storage: DurableObjectStorage, options: SqlPictureOptions = {}) {
    this.#storage = storage;
    this.#fetch = options.fetch ?? (async (url) => (await fetchWebBytes(url)).bytes);
    this.#now = options.now ?? Date.now;
    this.#limits = {
      maxBytes: options.maxBytes ?? CACHE_LIMITS.maxBytes,
      maxIdleMs: options.maxIdleMs ?? CACHE_LIMITS.maxIdleMs,
      concurrency: options.concurrency ?? CACHE_LIMITS.concurrency,
    };
    this.#records = options.records ?? RECORD_LIMITS;
  }

  get #sql(): SqlStorage {
    return this.#storage.sql;
  }

  async get(inboxId: string, url: string): Promise<ServedPicture> {
    const inboxKey = (await hex(inboxId)).slice(0, 32);
    const urlKey = await hex(url);
    const key = `${inboxKey}/${urlKey}`;
    // Several devices or views asking at once share one fetch.
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    const kept = this.#read(inboxKey, urlKey);
    if (kept?.kind === "picture") return kept.picture;
    if (kept?.kind === "refused") return BLANK;
    if (kept?.kind === "failed" && (kept.retryAt === null || kept.retryAt > this.#now())) throw new PictureRefused(kept.reason);
    const tries = kept?.kind === "failed" ? kept.tries : 0;
    const work = this.#fetchAndKeep(inboxKey, urlKey, url, tries).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, work);
    return work;
  }

  async forget(inboxId: string): Promise<void> {
    const inboxKey = (await hex(inboxId)).slice(0, 32);
    // Marked first: a fetch still running writes nothing once it is done.
    this.#forgotten.add(inboxKey);
    this.#storage.transactionSync(() => {
      this.#sql.exec(`DELETE FROM ${PARTS_TABLE} WHERE inbox_key = ?`, inboxKey);
      this.#sql.exec(`DELETE FROM ${PICTURES_TABLE} WHERE inbox_key = ?`, inboxKey);
    });
  }

  /** What is kept for this inbox and address, noted as served now; null when nothing (or nothing whole) is. */
  #read(inboxKey: string, urlKey: string): Kept | null {
    const row = this.#sql.exec<Row>(`SELECT kind, mime_type, size, reason, tries, retry_at FROM ${PICTURES_TABLE} WHERE inbox_key = ? AND url_key = ?`, inboxKey, urlKey).toArray()[0];
    if (!row) return null;
    let kept: Kept | null = null;
    if (row.kind === "picture" && row.mime_type && KEPT_TYPES.test(row.mime_type)) {
      // Whole when its parts add up to its size: counted in the store, not read.
      const parts = this.#sql.exec<{ count: number; total: number }>(
        `SELECT count(*) AS count, COALESCE(SUM(length(data)), 0) AS total FROM ${PARTS_TABLE} WHERE inbox_key = ? AND url_key = ?`, inboxKey, urlKey,
      ).one();
      if (parts.total === row.size) kept = { kind: "picture", picture: { mimeType: row.mime_type, size: row.size, stream: this.#parts(inboxKey, urlKey, parts.count) } };
    } else if (row.kind === "refused") {
      kept = { kind: "refused" };
    } else if (row.kind === "failed") {
      kept = { kind: "failed", reason: row.reason ?? "it couldn't be fetched", tries: row.tries, retryAt: row.retry_at };
    }
    if (kept) this.#sql.exec(`UPDATE ${PICTURES_TABLE} SET used_at = ? WHERE inbox_key = ? AND url_key = ?`, this.#now(), inboxKey, urlKey);
    return kept;
  }

  /** A kept picture's bytes, one part per pull, in order. */
  #parts(inboxKey: string, urlKey: string, count: number): ReadableStream<Uint8Array> {
    let n = 0;
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (n >= count) return controller.close();
        const part = this.#sql.exec<{ data: ArrayBuffer }>(`SELECT data FROM ${PARTS_TABLE} WHERE inbox_key = ? AND url_key = ? AND n = ?`, inboxKey, urlKey, n).toArray()[0];
        if (!part) return controller.error(new Error("A kept picture's part went while it was being served"));
        n++;
        controller.enqueue(new Uint8Array(part.data));
      },
    }, { highWaterMark: 0 });
  }

  async #fetchAndKeep(inboxKey: string, urlKey: string, url: string, tries: number): Promise<WebPicture> {
    let picture: WebPicture;
    try {
      picture = checkedPicture(await this.#limited(() => this.#fetch(url)));
    } catch (error) {
      if (error instanceof PictureRefused && error.kind === "refused") {
        this.#keep(inboxKey, urlKey, { kind: "refused" });
        return BLANK;
      }
      const reason = error instanceof PictureRefused ? error.message : "it couldn't be fetched";
      const retry = RETRY_AFTER_MS[tries];
      this.#keep(inboxKey, urlKey, { kind: "failed", reason, tries: tries + 1, retryAt: retry === undefined ? null : this.#now() + retry });
      throw error instanceof PictureRefused ? error : new PictureRefused(reason);
    }
    this.#keep(inboxKey, urlKey, { kind: "picture", picture });
    return picture;
  }

  /** Keeps a picture or a record, replacing what was kept; a failure to write only loses the copy. */
  #keep(inboxKey: string, urlKey: string, kept: Keep): void {
    if (this.#forgotten.has(inboxKey)) return;
    const now = this.#now();
    try {
      this.#storage.transactionSync(() => {
        this.#sql.exec(`DELETE FROM ${PARTS_TABLE} WHERE inbox_key = ? AND url_key = ?`, inboxKey, urlKey);
        let size = 0;
        if (kept.kind === "picture") {
          const data = kept.picture.data;
          size = data.byteLength;
          for (let n = 0, at = 0; at < size; n++, at += PART_BYTES) {
            this.#sql.exec(`INSERT INTO ${PARTS_TABLE} (inbox_key, url_key, n, data) VALUES (?, ?, ?, ?)`, inboxKey, urlKey, n, data.slice(at, at + PART_BYTES).buffer);
          }
        }
        const failed = kept.kind === "failed" ? kept : null;
        this.#sql.exec(
          `INSERT OR REPLACE INTO ${PICTURES_TABLE} (inbox_key, url_key, kind, mime_type, size, reason, tries, retry_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          inboxKey, urlKey, kept.kind, kept.kind === "picture" ? kept.picture.mimeType : null, size, failed?.reason ?? null, failed?.tries ?? 0, failed?.retryAt ?? null, now,
        );
      });
      if (this.#used() > this.#limits.maxBytes || now - this.#lastSweep > SWEEP_EVERY_MS) this.#sweep();
    } catch {
      // A full store, or another failure to write: the picture is served this time, and fetched again next time.
    }
  }

  /** The bytes kept in pictures. */
  #used(): number {
    return this.#sql.exec<{ used: number }>(`SELECT COALESCE(SUM(size), 0) AS used FROM ${PICTURES_TABLE} WHERE kind = 'picture'`).one().used;
  }

  /** Deletes records beyond the count or unserved too long, pictures unserved too long, then the least recently served until 90% of the cap is left. */
  #sweep(): void {
    const now = this.#now();
    this.#lastSweep = now;
    const sql = this.#sql;
    this.#storage.transactionSync(() => {
      sql.exec(`DELETE FROM ${PICTURES_TABLE} WHERE kind <> 'picture' AND used_at < ?`, now - this.#records.maxIdleMs);
      sql.exec(`DELETE FROM ${PICTURES_TABLE} WHERE kind <> 'picture' AND rowid IN (SELECT rowid FROM ${PICTURES_TABLE} WHERE kind <> 'picture' ORDER BY used_at DESC LIMIT -1 OFFSET ?)`, this.#records.count);
      const pictures = sql.exec<{ inbox_key: string; url_key: string; size: number; used_at: number }>(
        `SELECT inbox_key, url_key, size, used_at FROM ${PICTURES_TABLE} WHERE kind = 'picture' ORDER BY used_at ASC`,
      ).toArray();
      let used = pictures.reduce((sum, picture) => sum + picture.size, 0);
      for (const picture of pictures) {
        const idle = now - picture.used_at > this.#limits.maxIdleMs;
        if (!idle && used <= this.#limits.maxBytes * 0.9) break;
        sql.exec(`DELETE FROM ${PARTS_TABLE} WHERE inbox_key = ? AND url_key = ?`, picture.inbox_key, picture.url_key);
        sql.exec(`DELETE FROM ${PICTURES_TABLE} WHERE inbox_key = ? AND url_key = ?`, picture.inbox_key, picture.url_key);
        used -= picture.size;
      }
    });
  }

  async #limited<T>(work: () => Promise<T>): Promise<T> {
    while (this.#running >= this.#limits.concurrency) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#running++;
    try {
      return await work();
    } finally {
      this.#running--;
      this.#waiting.shift()?.();
    }
  }
}
