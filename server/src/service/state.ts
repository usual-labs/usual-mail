// A thread's state as actions see it, which parts each action touches, and the pure rules for changing it.
// Undo restores the touched parts from a record's `before`; approve compares them to see if a proposal is
// stale.

import type { ActionInput, ActionKind, Actor, Category, CategorySource, Need, ScreeningPass, Stack } from "@usualmail/core";
import type { SenderStatus, ThreadRow } from "../db/index.ts";

/**
 * The parts of a thread (and its sender) that actions change. "category" carries the summary with it, since a
 * thread put in `otp` loses its summary and undoing that puts it back.
 */
export type Group = "category" | "screened" | "done" | "stack" | "comeBack" | "unread" | "trashed" | "sender";

/**
 * Done takes a thread off its stack and clears its come-back time; stacking and coming back clear done; putting a
 * thread in `otp` stops screening it. So those actions touch, and their undo restores, every part they may change.
 */
const GROUPS: Record<ActionKind, readonly Group[]> = {
  categorize: ["category", "screened"],
  done: ["done", "stack", "comeBack"],
  not_done: ["done"],
  read: ["unread"],
  unread: ["unread"],
  stack: ["stack", "done"],
  unstack: ["stack"],
  come_back: ["comeBack", "done"],
  cancel_come_back: ["comeBack"],
  allow_sender: ["screened", "sender"],
  block_sender: ["done", "stack", "comeBack", "sender"],
  trash: ["trashed"],
};

export function groupsOf(kind: ActionKind): readonly Group[] {
  return GROUPS[kind];
}

/** Action kinds that touch this part. */
export function kindsTouching(group: Group): ActionKind[] {
  return (Object.keys(GROUPS) as ActionKind[]).filter((kind) => GROUPS[kind].includes(group));
}

/** Where a thread is: the parts whose change raises its revision and ends the undo of an allow or a block. */
export const WHERE: readonly Group[] = ["category", "screened", "done", "stack", "comeBack", "trashed"];

export interface ThreadState {
  category: Category;
  /** Who decided the category, or proposed one; null while nobody has. */
  categorizedBy: CategorySource | null;
  /**
   * Who did, by name (the AI with its model, the rule, the agent, the person's device); null for the mailbox and
   * while nobody has. Absent in a state a record kept from before it existed, which reads as null.
   */
  categorizedByActor?: Actor | null;
  screened: boolean;
  /** Screened because the mailbox filed it under Screening: such a filing holds even a one-time code. */
  screenedByMailbox: boolean;
  /**
   * The kind of mail that let it skip Screening while its sender isn't let in (`Thread.skippedScreening`); it goes with
   * `screened`, and a screened thread has none. Absent in a state a record kept from before it existed: none.
   */
  skippedScreening?: ScreeningPass | null;
  summary: string | null;
  done: boolean;
  stack: Stack | null;
  comeBackAt: number | null;
  comeBackIfNoReply: boolean;
  comeBackSetAt: number | null;
  unread: boolean;
  /** Which messages were unread and which read, so read and unread restore exactly. */
  unreadMessageIds: string[];
  readMessageIds: string[];
  trashed: boolean;
  need: Need | null;
  reason: string | null;
}

/**
 * Stored with every record: each affected thread as it was, and the sender's standing when the action changed
 * it (allow and block).
 */
export interface Before {
  /**
   * `revision` is the thread's revision right after the action: undo of an allow or a block compares it. `after`
   * is the thread as the action left it: a refused write-back puts back only the parts still as it left them.
   * Records stored before the fourth revision have no `after`.
   */
  threads: Array<{ id: string; state: ThreadState; revision?: number; after?: ThreadState }>;
  /** `mark` is the sender's mark right after the action. */
  sender?: { email: string; status: SenderStatus | null; mark?: string | null };
}

/** Allow and block reach every thread from a sender; their undo follows its own rules (docs/contract.md). */
export function isSenderAction(kind: ActionKind): kind is "allow_sender" | "block_sender" {
  return kind === "allow_sender" || kind === "block_sender";
}

/** Waiting to come back: a come-back time still ahead. */
export function waiting(state: Pick<ThreadState, "comeBackAt">, now: number): boolean {
  return state.comeBackAt !== null && state.comeBackAt > now;
}

/**
 * The categories the provider's inbox holds: conversations and what nobody has categorized yet, Home's (core's
 * `HOME_CATEGORIES`). A thread of one of them is in the provider's inbox exactly when it shows in Home. Notifications
 * stay under their label or folder, out of the inbox; neither Home decision (2026-11-18 in, 2026-11-19 out again)
 * moved anything in anyone's mailbox.
 */
export function inInboxCategory(category: Category): boolean {
  return category === "conversation" || category === "unknown";
}

/** Who decided a category, as the source and by name. The mailbox has no actor; the system decides nothing. */
export function decidedBy(actor: Actor): Pick<ThreadState, "categorizedBy" | "categorizedByActor"> | null {
  const source = sourceOf(actor);
  return source ? { categorizedBy: source, categorizedByActor: actor } : null;
}

/** A category the mailbox decided: a label read back, or a change made at the provider. */
export const BY_MAILBOX = { categorizedBy: "mailbox", categorizedByActor: null } as const;

/** The category source an actor's decision records. The system decides nothing. */
export function sourceOf(actor: Actor): CategorySource | null {
  switch (actor.kind) {
    case "person":
      return "person";
    case "rule":
      return "rule";
    case "agent":
      return "agent";
    case "ai":
      return "ai";
    case "system":
      return null;
  }
}

export function stateOf(row: ThreadRow, messages: Array<{ id: string; unread: boolean }>): ThreadState {
  return {
    category: row.category,
    categorizedBy: row.categorizedBy,
    categorizedByActor: row.categorizedByActor,
    screened: row.screened,
    screenedByMailbox: row.screenedByMailbox,
    skippedScreening: row.skippedScreening,
    summary: row.summary,
    done: row.done,
    stack: row.stack,
    comeBackAt: row.comeBackAt,
    comeBackIfNoReply: row.comeBackIfNoReply,
    comeBackSetAt: row.comeBackSetAt,
    unread: row.unread,
    unreadMessageIds: messages.filter((m) => m.unread).map((m) => m.id),
    readMessageIds: messages.filter((m) => !m.unread).map((m) => m.id),
    trashed: row.trashed,
    need: row.need,
    reason: row.reason,
  };
}

/** Whether two states agree on the given parts. "sender" is compared by the caller. */
export function sameIn(groups: readonly Group[], a: ThreadState, b: ThreadState): boolean {
  return groups.every((group) => {
    switch (group) {
      case "category":
        return a.category === b.category;
      case "screened":
        return a.screened === b.screened;
      case "done":
        return a.done === b.done;
      case "stack":
        return a.stack === b.stack;
      case "comeBack":
        return a.comeBackAt === b.comeBackAt && a.comeBackIfNoReply === b.comeBackIfNoReply;
      case "unread":
        return a.unread === b.unread && sameSet(a.unreadMessageIds, b.unreadMessageIds);
      case "trashed":
        return a.trashed === b.trashed;
      case "sender":
        return true;
    }
  });
}

/** `base` with the given parts taken from `from`. */
export function withGroups(groups: readonly Group[], base: ThreadState, from: ThreadState): ThreadState {
  const next = { ...base };
  for (const group of groups) {
    switch (group) {
      case "category":
        next.category = from.category;
        // A summary goes with the category it was written for: one-time codes have none, and a thread taken out of
        // `otp` gets back the one it had. A summary written since is kept.
        if (from.category === "otp") next.summary = null;
        else if (base.category === "otp" || next.summary === null) next.summary = from.summary ?? base.summary;
        break;
      case "screened":
        next.screened = from.screened;
        next.screenedByMailbox = from.screenedByMailbox ?? false;
        next.skippedScreening = from.skippedScreening ?? null;
        break;
      case "done":
        next.done = from.done;
        break;
      case "stack":
        next.stack = from.stack;
        break;
      case "comeBack":
        next.comeBackAt = from.comeBackAt;
        next.comeBackIfNoReply = from.comeBackIfNoReply;
        next.comeBackSetAt = from.comeBackSetAt;
        break;
      case "unread": {
        // Each message takes its flag from `from`; messages that arrived since keep their own.
        const all = [...base.unreadMessageIds, ...base.readMessageIds];
        if (all.length === 0) {
          next.unread = from.unread;
          break;
        }
        const unread = all.filter((id) =>
          from.unreadMessageIds.includes(id)
          || (!from.readMessageIds.includes(id) && base.unreadMessageIds.includes(id)));
        next.unreadMessageIds = unread;
        next.readMessageIds = all.filter((id) => !unread.includes(id));
        next.unread = unread.length > 0;
        break;
      }
      case "trashed":
        next.trashed = from.trashed;
        break;
      case "sender":
        break;
    }
  }
  return next;
}

/**
 * One thread's state after an action. `newestMessageId` is the message `unread` marks. Allow and block change
 * every thread from a sender; the caller applies them with `allowState` and `blockState`. Who decided a category
 * is set by the caller (`withDecision`).
 */
export function applyAction(
  state: ThreadState,
  action: ActionInput,
  now: number,
  newestMessageId: string | null,
): ThreadState {
  const next = { ...state };
  switch (action.kind) {
    case "categorize":
      return categorizedState(state, action.category);
    case "done":
      return doneState(state);
    case "not_done":
      next.done = false;
      break;
    case "read":
      next.readMessageIds = [...state.readMessageIds, ...state.unreadMessageIds];
      next.unreadMessageIds = [];
      next.unread = false;
      break;
    case "unread":
      if (state.unread) break;
      if (newestMessageId) {
        next.readMessageIds = state.readMessageIds.filter((id) => id !== newestMessageId);
        next.unreadMessageIds = [newestMessageId];
      }
      next.unread = true;
      break;
    case "stack":
      next.stack = action.stack;
      next.done = false;
      break;
    case "unstack":
      next.stack = null;
      break;
    case "come_back":
      next.comeBackAt = Date.parse(action.at);
      next.comeBackIfNoReply = action.ifNoReply === true;
      next.comeBackSetAt = now;
      next.done = false;
      break;
    case "cancel_come_back":
      return { ...state, ...NO_COME_BACK };
    case "allow_sender":
      return allowState(state);
    case "block_sender":
      return blockState(state);
    case "trash":
      next.trashed = true;
      break;
  }
  return next;
}

/**
 * A thread in a category. A screened thread stays screened, except that a one-time code stops being screened (its
 * sender still isn't let in), unless the mailbox filed it under Screening; and a one-time code loses its summary,
 * since one-time codes are never summarized. The server's AI at the screening gate decides screening itself
 * (`PerformInput.gate`): unscreened with a kind the server's own check confirmed, otherwise kept screened.
 */
export function categorizedState(state: ThreadState, category: Category): ThreadState {
  if (category !== "otp") return { ...state, category };
  return { ...state, category, screened: state.screened && state.screenedByMailbox, summary: null };
}

/** Letting a sender in: their threads stop being screened, whoever screened them. */
export function allowState(state: ThreadState): ThreadState {
  return state.screened ? { ...state, screened: false, screenedByMailbox: false } : state;
}

/** Blocking a sender marks their threads done. */
export function blockState(state: ThreadState): ThreadState {
  return doneState(state);
}

/** Done: off its stack, with no come-back time. A thread on a stack is never done. */
export function doneState(state: ThreadState): ThreadState {
  return { ...state, done: true, stack: null, ...NO_COME_BACK };
}

export const NO_COME_BACK = { comeBackAt: null, comeBackIfNoReply: false, comeBackSetAt: null } as const;

/** The columns a state sets on a thread row. */
export function stateColumns(state: ThreadState): Partial<ThreadRow> {
  return {
    category: state.category,
    categorizedBy: state.categorizedBy,
    // Only a source with an actor keeps one.
    categorizedByActor: state.categorizedBy && state.categorizedBy !== "mailbox" ? state.categorizedByActor ?? null : null,
    screened: state.screened,
    screenedByMailbox: state.screened && state.screenedByMailbox,
    skippedScreening: state.screened ? null : state.skippedScreening ?? null,
    summary: state.summary,
    done: state.done,
    stack: state.stack,
    comeBackAt: state.comeBackAt,
    comeBackIfNoReply: state.comeBackIfNoReply,
    comeBackSetAt: state.comeBackSetAt,
    unread: state.unread,
    trashed: state.trashed,
    need: state.need,
    reason: state.reason,
  };
}

/** How a category reads in words a person sees: "a newsletter". */
export const CATEGORY_WORDS: Record<Category, string> = {
  conversation: "a conversation",
  newsletter: "a newsletter",
  invoice: "an invoice",
  receipt: "a receipt",
  notification: "a notification",
  otp: "a one-time code",
  unknown: "undecided",
};

/** A category's list as interfaces name it: "Newsletters". */
export const CATEGORY_NAMES: Record<Category, string> = {
  conversation: "Conversations",
  newsletter: "Newsletters",
  invoice: "Invoices",
  receipt: "Receipts",
  notification: "Notifications",
  otp: "One-Time Codes",
  unknown: "Undecided",
};

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}
