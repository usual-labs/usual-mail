// Asking to unsubscribe from a sender (docs/contract.md, "Unsubscribing"; the owner's request of 2026-11-27), for a
// person only: one row per inbox and sender, the newest asked. Asking starts it `working` at once and leaves the asking
// to the queue (`queue.ts`), so the answer never waits on the sender's site or a browser agent. Asking again starts
// over, unless one is still working. Nothing here blocks the sender or changes a thread: an app does `block_sender` too.

import { ServiceError, type Caller, type Unsubscribe } from "@usualmail/core";
import { and, eq } from "drizzle-orm";
import { unsubscribes, type UnsubscribeRow } from "../db/index.ts";
import { inList } from "../db/params.ts";
import { requirePerson, requireThread } from "../service/access.ts";
import type { Ctx } from "../service/context.ts";
import { assertNotPaused } from "../service/inboxes.ts";
import { iso } from "../util.ts";

/** A row as people's devices see it. */
export function toUnsubscribe(row: UnsubscribeRow): Unsubscribe {
  return {
    inboxId: row.inboxId,
    address: row.address,
    threadId: row.threadId,
    state: row.state,
    ...(row.way && { way: row.way }),
    ...(row.state === "needs_person" && row.url && { url: row.url }),
    ...(row.detail && { detail: row.detail }),
    askedAt: iso(row.askedAt),
    updatedAt: iso(row.updatedAt),
    version: row.version,
  };
}

/** Tells people's devices how it stands now. */
export function emitUnsubscribe(ctx: Ctx, row: UnsubscribeRow): void {
  ctx.emit({ type: "unsubscribe.changed", unsubscribe: toUnsubscribe(row) });
}

/** Person only: starts asking the thread's sender to stop, and answers at once. Under the lock. */
export async function requestUnsubscribe(ctx: Ctx, caller: Caller, threadId: string): Promise<Unsubscribe> {
  requirePerson(caller, "unsubscribe from a sender");
  const { thread, inbox } = await requireThread(ctx, caller, threadId);
  assertNotPaused(inbox, "unsubscribe from a sender");
  const address = thread.sender?.trim().toLowerCase();
  if (!address) throw new ServiceError("invalid", "This conversation has no sender to unsubscribe from");
  const key = and(eq(unsubscribes.inboxId, inbox.id), eq(unsubscribes.address, address));
  const existing = await ctx.db.select().from(unsubscribes).where(key).get();
  if (existing?.state === "working") return toUnsubscribe(existing);
  const now = ctx.now();
  const row: UnsubscribeRow = {
    inboxId: inbox.id,
    address,
    threadId: thread.id,
    state: "working",
    way: null,
    url: null,
    detail: null,
    step: "start",
    tried: [],
    marker: null,
    runId: null,
    page: null,
    nextAt: now,
    askedAt: now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
  };
  if (existing) await ctx.db.update(unsubscribes).set(row).where(key);
  else await ctx.db.insert(unsubscribes).values(row);
  emitUnsubscribe(ctx, row);
  ctx.unsubscribes.wake();
  return toUnsubscribe(row);
}

/** The unsubscribes of these senders in one inbox, by address, for their blocked items. */
export async function unsubscribesOf(ctx: Ctx, inboxId: string, addresses: readonly string[]): Promise<Map<string, Unsubscribe>> {
  if (addresses.length === 0) return new Map();
  const rows = await ctx.db.select().from(unsubscribes)
    .where(and(eq(unsubscribes.inboxId, inboxId), inList(unsubscribes.address, [...addresses])));
  return new Map(rows.map((row) => [row.address, toUnsubscribe(row)]));
}
