// Changes made at the provider win (docs/contract-sync.md, "Sync"): archived there is done here, moved into the inbox
// there is in Home, a filed category's label or folder is that category, the Screening label or folder screens the
// thread, a stack's label or keyword is that stack, trashed there is trashed here, and the seen flag is read and
// unread. Runs under `ctx.lock`.

import { FILED_CATEGORIES, type FiledCategory, type ProviderPlacement } from "@usualmail/core";
import { and, eq } from "drizzle-orm";
import { messages, type MessageRow } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { retireUndo } from "../service/records.ts";
import { BY_MAILBOX, inInboxCategory, NO_COME_BACK, sameIn, waiting, type Group, type ThreadState } from "../service/state.ts";
import { getThread, saveThreadState, threadState } from "../service/store.ts";
import { belongsAt } from "./writeback.ts";

/** A stack the provider reports: the stack, null for none, or undefined when the mailbox can't keep stacks. */
function stackOf(placement: Pick<ProviderPlacement, "stack">) {
  return placement.stack === undefined ? undefined : placement.stack ?? null;
}

/** Trashed, or in spam: out of every list. While a message is out, only that counts in its placement. */
function out(placement: ProviderPlacement): "trash" | "spam" | null {
  return placement.trashed ? "trash" : placement.spam ? "spam" : null;
}

function isFiled(category: unknown): category is FiledCategory {
  return (FILED_CATEGORIES as readonly unknown[]).includes(category);
}

/**
 * Whether `after` says the message moved since `before`. While a message is trashed only that counts. A category
 * is compared only when both report one: IMAP's Screening folder keeps none, and that says nothing. A stack is
 * compared only when the provider reports one: a mailbox that can't keep stacks reports none, and that says nothing.
 */
export function placementMoved(before: ProviderPlacement, after: ProviderPlacement): boolean {
  if (out(before) || out(after)) return out(before) !== out(after);
  if (before.inInbox !== after.inInbox || Boolean(before.screened) !== Boolean(after.screened)) return true;
  if (before.category !== undefined && after.category !== undefined && (before.category ?? null) !== (after.category ?? null)) return true;
  const reported = stackOf(after);
  if (reported === undefined) return false;
  return stackOf(before) !== reported;
}

/**
 * Takes a known message's flags and placement as the provider reports them. Returns whether its thread needs
 * recomputing. `listed` marks it as included in a reset listing.
 */
export async function takeProviderState(
  ctx: Ctx,
  existing: MessageRow,
  reported: { seen: boolean; placement: ProviderPlacement },
  listed: number | null,
  content: Partial<Pick<MessageRow, "ref" | "subject" | "text" | "html">> = {},
): Promise<boolean> {
  const patch: Partial<MessageRow> = { ...content };
  if (listed !== null && existing.listed !== listed) patch.listed = listed;
  const seenChanged = existing.seen !== reported.seen;
  if (seenChanged) {
    patch.seen = reported.seen;
    patch.unread = !reported.seen;
  }
  const moved = placementMoved(existing.placement, reported.placement);
  // Kept as the provider last reported it, so the next report compares with that.
  if (JSON.stringify(existing.placement) !== JSON.stringify(reported.placement)) patch.placement = reported.placement;
  if (Object.keys(patch).length === 0) return false;
  await ctx.db.update(messages).set(patch).where(eq(messages.id, existing.id));
  if (seenChanged && !existing.outgoing) await retireUndo(ctx, [existing.threadId], ["unread"]);
  if (moved && !existing.outgoing) await movedAtProvider(ctx, existing.threadId, existing.placement, reported.placement);
  return Object.keys(patch).some((key) => key !== "listed" && key !== "placement") || moved;
}

/** Applies a move made in the provider's own app to the thread. */
async function movedAtProvider(ctx: Ctx, threadId: string, before: ProviderPlacement, after: ProviderPlacement): Promise<void> {
  const row = await getThread(ctx, threadId);
  if (!row) return;
  const state = await threadState(ctx, row);
  const now = ctx.now();
  let next: ThreadState = { ...state };
  if (out(after)) {
    // Trashed there: trashed here once every incoming message is.
    const rest = await ctx.db.select({ placement: messages.placement }).from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.outgoing, false)));
    if (rest.every((m) => out(m.placement))) next.trashed = true;
  } else {
    // Taken out of the trash there: out here too. While it was trashed only that counted, so the rest is compared
    // with where its thread belongs.
    let was: Placed = before;
    if (out(before)) {
      next.trashed = false;
      const belongs = belongsAt(state, now);
      was = { inInbox: belongs.inInbox, category: belongs.category, screened: belongs.screened, stack: belongs.stack ?? null };
    }
    next = followProvider(next, state, was, after, now);
  }
  const changed = (["category", "screened", "done", "stack", "comeBack", "trashed"] as Group[]).filter((group) => !sameIn([group], state, next));
  if (changed.length === 0) return;
  await saveThreadState(ctx, threadId, next);
  // Earlier actions on these parts can't be undone exactly any more.
  await retireUndo(ctx, [threadId], changed);
}

type Placed = Pick<ProviderPlacement, "inInbox" | "category" | "screened" | "stack">;

/**
 * Where a thread is once the provider's own app moved one of its messages from `was` to `after` (not trashed).
 * `current` is the thread as the server had it. A category the mailbox changes is decided by the mailbox; deciding
 * it lets nobody in, and changing the Screening label lets nobody in or out either.
 */
export function followProvider(next: ThreadState, current: ThreadState, was: Placed, after: ProviderPlacement, now: number): ThreadState {
  // A mailbox that can't keep stacks says nothing about them; the server keeps the stack itself.
  const reportedWas = stackOf(was);
  const stackWas = reportedWas === undefined ? current.stack : reportedWas;
  const stackNow = stackOf(after);
  const stackAdded = stackNow !== undefined && stackNow !== null && stackNow !== stackWas;
  const stackRemoved = stackNow === null && stackWas !== null;
  const decided = (result: ThreadState, category: ThreadState["category"]): ThreadState =>
    ({ ...result, category, ...BY_MAILBOX, ...(category === "otp" && { summary: null }) });

  if (after.inInbox && !was.inInbox) {
    // Moved into the inbox there: in Home, so a conversation, not screened, not done, off its stack and no longer
    // waiting. A stack added at the same moment still wins, since a thread on a stack is never in Home.
    return { ...decided(next, "conversation"), screened: false, screenedByMailbox: false, done: false, stack: stackAdded ? stackNow : null, ...NO_COME_BACK };
  }
  let result = { ...next };
  if (isFiled(after.category) && after.category !== current.category) {
    // Moved to a filed category's label or folder, or that label added: its category. It isn't done by that.
    result = decided(result, after.category);
  } else if (after.category === null && isFiled(was.category) && isFiled(current.category)) {
    // Its category's label or folder taken away there: no label means a conversation.
    result = decided(result, "conversation");
  }
  if (Boolean(after.screened) !== Boolean(was.screened)) {
    // The Screening label added there is the mailbox's filing; taken away there, nothing screens it.
    result.screened = after.screened;
    result.screenedByMailbox = after.screened;
  }
  if (stackAdded) result = { ...result, stack: stackNow, done: false };
  else if (stackRemoved) result.stack = null;
  const homeKind = inInboxCategory(result.category) && !result.screened;
  if (was.inInbox && !after.inInbox && homeKind && !stackAdded) {
    // Archived there: done here. A stack added at the same moment wins instead.
    result = { ...result, done: true, stack: null, ...NO_COME_BACK };
  }
  // At the provider a conversation or undecided thread out of the inbox, not screened, on no stack and not waiting,
  // looks done; read it so.
  if (homeKind && !after.inInbox && result.stack === null && !waiting(result, now)) result.done = true;
  return result;
}
