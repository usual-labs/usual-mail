// How far each inbox's first sync has got (docs/contract-sync.md, "How far a first sync has got"; the owner's decision
// of 2026-11-23). The provider says it with each batch of the first sync and, for a slow batch, while it runs; this
// keeps the latest word and shows it as `Inbox.firstSync` once the first sync has run FIRST_SYNC_PROGRESS_EVERY_MS in
// this process, then at most that often: written to the inbox's row (so the list has it, also after a restart) with a
// new version and `inbox.changed`. The count itself lives in the provider's cursor, so it carries on across sync
// rounds, restarts and an evicted Durable Object; nothing here needs to survive one. The engine drops the count when
// the first sync is done (`SyncEngine`'s status), and a word that arrives after that is never shown; nor is one while
// the inbox is paused, which keeps the count it reached. A count alone changes no list's counts and not the AI's
// status, so its `inbox.changed` doesn't make the server work those out again (`Ctx.emit`'s `countsUnchanged`; on
// Cloudflare each time would read every thread, docs/agents/server-cloudflare-limits.md).

import { FIRST_SYNC_PROGRESS_EVERY_MS, type SyncProgress } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { inboxes } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { toInbox } from "../service/rows.ts";
import { getInbox } from "../service/store.ts";

export class FirstSyncCounts {
  readonly #ctx: Ctx;
  readonly #track: (work: Promise<unknown>) => void;
  /** Per inbox: when its count was last shown, or when its first sync began here while none has been. */
  readonly #shownAt = new Map<string, number>();
  /** Per inbox: the latest word, which a write takes when it runs. */
  readonly #latest = new Map<string, SyncProgress>();
  /** Inboxes with a write queued, so words meanwhile only update `#latest`. */
  readonly #queued = new Set<string>();

  constructor(ctx: Ctx, track: (work: Promise<unknown>) => void) {
    this.#ctx = ctx;
    this.#track = track;
  }

  /** A sync of the inbox's first sync begins: the time from which its first count may be shown. */
  begin(inboxId: string): void {
    if (!this.#shownAt.has(inboxId)) this.#shownAt.set(inboxId, this.#ctx.now());
  }

  /** The provider's word on how far the first sync has got: shown now when it is due, else kept for the next. */
  heard(inboxId: string, progress: SyncProgress): void {
    this.#latest.set(inboxId, progress);
    const now = this.#ctx.now();
    const since = this.#shownAt.get(inboxId);
    if (since === undefined) {
      this.#shownAt.set(inboxId, now);
      return;
    }
    if (now - since < FIRST_SYNC_PROGRESS_EVERY_MS || this.#queued.has(inboxId)) return;
    this.#shownAt.set(inboxId, now);
    this.#queued.add(inboxId);
    this.#track(this.#ctx.lock.run(() => this.#show(inboxId)).finally(() => this.#queued.delete(inboxId)));
  }

  /** The first sync is done, or the inbox closed: nothing more to show for it here. */
  forget(inboxId: string): void {
    this.#shownAt.delete(inboxId);
    this.#latest.delete(inboxId);
  }

  async #show(inboxId: string): Promise<void> {
    const ctx = this.#ctx;
    const progress = this.#latest.get(inboxId);
    const row = await getInbox(ctx, inboxId);
    // Gone, its first sync ended while this waited for the lock, or paused: it keeps the count it reached.
    if (!progress || !row || row.historyDone || row.paused) return;
    const fetched = count(progress.sent);
    const total = Math.max(count(progress.total), fetched);
    if (row.firstSyncFetched === fetched && row.firstSyncTotal === total) return;
    const next = { ...row, firstSyncFetched: fetched, firstSyncTotal: total, version: row.version + 1 };
    await ctx.db.update(inboxes).set({ firstSyncFetched: fetched, firstSyncTotal: total, version: next.version }).where(eq(inboxes.id, inboxId));
    ctx.emit({ type: "inbox.changed", inbox: toInbox(next) }, { countsUnchanged: true });
  }
}

/** A provider's number as a count: a whole number from 0. */
function count(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
