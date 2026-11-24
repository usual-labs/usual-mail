// Keeping the provider in step: what each incoming message should look like there, given its thread, and
// recording what the provider did. Only the differences are sent. Runs under `ctx.lock`.

import { FILED_CATEGORIES, type Category, type FiledCategory, type ProviderOp, type ProviderOpResult, type ProviderPlacement, type Stack } from "@usualmail/core";
import { and, asc, eq } from "drizzle-orm";
import { messages, threads } from "../db/index.ts";
import { inList } from "../db/params.ts";
import type { Ctx } from "../service/context.ts";
import { inInboxCategory, waiting } from "../service/state.ts";

export interface PlannedOp {
  op: ProviderOp;
  messageId: string;
  threadId: string;
}

/**
 * Trashing and untrashing go first, in their own round, since they can rename a message. Then seen flags,
 * then placement, so a move that renames a message comes after the flag change on its old name.
 */
export type Phase = "trash" | "place";

/** Which threads to compare: some, or every thread of an inbox (the repair after a start or a reconnect). */
export type Scope = { threadIds: string[] } | { inboxId: string };

export interface Belongs {
  inInbox: boolean;
  category: FiledCategory | null;
  screened: boolean;
  stack?: Stack;
}

/**
 * Where a thread's messages belong at the provider (docs/contract-sync.md, "Providers"): a conversation or undecided
 * thread in the provider's inbox exactly when it shows in Home (not screened, not done, on no stack, not waiting), a
 * filed category's thread under its label or folder (a notification too, though Home shows it), under Screening while
 * screened, and with its stack's label or keyword.
 */
export function belongsAt(
  thread: { category: Category; screened: boolean; done: boolean; stack: Stack | null; comeBackAt: number | null },
  now: number,
): Belongs {
  const filed = (FILED_CATEGORIES as readonly string[]).includes(thread.category) ? thread.category as FiledCategory : null;
  const inInbox = inInboxCategory(thread.category) && !thread.screened && !thread.done && !thread.stack && !waiting(thread, now);
  const place: Belongs = { inInbox, category: filed, screened: thread.screened };
  return thread.stack ? { ...place, stack: thread.stack } : place;
}

/**
 * Whether the provider has a message where it belongs. A category is compared only where the provider reports one:
 * IMAP's Screening folder keeps none, and the server keeps it then. A mailbox that can't keep stacks reports none; a
 * stack alone is then no reason to write.
 */
function placedRight(current: ProviderPlacement, want: Belongs): boolean {
  if (current.inInbox !== want.inInbox || Boolean(current.screened) !== want.screened) return false;
  if (current.category !== undefined && (current.category ?? null) !== want.category) return false;
  return current.stack === undefined || (current.stack ?? null) === (want.stack ?? null);
}

export async function planOps(ctx: Ctx, scope: Scope, phase: Phase): Promise<PlannedOp[]> {
  const now = ctx.now();
  if ("threadIds" in scope && scope.threadIds.length === 0) return [];
  const rows = await ctx.db.select({ thread: threads, message: messages }).from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(and(
      "threadIds" in scope ? inList(messages.threadId, scope.threadIds) : eq(messages.inboxId, scope.inboxId),
      // The server never places or flags outgoing mail, so Sent stays as the provider keeps it.
      eq(messages.outgoing, false),
    ))
    .orderBy(asc(messages.date), asc(messages.id));
  const seenOps: PlannedOp[] = [];
  const otherOps: PlannedOp[] = [];
  for (const { thread, message } of rows) {
    // A stranger's thread waiting for the AI's first answer isn't written back yet (docs/contract.md, "Rules and
    // learning"); it is once the answer is in or the AI can't give one.
    if (thread.removed || message.placement.spam || thread.gatePending) continue;
    const ref = message.ref;
    const current = message.placement;
    const ids = { messageId: message.id, threadId: thread.id };
    if (phase === "trash") {
      if (thread.trashed && !current.trashed) otherOps.push({ op: { op: "trash", ref }, ...ids });
      if (!thread.trashed && current.trashed) otherOps.push({ op: { op: "untrash", ref, ...belongsAt(thread, now) }, ...ids });
      continue;
    }
    if (thread.trashed || current.trashed) continue;
    if (message.seen === message.unread) seenOps.push({ op: { op: "seen", ref, seen: !message.unread }, ...ids });
    const want = belongsAt(thread, now);
    if (!placedRight(current, want)) otherOps.push({ op: { op: "place", ref, ...want }, ...ids });
  }
  return [...seenOps, ...otherOps];
}

export interface Recorded {
  /** The first refusal, or null. */
  refusal: string | null;
  /** Notes the provider gave on changes that worked, with the thread each concerns. */
  notes: Array<{ threadId: string; note: string }>;
}

/** Stores what went through, including new refs. */
export async function recordResults(ctx: Ctx, planned: PlannedOp[], results: ProviderOpResult[]): Promise<Recorded> {
  let refusal: string | null = null;
  const notes: Recorded["notes"] = [];
  for (const [index, { op, messageId, threadId }] of planned.entries()) {
    const result = results[index] ?? { ok: false, error: "The provider gave no answer for this change" };
    if (!result.ok) {
      refusal ??= result.error || "The provider refused the change";
      continue;
    }
    if (result.note && !notes.some((n) => n.threadId === threadId && n.note === result.note)) notes.push({ threadId, note: result.note });
    const row = await ctx.db.select({ placement: messages.placement }).from(messages).where(eq(messages.id, messageId)).get();
    if (!row) continue;
    const patch: { seen?: boolean; placement?: ProviderPlacement; ref?: string } = {};
    switch (op.op) {
      case "seen":
        patch.seen = op.seen;
        break;
      case "place":
      case "untrash": {
        const placement: ProviderPlacement = {
          inInbox: op.inInbox,
          category: op.category,
          screened: op.screened,
          trashed: op.op === "place" ? row.placement.trashed : false,
          spam: row.placement.spam,
        };
        // Stored as the provider will report it: a mailbox that reported no stack keeps reporting none. A provider
        // that keeps no category while screened (IMAP) reports none then; comparing skips it.
        if (row.placement.stack !== undefined) placement.stack = op.stack ?? null;
        patch.placement = placement;
        break;
      }
      case "trash":
        patch.placement = { ...row.placement, trashed: true };
        break;
    }
    if (result.ref && result.ref !== op.ref) patch.ref = result.ref;
    await ctx.db.update(messages).set(patch).where(eq(messages.id, messageId));
  }
  return { refusal, notes };
}
