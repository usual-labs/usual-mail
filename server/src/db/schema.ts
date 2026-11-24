// The database schema. After changing it, run `npm run db:generate` to write the next migration.
// Times are Unix milliseconds. JSON columns hold core's own shapes.

import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  ActionInput,
  ActionState,
  Actor,
  Address,
  Avatar,
  AvatarFit,
  AiConnection,
  AiJob,
  AiUsageJob,
  AiState,
  BriefSection,
  Category,
  CategorySource,
  DeviceKind,
  DraftState,
  InboxConnection,
  InboxIcon,
  FromCheck,
  Need,
  NotificationEvent,
  PaymentDetails,
  ProviderKind,
  ProviderPlacement,
  RuleDraft,
  RuleMatch,
  RuleSource,
  Stack,
  TrustLevel,
} from "@usualmail/core";
import type { Before } from "../service/state.ts";

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
const bool = (name: string) => integer(name, { mode: "boolean" });

/** Connection state. "paused" is the separate `paused` column, so pausing keeps the last real state. */
export type ConnectionStatus = "connecting" | "ok" | "needs_attention";

export const inboxes = sqliteTable("inboxes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address").notNull(),
  color: text("color").notNull(),
  provider: text("provider").$type<ProviderKind>().notNull(),
  /** Its icon in the profile switch. */
  icon: text("icon").$type<InboxIcon>().notNull().default("person"),
  /** Its place in the inbox list, from 0, no two alike and no gaps. */
  position: integer("position").notNull().default(0),
  /**
   * Unused since 2026-11-17: there is no per-inbox AI switch any more (the owner's decision), and every inbox's mail
   * is processed once a key is set. Kept so stores that have it open without a migration; nothing reads it.
   */
  aiProcessing: bool("ai_processing").notNull().default(false),
  trust: text("trust").$type<TrustLevel>().notNull(),
  guide: text("guide").notNull().default(""),
  agentAccess: bool("agent_access").notNull().default(false),
  status: text("status").$type<ConnectionStatus>().notNull(),
  statusDetail: text("status_detail"),
  paused: bool("paused").notNull().default(false),
  lastSyncedAt: integer("last_synced_at"),
  createdAt: integer("created_at").notNull(),
  /** The provider's credentials as JSON, sealed with AES-GCM and bound to this inbox's id. */
  credentials: text("credentials").notNull(),
  /**
   * What of the credentials isn't secret, as the provider describes it (`Inbox.connection`). Written with the
   * credentials; null only in a store from before the fourth revision until the server fills it in at start.
   */
  connection: json<InboxConnection>("connection"),
  syncCursor: text("sync_cursor"),
  /** False until the first full sync. Mail seen before then is history: it skips rules and screening. */
  historyDone: bool("history_done").notNull().default(false),
  /**
   * How far the first sync has got, as the server last showed it (`Inbox.firstSync`): messages fetched, of the total
   * the provider counts in its window. Null until a count is shown, and again once the first sync is done.
   */
  firstSyncFetched: integer("first_sync_fetched"),
  firstSyncTotal: integer("first_sync_total"),
  /**
   * Set while the provider lists its window again after a `reset`: the mark this listing puts on each message
   * it includes. When the listing ends, messages without the mark are dropped.
   */
  resetListing: integer("reset_listing"),
  /** Rises with every change to the inbox as `Inbox` shows it, except `lastSyncedAt` moving. */
  version: integer("version").notNull().default(1),
});

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  inboxId: text("inbox_id").notNull().references(() => inboxes.id, { onDelete: "cascade" }),
  /** The provider's conversation key (`ProviderMessage.threadKey`). */
  threadKey: text("thread_key").notNull(),
  subject: text("subject").notNull(),
  snippet: text("snippet").notNull(),
  participants: json<Address[]>("participants").notNull(),
  lastMessageAt: integer("last_message_at").notNull(),
  messageCount: integer("message_count").notNull(),
  unread: bool("unread").notNull(),
  hasAttachments: bool("has_attachments").notNull(),
  category: text("category").$type<Category>().notNull().default("unknown"),
  /** Who decided the category, or proposed one. Null while nobody has. */
  categorizedBy: text("categorized_by").$type<CategorySource>(),
  /**
   * Who decided it by name: the AI with its model, the rule, the agent with its name, the person's device. Null for
   * the mailbox, while nobody has, and for decisions made before this column existed.
   */
  categorizedByActor: json<Actor>("categorized_by_actor"),
  /** Its sender hasn't been let in: in no list but the screening list and search. */
  screened: bool("screened").notNull().default(false),
  /**
   * Screened because the mailbox filed it under Screening (a person's filter, the first sync, a change made at the
   * provider), not by the sender gate. Such a filing holds even a one-time code.
   */
  screenedByMailbox: bool("screened_by_mailbox").notNull().default(false),
  /**
   * Screened while the server waits for the AI to categorize a stranger's new thread, so a one-time code isn't moved
   * to Screening and out again at the provider: the thread isn't written back until this is false.
   */
  gatePending: bool("gate_pending").notNull().default(false),
  /** The AI's one or two plain lines on what the thread is about. Never on a one-time code. */
  summary: text("summary"),
  /**
   * A `receipt` or `invoice` thread's details from the AI, checked (`ai/payment.ts`); null until processed, and
   * cleared when the thread leaves those categories. While a receipt or invoice has none, it needs them.
   */
  payment: json<PaymentDetails>("payment"),
  /**
   * A `notification` thread's event from the AI, checked (`ai/event.ts`); null until processed, and cleared when the
   * thread leaves `notification`. While a notification has none, it needs one.
   */
  event: json<NotificationEvent>("event"),
  /**
   * What joins a notification to others about the same thing (`ai/event-group.ts`): an opaque key from the reference
   * its mail prints, or for an appointment from what it is about and its day; null when nothing joins it. Kept here,
   * never served: `event.group` is this key unless too many threads share it (then null for all of them). Cleared
   * with the event. The reference itself is never stored.
   */
  eventKey: text("event_key"),
  /**
   * Its details, or a notification's event, are asked once more (`ai/ask-again.ts`), and the answer applies by that
   * asking-again's rule (since 2026-11-19's payment state: only facts the thread has none of; a notification's summary
   * stays). Cleared when the AI answers.
   */
  paymentAgain: bool("payment_again").notNull().default(false),
  /**
   * The sender picture served with this version (`Thread.avatar`), worked out by `avatars/settle.ts` whenever what it
   * depends on changes, so a change to it always raises the version. Null: initials.
   */
  avatar: json<Avatar>("avatar"),
  /**
   * The AI should categorize it: new and undecided, or filed elsewhere by the AI and joined by incoming mail since, or
   * marked to be asked again (`categoryAskAgain`). Cleared once the AI has answered, or its answer was dropped, unless
   * incoming mail joined meanwhile. A thread someone else decided is never asked, whatever this says.
   */
  categoryDue: bool("category_due").notNull().default(false),
  /**
   * Asked again, once, about a category the AI chose itself under words that have since changed (`ai/ask-again.ts`):
   * its next answer may be any of the six, not only `conversation`. Cleared when the AI answers.
   */
  categoryAskAgain: bool("category_ask_again").notNull().default(false),
  /** The AI should summarize it: it has no summary, or incoming mail joined since it was written. Same clearing. */
  summaryDue: bool("summary_due").notNull().default(false),
  done: bool("done").notNull(),
  stack: text("stack").$type<Stack>(),
  comeBackAt: integer("come_back_at"),
  comeBackIfNoReply: bool("come_back_if_no_reply").notNull().default(false),
  /** When the come-back was set: a reply after this cancels a `comeBackIfNoReply` wait. */
  comeBackSetAt: integer("come_back_set_at"),
  need: text("need").$type<Need>(),
  reason: text("reason"),
  /** The first incoming message's sender, lower case. Screening, allow and block are about this address. */
  sender: text("sender"),
  /** Trashed here or at the provider. Hidden from every list; still reachable by id for undo. */
  trashed: bool("trashed").notNull().default(false),
  /** Every message is gone at the provider. Kept so the action history still resolves. */
  removed: bool("removed").notNull().default(false),
  /** Goes up by one with every change; see `saveThreadState`. */
  version: integer("version").notNull().default(1),
  /**
   * Goes up whenever where the thread is changes (category, screened, done, stack, come-back time, trash), not when
   * it is read, summarized or a come-back time passes. Undoing an allow or a block puts back only threads whose
   * revision is still the one the action left.
   */
  revision: integer("revision").notNull().default(0),
  /** True once the come-back time has passed and been announced; false while one is still ahead. */
  comeBackAnnounced: bool("come_back_announced").notNull().default(false),
  createdAt: integer("created_at").notNull(),
}, (t) => [
  uniqueIndex("threads_key").on(t.inboxId, t.threadKey),
  index("threads_lists").on(t.inboxId, t.category, t.done, t.lastMessageAt),
  index("threads_event_key").on(t.inboxId, t.eventKey),
  index("threads_sender").on(t.inboxId, t.sender),
  index("threads_come_back").on(t.comeBackAt),
]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  inboxId: text("inbox_id").notNull().references(() => inboxes.id, { onDelete: "cascade" }),
  /** The provider's name for it. Write-back can change it (IMAP moves). */
  ref: text("ref").notNull(),
  /** The Message-ID header, without angle brackets. */
  messageId: text("message_id"),
  inReplyTo: text("in_reply_to"),
  references: json<string[]>("references").notNull(),
  from: json<Address>("from_address").notNull(),
  to: json<Address[]>("to_addresses").notNull(),
  cc: json<Address[]>("cc_addresses").notNull(),
  bcc: json<Address[]>("bcc_addresses").notNull(),
  replyTo: json<Address[]>("reply_to"),
  date: integer("date").notNull(),
  subject: text("subject").notNull(),
  text: text("text"),
  /** Sanitized by the provider. */
  html: text("html"),
  unread: bool("unread").notNull(),
  outgoing: bool("outgoing").notNull(),
  listId: text("list_id"),
  listUnsubscribe: text("list_unsubscribe"),
  automated: bool("automated").notNull(),
  /**
   * What the provider's own checker proved about the From domain (`ProviderMessage.fromCheck`): null until the server
   * asked (mail stored before it did, an IMAP inbox, a server without the Public Suffix List).
   */
  fromCheck: text("from_check").$type<FromCheck["result"]>(),
  /** The From domain the checker proved, in ASCII, when `fromCheck` is `verified`. */
  fromVerified: text("from_verified"),
  /** Where the provider has it, as last read from or written to the provider. */
  placement: json<ProviderPlacement>("placement").notNull(),
  /** The provider's seen flag, as last read or written. */
  seen: bool("seen").notNull(),
  /**
   * The mark of the reset listing that last included it (see `inboxes.resetListing`), or -1 (`IMPORTED`,
   * sync/ingest.ts) for a message of an old conversation opened from a search of the mailbox, which no listing drops.
   */
  listed: integer("listed"),
  createdAt: integer("created_at").notNull(),
}, (t) => [
  uniqueIndex("messages_ref").on(t.inboxId, t.ref),
  index("messages_message_id").on(t.inboxId, t.messageId),
  index("messages_thread").on(t.threadId, t.date),
]);

/**
 * Search's index of a thread (docs/contract-search.md, `src/search/`): one row per thread the index has read. Its
 * integer id is the row of `search_index`, the FTS5 table migration 0018 makes beside it (Drizzle has no virtual
 * tables, so it isn't declared here); a trigger deletes that row with this one, so a thread or an inbox deleted takes
 * its entries along by cascade.
 */
export const searchDocs = sqliteTable("search_docs", {
  id: integer("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  /** The thread's version when it was read: a thread whose version moved since is looked at again. */
  version: integer("version").notNull(),
  /** A hash of what was read from the thread's own columns: while it is the same, its messages aren't read again. */
  source: text("source").notNull(),
}, (t) => [uniqueIndex("search_docs_thread").on(t.threadId)]);

/**
 * Who wrote (`from`) and who was written to (`to`: To and Cc) in the messages of a thread a person sees, for the
 * `from` and `to` filters and the people a search finds. Written with the thread's index entry.
 */
export const searchPeople = sqliteTable("search_people", {
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  inboxId: text("inbox_id").notNull().references(() => inboxes.id, { onDelete: "cascade" }),
  role: text("role").$type<"from" | "to">().notNull(),
  /** Lower case. */
  email: text("email").notNull(),
  /** The name they last wrote under in this thread, when they gave one. */
  name: text("name"),
  /** Name and address folded (lower case, accents gone, ß as ss), with spaces around, for matching a word's start. */
  folded: text("folded").notNull(),
  /** Their newest message's time in this thread. */
  lastAt: integer("last_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.threadId, t.role, t.email] }),
  index("search_people_email").on(t.inboxId, t.role, t.email),
]);

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  /** The provider's id, passed back to `fetchAttachment`. */
  providerId: text("provider_id").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  inline: bool("inline").notNull(),
  contentId: text("content_id"),
  position: integer("position").notNull(),
}, (t) => [index("attachments_message").on(t.messageId)]);

/** Senders an inbox knows. A sender with no row is unknown, so new mail from them goes to screening. */
export const senders = sqliteTable("senders", {
  inboxId: text("inbox_id").notNull().references(() => inboxes.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  status: text("status").$type<SenderStatus>().notNull(),
  updatedAt: integer("updated_at").notNull(),
  /**
   * A fresh unique mark each time the sender is let in or blocked, by any way. Undoing a move that let a sender in
   * puts the sender back only while the mark is still the one the move left.
   */
  mark: text("mark"),
}, (t) => [primaryKey({ columns: [t.inboxId, t.email] })]);

export type SenderStatus = "known" | "blocked";

/**
 * Messages the server itself sent from an inbox: a copy of exactly that coming back without the provider's evidence
 * (an IMAP mailbox that keeps no copy in Sent, a copy to the inbox's own address) is still the inbox's own. Kept 90
 * days. `message_id` holds the Message-ID and, after a newline, a hash of who it was from and to, its subject, text,
 * HTML and attachments (`sentKey` in sync/identity.ts), so the Message-ID reused with other recipients or words, or
 * with HTML or attachments added, matches nothing; rows from before 2026-11-18's third review hold the Message-ID
 * alone and match nothing either.
 */
export const sentMessageIds = sqliteTable("sent_message_ids", {
  inboxId: text("inbox_id").notNull().references(() => inboxes.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull(),
  sentAt: integer("sent_at").notNull(),
}, (t) => [primaryKey({ columns: [t.inboxId, t.messageId] })]);

/**
 * Copies of a stored message (IMAP): the same Message-ID, kind (Sent or not) and content under another ref, reported
 * while the stored copy is still where it was. Anyone who received a message could send such a copy, so it changes
 * nothing then. When the stored copy's ref is reported removed later, the message moved (another app's move, or a new
 * UIDVALIDITY, its halves in different batches): it takes the copy's ref, seen flag and placement. Also the other copy
 * of the inbox's own mail (Sent and INBOX), so the message stays when the stored copy goes. A held copy goes when its
 * own ref is reported removed, or with its message or inbox.
 */
export const heldCopies = sqliteTable("held_copies", {
  inboxId: text("inbox_id").notNull().references(() => inboxes.id, { onDelete: "cascade" }),
  ref: text("ref").notNull(),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  seen: bool("seen").notNull(),
  placement: json<ProviderPlacement>("placement").notNull(),
  heldAt: integer("held_at").notNull(),
}, (t) => [primaryKey({ columns: [t.inboxId, t.ref] }), index("held_copies_message").on(t.messageId)]);

/** The action history. Ids are time-ordered, so lists order ties by id. */
export const actions = sqliteTable("actions", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  inboxId: text("inbox_id").notNull().references(() => inboxes.id, { onDelete: "cascade" }),
  action: json<ActionInput>("action").notNull(),
  /** `action.kind`, kept apart so queries can filter on it. */
  kind: text("kind").$type<ActionInput["kind"]>().notNull(),
  actor: json<Actor>("actor").notNull(),
  /** "person", "rule", "agent", "ai" or "system", for Handled. */
  actorKind: text("actor_kind").$type<Actor["kind"]>().notNull(),
  reason: text("reason"),
  state: text("state").$type<ActionState>().notNull(),
  at: integer("at").notNull(),
  undoneAt: integer("undone_at"),
  undoable: bool("undoable").notNull(),
  error: text("error"),
  /** A rule or an agent applied it alone in an act_silently inbox, or the AI applied it, and nothing went wrong since. */
  silent: bool("silent").notNull().default(false),
  /** The provider's note on the write-back this record caused. A later note replaces an earlier one. */
  note: text("note"),
  /** What the threads (and the sender) looked like before: what undo restores and approve compares. */
  before: json<Before>("before").notNull(),
  /** Goes up by one with every change to the record. */
  version: integer("version").notNull().default(1),
}, (t) => [
  index("actions_thread").on(t.threadId, t.at),
  index("actions_inbox").on(t.inboxId, t.at),
]);

export const rules = sqliteTable("rules", {
  id: text("id").primaryKey(),
  inboxId: text("inbox_id").notNull().references(() => inboxes.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  match: json<RuleMatch>("match").notNull(),
  then: json<ActionInput[]>("then").notNull(),
  source: text("source").$type<RuleSource>().notNull(),
  enabled: bool("enabled").notNull(),
  hits: integer("hits").notNull().default(0),
  /** Who made it. Rules from a store before the fourth revision say `system`: that wasn't recorded then. */
  createdBy: json<Actor>("created_by").notNull().default({ kind: "system" }),
  createdAt: integer("created_at").notNull(),
  /** Goes up with every change to the rule, `hits` included. */
  version: integer("version").notNull().default(1),
}, (t) => [index("rules_inbox").on(t.inboxId, t.createdAt)]);

export const teachPrompts = sqliteTable("teach_prompts", {
  id: text("id").primaryKey(),
  inboxId: text("inbox_id").notNull().references(() => inboxes.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  rule: json<RuleDraft>("rule").notNull(),
  fromActionId: text("from_action_id").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  answeredAt: integer("answered_at"),
});

export const drafts = sqliteTable("drafts", {
  id: text("id").primaryKey(),
  inboxId: text("inbox_id").notNull().references(() => inboxes.id, { onDelete: "cascade" }),
  threadId: text("thread_id"),
  inReplyToMessageId: text("in_reply_to_message_id"),
  to: json<Address[]>("to_addresses").notNull(),
  cc: json<Address[]>("cc_addresses").notNull(),
  bcc: json<Address[]>("bcc_addresses").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  createdBy: json<Actor>("created_by").notNull(),
  state: text("state").$type<DraftState>().notNull(),
  error: text("error"),
  /** The provider's note on a send that worked. */
  note: text("note"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  /** Goes up by one with every change to the draft. */
  version: integer("version").notNull().default(1),
}, (t) => [index("drafts_inbox").on(t.inboxId, t.updatedAt)]);

export const briefs = sqliteTable("briefs", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  from: integer("period_from").notNull(),
  to: integer("period_to").notNull(),
  sections: json<BriefSection[]>("sections").notNull(),
  writtenBy: json<Actor>("written_by").notNull(),
});

/** A person's app or an agent. Only a SHA-256 hash of its token is kept. */
export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").$type<DeviceKind>().notNull(),
  /** Agents only. */
  inboxIds: json<string[]>("inbox_ids"),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at"),
  revokedAt: integer("revoked_at"),
});

/** Only a SHA-256 hash of each code is kept. A code works once. */
export const pairingCodes = sqliteTable("pairing_codes", {
  codeHash: text("code_hash").primaryKey(),
  kind: text("kind").$type<DeviceKind>().notNull(),
  inboxIds: json<string[]>("inbox_ids"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
});

/**
 * One row (id 1) for what belongs to the whole server: the AI's settings with its sealed key, the AI's status, and
 * the version of the counts.
 */
export const serverState = sqliteTable("server_state", {
  id: integer("id").primaryKey(),
  /** The AI credentials as JSON, sealed with AES-GCM like mailbox credentials. Null while none are set. */
  aiCredentials: text("ai_credentials"),
  /**
   * The service the credentials reach, without the key. Kept after the credentials are removed, so new credentials
   * for the same service keep the models a person chose.
   */
  aiService: json<AiConnection>("ai_service"),
  /** The model a person chose for each job, or null for the server's default. */
  aiModels: json<Partial<Record<AiJob, string | null>>>("ai_models").notNull().default({}),
  /** Unread since 2026-11-18: the AI's history is all synced mail. Kept, so no migration is needed for nothing. */
  historyDays: integer("history_days").notNull().default(7),
  aiPaused: bool("ai_paused").notNull().default(false),
  settingsVersion: integer("settings_version").notNull().default(1),
  /**
   * How the service last answered: null until it has been asked, then `working` or one of the failure states. The
   * status shows `not_set_up` and `paused` from the settings instead.
   */
  aiState: text("ai_state").$type<Exclude<AiState, "not_set_up" | "paused">>(),
  aiDetail: text("ai_detail"),
  aiJob: text("ai_job").$type<AiJob>(),
  /** When the AI last processed a thread. */
  aiLastRunAt: integer("ai_last_run_at"),
  /** After a failure: when to try one request again. */
  aiRetryAt: integer("ai_retry_at"),
  /** Failures in a row while unavailable, for the growing pause. */
  aiFailures: integer("ai_failures").notNull().default(0),
  statusVersion: integer("status_version").notNull().default(1),
  countsVersion: integer("counts_version").notNull().default(1),
  /** When the server began keeping the AI's usage (`aiUsage.since`): set at its first start with `ai_usage`. */
  aiUsageSince: integer("ai_usage_since"),
  /** The last asking-again this store has had (`AskAgain.id` in `ai/ask-again.ts`), so each happens once. */
  categoriesAskedAgain: text("categories_asked_again"),
  /** The last asking-again of payment details or events this store has had (`DETAILS_AGAIN_ORDER` in `ai/ask-again.ts`). */
  detailsAskedAgain: text("details_asked_again"),
  /** The last once-only pass of payment rules over stored details this store has had (`PAYMENT_RULES`, `ai/payment-store.ts`). */
  paymentRulesApplied: text("payment_rules_applied"),
});

/**
 * The AI's usage of the person's account, one row per UTC hour, job and model (`GET /v1/ai/usage`): no thread, no mail,
 * no name or address. Counts what the service reported: tokens and cost are sums over the requests that reported
 * them, with how many did, so a client can tell "not reported" and "at least" from a number. Kept for 90 days.
 */
export const aiUsage = sqliteTable("ai_usage", {
  /** The start of the UTC hour, Unix milliseconds. */
  hour: integer("hour").notNull(),
  job: text("job").$type<AiUsageJob>().notNull(),
  model: text("model").notNull(),
  requests: integer("requests").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  /** How many requests reported input tokens. */
  inputReported: integer("input_reported").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  outputReported: integer("output_reported").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  /** How many requests reported a cost. */
  costReported: integer("cost_reported").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.hour, t.job, t.model] })]);

/**
 * Cost lookups still to make (`ai/costs.ts`): a request's generation id at Vercel's AI Gateway, and the hour, job and
 * model whose `ai_usage` row its cost goes to. No thread, no mail. Kept across restarts; dropped when looked up, given
 * up, or when no lookup can be made (no key, or a service without lookups).
 */
export const aiCostLookups = sqliteTable("ai_cost_lookups", {
  generationId: text("generation_id").primaryKey(),
  hour: integer("hour").notNull(),
  job: text("job").$type<AiUsageJob>().notNull(),
  model: text("model").notNull(),
  tries: integer("tries").notNull().default(0),
  /** When to try next, Unix milliseconds. */
  nextAt: integer("next_at").notNull(),
}, (t) => [index("ai_cost_lookups_due").on(t.nextAt)]);

/**
 * Sender pictures, one row per registrable domain, for every inbox (docs/contract-avatars.md): what was found at the
 * domain's own site, or that nothing was, and when to look. `queued`: wanted, not fetched yet. `found`: a picture is
 * kept. `none`: the site has no icon the server shows. `failed`: the site couldn't be reached; tried again later.
 */
export const avatarSites = sqliteTable("avatar_sites", {
  domain: text("domain").primaryKey(),
  state: text("state").$type<AvatarSiteState>().notNull(),
  /** When to fetch it next; null when nothing is due (a picture or a record kept until mail asks again). */
  dueAt: integer("due_at"),
  /** Fetches that failed in a row. */
  tries: integer("tries").notNull().default(0),
  /** The picture's id in its path, a hash of the domain and the bytes: a new picture gets a new id. */
  pictureId: text("picture_id"),
  mimeType: text("mime_type"),
  /** The picture's bytes, base64 (at most 1 MB before). */
  data: text("data"),
  width: integer("width"),
  height: integer("height"),
  fit: text("fit").$type<AvatarFit>(),
  /** When it was last fetched, whatever came of it. */
  checkedAt: integer("checked_at"),
  /** When mail that may show it last arrived or was settled: one unwanted for 180 days goes. */
  wantedAt: integer("wanted_at").notNull(),
  /** Why there is no picture, in words for a person (a refusal or a failure); null with a picture. */
  reason: text("reason"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("avatar_sites_due").on(t.dueAt), uniqueIndex("avatar_sites_picture").on(t.pictureId)]);

export type AvatarSiteState = "queued" | "found" | "none" | "failed";

