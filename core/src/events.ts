/**
 * What the server tells connected apps as things change. Sent over `GET /v1/events`. Inboxes, threads, records,
 * drafts, rules, counts and the AI's settings and status carry a `version`; several changes may share one event, so a
 * version may rise by more than one. An inbox whose `lastSyncedAt` alone moved sends no event.
 */
import type { AiSettings, AiStatus } from "./ai.ts";
import type { ActionRecord, BlockedSender, Counts, Draft, Id, Inbox, Rule, Thread } from "./domain.ts";
import type { Unsubscribe } from "./unsubscribe.ts";

export type MailEvent =
  | { type: "inbox.changed"; inbox: Inbox }
  | { type: "inbox.removed"; inboxId: Id }
  | { type: "thread.changed"; thread: Thread }
  | { type: "thread.removed"; threadId: Id; inboxId: Id }
  | { type: "action.recorded"; record: ActionRecord }
  /**
   * A sender became blocked or stopped being blocked, by any way (a thread's action, `allowSender`, an undo, an
   * approved proposal), or mail from a blocked sender arrived. `sender` is their item while blocked, with the count
   * as it is now; absent when they are no longer blocked. Sent to people's devices only.
   */
  | { type: "sender.changed"; inboxId: Id; address: string; blocked: boolean; sender?: BlockedSender }
  /** Unsubscribing from a sender began or moved on (docs/contract.md, "Unsubscribing"). Sent to people's devices only. */
  | { type: "unsubscribe.changed"; unsubscribe: Unsubscribe }
  | { type: "draft.changed"; draft: Draft }
  | { type: "draft.removed"; draftId: Id; inboxId: Id }
  /**
   * A rule was made, changed, turned on or off, or sorted new mail (`hits`). Rules that sort a batch of new mail
   * send one event each for the batch, not one per thread.
   */
  | { type: "rule.changed"; rule: Rule }
  | { type: "rule.removed"; ruleId: Id; inboxId: Id }
  /** How many threads now wait in an inbox's triage queue. */
  | { type: "triage.pending"; inboxId: Id; count: number }
  /** The counts changed. Sent at most once a second, carrying the latest, for the inboxes the receiver may see. */
  | { type: "counts.changed"; counts: Counts }
  /** The AI's status changed. Sent at most once a second, carrying the latest. */
  | { type: "ai.status.changed"; status: AiStatus }
  /** The AI's settings changed. Sent to people's devices only; never carries the key. */
  | { type: "ai.settings.changed"; settings: AiSettings }
  | { type: "brief.ready"; briefId: Id };

export type MailEventType = MailEvent["type"];
