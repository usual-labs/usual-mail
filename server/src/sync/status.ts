// Storing how an inbox's sync attempts went (health.ts says what they make of its row): one read-modify-write under the
// service's lock, and `inbox.changed` when what an interface shows changed.

import { eq } from "drizzle-orm";
import { inboxes, type InboxRow } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { toInbox } from "../service/rows.ts";
import { getInbox } from "../service/store.ts";
import { notSyncingWords, type Health } from "./health.ts";

/**
 * Stores what `health` makes of the inbox's row, or nothing when it gives null. A changed status, words or reason
 * raises the inbox's version and sends `inbox.changed`; the attempt's time, the run of failures and `lastSyncedAt`
 * moving alone are not changes, so they do neither. The first sync done drops its count, a change when one was shown.
 */
export async function storeHealth(
  ctx: Ctx,
  inboxId: string,
  health: (row: InboxRow) => Partial<Health> | null,
  extra: Partial<Pick<InboxRow, "lastSyncedAt" | "historyDone">> = {},
): Promise<void> {
  await ctx.lock.run(async () => {
    const row = await getInbox(ctx, inboxId);
    if (!row) return;
    const made = health(row);
    if (!made) return;
    const set = { ...made, ...extra, ...(extra.historyDone && { firstSyncFetched: null, firstSyncTotal: null }) };
    const next = { ...row, ...set };
    const counted = extra.historyDone === true && !row.historyDone && row.firstSyncTotal !== null;
    const changed = row.status !== next.status || row.statusDetail !== next.statusDetail ||
      row.statusReason !== next.statusReason || counted;
    if (changed) next.version = row.version + 1;
    await ctx.db.update(inboxes).set({ ...set, version: next.version }).where(eq(inboxes.id, inboxId));
    if (changed) ctx.emit({ type: "inbox.changed", inbox: toInbox(next) });
  });
}

/**
 * The watch found these open inboxes silent for `afterMs` (watch.ts): each is `not_syncing`, unless it is paused or
 * already said so. Its next finished attempt settles it (health.ts).
 */
export async function markNotSyncing(ctx: Ctx, inboxIds: string[], afterMs: number): Promise<void> {
  for (const inboxId of inboxIds) {
    await storeHealth(ctx, inboxId, (row) =>
      row.paused || row.statusReason === "not_syncing"
        ? null
        : { status: "needs_attention", statusReason: "not_syncing", statusDetail: notSyncingWords(row.lastSyncedAt, afterMs, ctx.host.timeZone) });
  }
}
