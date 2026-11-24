// Node's picture source: pictures from the web kept on disk for each inbox under <data-dir>/pictures, fetched once
// when a person first opens the message and then served from the disk. Upstream caching headers are ignored on
// purpose: a sender's "no-store" would otherwise turn every opening into a new request they can count.
//
// What can't be had is kept too, so a sender can't count openings with a picture that never arrives (the security
// review of 2026-11-18): a picture the rules or its content refuse (`PictureRefused` of kind `refused`) is kept as
// refused and served blank, for as long as a picture would be; a site that fails is tried at most three times (at
// once, again after ten minutes, a last time after a day) and then kept as failed.
//
// Layout: <dir>/<sha256(inbox id), 32 hex>/<sha256(address), 64 hex> for a picture, and the same name with `.record`
// for a refusal or failure, each file holding its type's length (1 byte), its type, then the bytes (`usual/refused`
// and `usual/failed` for the two kinds of record). A file's modification time is when it was last served. Removing an
// inbox deletes its folder. Pictures: at most 256 MB in all (the least recently served go first), nothing unserved for
// 30 days. Records are a few dozen bytes and stay outside that cap, so filling it with pictures can't make a tracker
// asked again (the security review's second round): at most 50,000 of them, nothing unserved for a year. Files a crash
// left half-written are swept.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PictureSource, WebPicture } from "../../host.ts";
import { BLANK, CACHE_LIMITS, checkedPicture, KEPT_TYPES, RECORD_LIMITS, RETRY_AFTER_MS, TRANSPARENT_GIF } from "../../pictures/kept.ts";
import { PictureRefused } from "../../pictures/refused.ts";
import { fetchPictureBytes, type FetchOptions } from "./fetch.ts";

export interface DiskPictureOptions {
  /** The folder the pictures are kept in: `<data-dir>/pictures`. */
  dir: string;
  /** How a picture's bytes are fetched. Default: `fetchPictureBytes` with `fetchOptions`. */
  fetch?: (url: string) => Promise<Uint8Array>;
  /** For the default fetch; only tests give any. */
  fetchOptions?: FetchOptions;
  now?: () => number;
  maxBytes?: number;
  maxIdleMs?: number;
  /** How many pictures are fetched from the web at once. */
  concurrency?: number;
  /** How many records of refusals and failures are kept, and for how long unserved. Default `RECORD_LIMITS`. */
  records?: { count: number; maxIdleMs: number };
}

// The limits, retries and blank picture every host's picture source shares (src/pictures/kept.ts), named here too.
export { CACHE_LIMITS, RECORD_LIMITS, RETRY_AFTER_MS, TRANSPARENT_GIF };

const REFUSED = "usual/refused";
const FAILED = "usual/failed";
const PARTIAL = /^[0-9a-f]{64}(?:\.record)?\.[0-9a-f]{12}\.partial$/;
const RECORD = /^[0-9a-f]{64}\.record$/;
const PARTIAL_AGE_MS = 60 * 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

type Kept =
  | { kind: "picture"; picture: WebPicture }
  | { kind: "refused" }
  | { kind: "failed"; reason: string; tries: number; retryAt: number | null };

export class DiskPictureSource implements PictureSource {
  readonly #dir: string;
  readonly #fetch: (url: string) => Promise<Uint8Array>;
  readonly #now: () => number;
  readonly #limits: typeof CACHE_LIMITS;
  readonly #records: { count: number; maxIdleMs: number };
  readonly #inFlight = new Map<string, Promise<WebPicture>>();
  /** The folders of inboxes forgotten in this run: nothing is written into them again (inbox ids aren't reused). */
  readonly #forgotten = new Set<string>();
  #running = 0;
  readonly #waiting: Array<() => void> = [];
  /** Bytes kept in all, once counted; null until the first write counts them. */
  #used: number | null = null;
  #lastSweep = Number.NEGATIVE_INFINITY;

  constructor(options: DiskPictureOptions) {
    this.#dir = options.dir;
    this.#fetch = options.fetch ?? ((url) => fetchPictureBytes(url, options.fetchOptions));
    this.#now = options.now ?? Date.now;
    this.#limits = {
      maxBytes: options.maxBytes ?? CACHE_LIMITS.maxBytes,
      maxIdleMs: options.maxIdleMs ?? CACHE_LIMITS.maxIdleMs,
      concurrency: options.concurrency ?? CACHE_LIMITS.concurrency,
    };
    this.#records = options.records ?? RECORD_LIMITS;
  }

  async get(inboxId: string, url: string): Promise<WebPicture> {
    const folder = this.#folder(inboxId);
    const file = join(folder, hash(url));
    // Several devices or views asking at once share one fetch.
    const pending = this.#inFlight.get(file);
    if (pending) return pending;
    const kept = (await this.#read(file)) ?? (await this.#read(`${file}.record`));
    if (kept?.kind === "picture") return kept.picture;
    if (kept?.kind === "refused") return BLANK;
    if (kept?.kind === "failed" && (kept.retryAt === null || kept.retryAt > this.#now())) throw new PictureRefused(kept.reason);
    const tries = kept?.kind === "failed" ? kept.tries : 0;
    const again = this.#inFlight.get(file);
    if (again) return again;
    const work = this.#fetchAndKeep(folder, file, url, tries).finally(() => this.#inFlight.delete(file));
    this.#inFlight.set(file, work);
    return work;
  }

  async forget(inboxId: string): Promise<void> {
    const folder = this.#folder(inboxId);
    // Marked first: a fetch still running, or a file being written now, removes what it wrote once it is written.
    this.#forgotten.add(folder);
    await rm(folder, { recursive: true, force: true });
    this.#used = null;
  }

  #folder(inboxId: string): string {
    return join(this.#dir, hash(inboxId).slice(0, 32));
  }

  async #read(file: string): Promise<Kept | null> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(file);
    } catch {
      return null;
    }
    const length = bytes[0] ?? 0;
    const type = new TextDecoder().decode(bytes.subarray(1, 1 + length));
    const data = new Uint8Array(bytes.buffer, bytes.byteOffset + 1 + length, bytes.length - 1 - length);
    let kept: Kept | null = null;
    if (KEPT_TYPES.test(type)) kept = { kind: "picture", picture: { mimeType: type, data } };
    else if (type === REFUSED) kept = { kind: "refused" };
    else if (type === FAILED) {
      try {
        const record = JSON.parse(new TextDecoder().decode(data)) as { reason: string; tries: number; retryAt: number | null };
        kept = { kind: "failed", reason: String(record.reason), tries: Number(record.tries), retryAt: record.retryAt === null ? null : Number(record.retryAt) };
      } catch {
        kept = null;
      }
    }
    if (kept) {
      const now = new Date(this.#now());
      await utimes(file, now, now).catch(() => undefined);
    }
    return kept;
  }

  async #fetchAndKeep(folder: string, file: string, url: string, tries: number): Promise<WebPicture> {
    let picture: WebPicture;
    try {
      picture = checkedPicture(await this.#limited(() => this.#fetch(url)));
    } catch (error) {
      if (error instanceof PictureRefused && error.kind === "refused") {
        await this.#keep(folder, `${file}.record`, REFUSED, new Uint8Array()).catch(() => undefined);
        return BLANK;
      }
      const reason = error instanceof PictureRefused ? error.message : "it couldn't be fetched";
      const now = this.#now();
      const retry = RETRY_AFTER_MS[tries];
      const record = { reason, tries: tries + 1, retryAt: retry === undefined ? null : now + retry };
      await this.#keep(folder, `${file}.record`, FAILED, new TextEncoder().encode(JSON.stringify(record))).catch(() => undefined);
      throw error instanceof PictureRefused ? error : new PictureRefused(reason);
    }
    await this.#keep(folder, file, picture.mimeType, picture.data).catch(() => undefined); // a full disk only loses the copy
    await unlink(`${file}.record`).catch(() => undefined); // a failure that passed
    return picture;
  }

  async #keep(folder: string, file: string, type: string, data: Uint8Array): Promise<void> {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const typeBytes = new TextEncoder().encode(type);
    const content = new Uint8Array(1 + typeBytes.length + data.length);
    content[0] = typeBytes.length;
    content.set(typeBytes, 1);
    content.set(data, 1 + typeBytes.length);
    const temporary = `${file}.${randomBytes(6).toString("hex")}.partial`;
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      // Kept as served now, by the source's own clock, like every later serving.
      const now = new Date(this.#now());
      await utimes(temporary, now, now);
      await rename(temporary, file);
      // Its inbox was forgotten before or while this was written: the folder, made again by this write, goes again.
      if (this.#forgotten.has(folder)) {
        await rm(folder, { recursive: true, force: true });
        return;
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    if (!file.endsWith(".record")) this.#used = (this.#used ?? (await this.#count())) + content.length;
    if ((this.#used ?? 0) > this.#limits.maxBytes || this.#now() - this.#lastSweep > SWEEP_EVERY_MS) await this.#sweep();
  }

  /** Every kept picture and record, with its size and when it was last served, and the half-written files apart. */
  async #files(): Promise<{
    kept: Array<{ path: string; size: number; usedAt: number }>;
    records: Array<{ path: string; size: number; usedAt: number }>;
    partial: Array<{ path: string; at: number }>;
  }> {
    const kept: Array<{ path: string; size: number; usedAt: number }> = [];
    const records: Array<{ path: string; size: number; usedAt: number }> = [];
    const partial: Array<{ path: string; at: number }> = [];
    const folders = await readdir(this.#dir).catch(() => [] as string[]);
    for (const folder of folders) {
      if (!/^[0-9a-f]{32}$/.test(folder)) continue;
      const names = await readdir(join(this.#dir, folder)).catch(() => [] as string[]);
      for (const name of names) {
        const path = join(this.#dir, folder, name);
        const isKept = /^[0-9a-f]{64}$/.test(name);
        const isRecord = RECORD.test(name);
        if (!isKept && !isRecord && !PARTIAL.test(name)) continue;
        const info = await stat(path).catch(() => null);
        if (!info) continue;
        if (isKept) kept.push({ path, size: info.size, usedAt: info.mtimeMs });
        else if (isRecord) records.push({ path, size: info.size, usedAt: info.mtimeMs });
        else partial.push({ path, at: info.mtimeMs });
      }
    }
    return { kept, records, partial };
  }

  async #count(): Promise<number> {
    return (await this.#files()).kept.reduce((sum, file) => sum + file.size, 0);
  }

  /**
   * Deletes half-written files older than an hour (a crash left them; a write in progress is younger), what wasn't
   * served for too long, then the least recently served until 90% of the cap is left.
   */
  async #sweep(): Promise<void> {
    const now = this.#now();
    this.#lastSweep = now;
    const { kept, records, partial } = await this.#files();
    for (const file of partial) if (now - file.at > PARTIAL_AGE_MS) await unlink(file.path).catch(() => undefined);
    // Records: the least recently served beyond the count, and any unserved for a year.
    records.sort((a, b) => a.usedAt - b.usedAt);
    for (const [i, record] of records.entries()) {
      if (records.length - i <= this.#records.count && now - record.usedAt <= this.#records.maxIdleMs) break;
      await unlink(record.path).catch(() => undefined);
    }
    const files = kept.sort((a, b) => a.usedAt - b.usedAt);
    let used = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      const idle = now - file.usedAt > this.#limits.maxIdleMs;
      if (!idle && used <= this.#limits.maxBytes * 0.9) break;
      await unlink(file.path).catch(() => undefined);
      used -= file.size;
    }
    this.#used = used;
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
