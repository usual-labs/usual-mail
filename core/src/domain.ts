/**
 * The vocabulary of Usual Mail. Every package builds on these types.
 * Rules for what each field means and who may change it are in docs/contract.md and the pages it names.
 */
import type { AiJob } from "./ai.ts";
import type { Avatar } from "./avatars.ts";
import type { FirstSyncProgress } from "./first-sync.ts";
import type { InboxStatusReason } from "./inbox-health.ts";
import type { GoogleSignInInfo } from "./google.ts";
import type { OwnerInfo } from "./owner.ts";
import type { RemotePictures } from "./pictures.ts";
import type { ScreeningPass } from "./screening.ts";
import type { Unsubscribe } from "./unsubscribe.ts";

/** Opaque identifier. Never parse it. */
export type Id = string;

/** ISO 8601 timestamp in UTC, for example "2026-11-16T09:30:00Z". */
export type IsoTime = string;

/** Gmail is the provider the product is built and proven for. Outlook comes when it is built. */
export type ProviderKind = "imap" | "gmail";

/**
 * How much outside agents, and rules an agent made, may do alone in an inbox. Rules a person taught and the server's
 * own AI aren't governed by it.
 */
export type TrustLevel = "suggest" | "act_with_undo" | "act_silently";
export const TRUST_LEVELS = ["suggest", "act_with_undo", "act_silently"] as const;

/**
 * What kind of mail a thread is. Every thread has exactly one. `conversation` is mail between people that may need
 * the person; `unknown` means nobody has decided yet, or the AI isn't working. Home shows `conversation` and
 * `unknown` (`HOME_CATEGORIES`).
 */
export type Category = "conversation" | "newsletter" | "invoice" | "receipt" | "notification" | "otp" | "unknown";
export const CATEGORIES = [
  "conversation",
  "newsletter",
  "invoice",
  "receipt",
  "notification",
  "otp",
  "unknown",
] as const;

/**
 * The categories Home shows: conversations and what nobody has categorized yet. Notifications have their own tab and
 * list, not Home (the owner's decision of 2026-11-19, replacing that of 2026-11-18).
 */
export const HOME_CATEGORIES = ["conversation", "unknown"] as const satisfies readonly Category[];

/** A category someone can decide. Nobody decides `unknown`. */
export type DecidedCategory = Exclude<Category, "unknown">;

/** The categories filed under their own label or folder at the provider. */
export type FiledCategory = Exclude<Category, "conversation" | "unknown">;
export const FILED_CATEGORIES = ["newsletter", "invoice", "receipt", "notification", "otp"] as const;

/**
 * The categories about money: a thread in one of them carries the server's AI's `payment` details (who, how much,
 * what for) instead of a free summary, once processed (docs/contract-ai.md, "Payment details").
 */
export const PAYMENT_CATEGORIES = ["receipt", "invoice"] as const satisfies readonly Category[];
/** The longest `PaymentDetails.party` the server keeps; longer is shortened, never dropped. */
export const PAYMENT_PARTY_LIMIT = 60;
/** The longest `PaymentDetails.what` the server keeps; longer is shortened, never dropped. */
export const PAYMENT_WHAT_LIMIT = 100;

/** The longest `NotificationEvent.status` the server keeps; longer is shortened, never dropped. */
export const EVENT_STATUS_LIMIT = 40;
/** The longest `NotificationEvent.about` the server keeps; longer is shortened, never dropped. */
export const EVENT_ABOUT_LIMIT = 80;

/**
 * What a notification tells of, as the server's AI read it, each fact checked by the server against the mail it was
 * given (docs/contract-ai.md, "Notification events"; the owner's request of 2026-11-19). Facts it couldn't check are
 * null; all of them are null for a notification that tells of no event (a digest). Plain text, never HTML.
 */
export interface NotificationEvent {
  /** What happened or will happen, a short plain phrase in English whatever the mail's language: "Out for delivery". */
  status: string | null;
  /** What or who it concerns, as the mail names it: "Parcel from Fernhill Books". Never the sender's name alone. */
  about: string | null;
  /**
   * The moment it matters, as the mail states it, in the mail's own local reading (no time zone): a calendar date, and
   * a start time and an end time (a delivery window) when the mail gives them. Null without a date.
   */
  when: { date: string; time: string | null; endTime: string | null } | null;
  /**
   * An opaque string, the same on notification threads of one inbox that tell of the same thing (one parcel, order,
   * booking or appointment); absent or null when the server found nothing to join it by. Clients only compare it:
   * same string, same thing (docs/contract.md, "Notification groups"). Never derived from by a client.
   */
  group?: string | null;
}

/**
 * Where the money stands, as the mail says it (the owner's decision of 2026-11-19): `paid` (paid or charged already),
 * `scheduled` (it will be collected automatically: a direct debit, a card on file, an instalment or a renewal that will
 * be charged), `due` (the reader has to pay it themselves).
 */
export type PaymentState = "paid" | "scheduled" | "due";
export const PAYMENT_STATES = ["paid", "scheduled", "due"] as const satisfies readonly PaymentState[];

/**
 * What the server's AI read in a receipt or an invoice, each fact checked by the server against the mail it was given
 * (docs/contract-ai.md, "Payment details"). Facts it couldn't check are null. Plain text, never HTML. An interface's
 * title follows `state` ("Paid", "Will be charged", "To be paid"), `refund` ("Refunded"), and, while `state` is null,
 * the category (an invoice is to be paid, a receipt paid).
 */
export interface PaymentDetails {
  /** The company or person the money goes to or came from, as they call themselves; else the sender's name. */
  party: string | null;
  /**
   * The amount in the currency's minor units (cents for EUR, whole yen for JPY), with its ISO 4217 code. Kept only
   * when the same number is written in the mail. Never negative: a refund says so in `refund`.
   */
  amount: { minor: number; currency: string } | null;
  /** The money came back to the reader. Then `state` is `paid`. */
  refund: boolean;
  /** Where the money stands, or null when the mail doesn't say. */
  state: PaymentState | null;
  /**
   * A calendar date (YYYY-MM-DD) the mail states: when it will be charged (`scheduled`) or is due (`due`, or a null
   * state on an invoice). Never while it is paid (`paid`, or a null state on a receipt).
   */
  dueDate: string | null;
  /** What it was for, in one short plain line, without the party or the amount. */
  what: string | null;
}

/**
 * Who decided a thread's category, or proposed one: the server's AI, a rule, an outside agent, the person, or the
 * mailbox (read back from a label or folder, or a change made at the provider).
 */
export type CategorySource = "ai" | "rule" | "agent" | "person" | "mailbox";
export const CATEGORY_SOURCES = ["ai", "rule", "agent", "person", "mailbox"] as const;

/** Where a person puts a thread on purpose. A thread is on at most one stack. */
export type Stack = "reply_later" | "set_aside";
export const STACKS = ["reply_later", "set_aside"] as const;

/** An inbox's icon in the profile switch. */
export type InboxIcon = (typeof INBOX_ICONS)[number];
/**
 * The icons an inbox may have, in the order pickers show them: the first six, then the eight the owner asked for on
 * 2026-11-20 ("in the settings user should be able to change the icon for the inboxes"). A new inbox takes the next
 * of the first three in turn.
 */
export const INBOX_ICONS = ["person", "building", "briefcase", "house", "shop", "globe", "plane", "wallet", "family", "rocket", "school", "heart", "star", "leaf"] as const;

export interface Address {
  name?: string;
  email: string;
}

export type InboxStatus = "connecting" | "ok" | "needs_attention" | "paused";

/** A mail server's address and login, without the password. */
export interface ServerLogin {
  host: string;
  port: number;
  /** True for TLS from the start (993, 465); false for STARTTLS. */
  secure: boolean;
  user: string;
}

/**
 * How an inbox is connected, without anything secret, so a form can show it again. Never a password, a client
 * secret or a token. New credentials replace the stored ones whole, so a client sends the secrets again with
 * whatever it shows from here. An inbox whose stored credentials no provider could describe has an empty host and
 * user (IMAP) or client id (Gmail).
 */
export type InboxConnection =
  | {
    kind: "imap";
    imap: ServerLogin;
    smtp: ServerLogin;
    /** Whether a copy of sent mail is saved to the Sent folder. */
    saveSent: boolean;
  }
  | {
    kind: "gmail";
    /** The Google OAuth client its refresh token belongs to. */
    clientId: string;
    /**
     * `google` when a person connected it by signing in with Google through the server's own Google client (the
     * server then keeps only the token and uses the host's client secret); absent when the client id, secret and
     * refresh token were given by hand.
     */
    signIn?: "google";
  };

/** One connected mailbox. In the apps it is a profile with an icon, and a company's colour. */
export interface Inbox {
  id: Id;
  /** Shown to the person, for example the company's name. */
  name: string;
  /** The mailbox's own address. */
  address: string;
  /** The company's colour as "#RRGGBB", in either case. Interfaces show the nearest of the twelve hat colours. */
  color: string;
  /** Its icon in the profile switch. */
  icon: InboxIcon;
  /** Its place in the profile switch and the inbox list, from 0, no two alike and no gaps. */
  position: number;
  provider: ProviderKind;
  /** How it is connected, without secrets. Its `kind` is the inbox's `provider`. */
  connection: InboxConnection;
  trust: TrustLevel;
  /** Plain-language notes on how to handle this inbox. People and agents read and edit it. Markdown. */
  guide: string;
  /** Whether agents and chat apps may read this inbox at all. False until the person turns it on. */
  agentAccess: boolean;
  /**
   * "connecting" from connecting or new credentials until the next good sync; "paused" while the person paused it,
   * when nothing is read from or written to the provider.
   */
  status: InboxStatus;
  /** Why the status is not "ok", in words a person can act on. */
  statusDetail?: string;
  /**
   * Why it is `needs_attention`, so an interface offers the step that fits (`InboxStatusReason`); only with that
   * status. Absent from a server before 0.1.2.
   */
  statusReason?: InboxStatusReason;
  /**
   * How far its first sync has got, while it runs (docs/contract-sync.md, "How far a first sync has got"). Present
   * once the provider has counted the first sync's window and the first sync has run for
   * `FIRST_SYNC_PROGRESS_EVERY_MS`; absent once it is done, which comes with its status turning `ok`. While it is
   * present the first sync is still running, whatever the status: it keeps the count it reached while the inbox
   * needs attention, or is paused (pausing stops the first sync once the batch being fetched is stored; resuming goes
   * on from there), and may stay a little after a long first sync's status already says `ok`. A change raises the
   * version and sends `inbox.changed`, at most every `FIRST_SYNC_PROGRESS_EVERY_MS`.
   */
  firstSync?: FirstSyncProgress;
  /** Moving alone is not a change: it raises no version and sends no event. Read it from the inbox list. */
  lastSyncedAt?: IsoTime;
  createdAt: IsoTime;
  /**
   * Rises with every change to the inbox except `lastSyncedAt` moving, and may rise by more than one. Of two
   * copies, keep the higher.
   */
  version: number;
}

/** What a thread asks of the person. */
export type Need = "reply" | "decide" | "pay" | "read";

export interface Thread {
  id: Id;
  inboxId: Id;
  subject: string;
  /** A short plain-text preview of the latest message. */
  snippet: string;
  participants: Address[];
  lastMessageAt: IsoTime;
  messageCount: number;
  unread: boolean;
  hasAttachments: boolean;
  category: Category;
  /** Who decided the category, or proposed one. Absent while nobody has. */
  categorizedBy?: CategorySource;
  /**
   * Who decided the category, or proposed one, by name, so "why it's here" can say so: the server's AI with its model
   * (`categorizedBy: "ai"`), the rule (`rule`), the agent with its name (`agent`) or the person's device (`person`).
   * Absent while `categorizedBy` is absent or `mailbox`, and for a decision a server made before it kept this (a store
   * from before 2026-11-17's amendment).
   */
  categorizedByActor?: Actor;
  /**
   * The address the screening gate, letting a sender in and blocking are about: the sender of the thread's oldest
   * message someone else sent (not the mailbox's own), lower case. Every thread of that address is screened or
   * unscreened, let in or blocked together. Absent for a thread that holds only the mailbox's own mail.
   */
  sender?: string;
  /**
   * True while its sender hasn't been let in, whatever its category, or while the mailbox has it filed under
   * Screening. A screened thread is in no list but the screening list and search. It stops being screened when its
   * sender is let in. A one-time code isn't held back by the sender gate, except when the server's AI called it one
   * and the server's own check didn't hold; the mailbox's filing under Screening holds even a code.
   */
  screened: boolean;
  /** Done threads are in no list but search. Written back to the provider as archived. */
  done: boolean;
  /** A thread on a stack is never done: stacking clears `done`, and marking done takes it off the stack. */
  stack?: Stack;
  /**
   * Hidden from Home until this time. It stays set after it passes, as the time the thread came back, and
   * the thread then sorts by it. Cleared by `cancel_come_back`, by `done`, and when a reply ends an
   * `ifNoReply` wait early.
   */
  comeBackAt?: IsoTime;
  /** With comeBackAt: come back only if nobody has answered by then. */
  comeBackIfNoReply?: boolean;
  /**
   * In the provider's trash. A trashed thread is in no list of threads, though Handled still carries it with its
   * records. Only undoing the trash acts on it.
   */
  trashed: boolean;
  /** Rises with every change to the thread and may rise by more than one. Of two copies, keep the higher. */
  version: number;
  need?: Need;
  /** One line on why it is where it is, for example a rule's text or an agent's reason. */
  reason?: string;
  /**
   * Why a thread whose sender wasn't let in is out of Screening: the kind of mail the server's AI named and the server's
   * own check confirmed (docs/contract.md, "Rules and learning"). Its sender isn't let in by it. Shown as
   * `skippedScreeningLine` ("Skipped Screening: a sign-in link"). Absent while the thread is screened, and for every
   * other way out of Screening.
   */
  skippedScreening?: ScreeningPass;
  /**
   * What the thread is about, in one or two plain lines, without the sender's name (interfaces add it), written by
   * the server's AI. Plain text, no line breaks, at most 200 characters. Absent until written; it is never HTML.
   * An `otp` thread never has one. For a `receipt` or `invoice` thread it is `payment.what` when there is one.
   */
  summary?: string;
  /**
   * A `receipt` or `invoice` thread's details, once the server's AI has processed it: who, how much and what for,
   * each checked against the mail. Absent for every other category and until processed; removed when the thread
   * leaves those categories.
   */
  payment?: PaymentDetails;
  /**
   * A `notification` thread's event, once the server's AI has processed it: what happened, about what, and when.
   * Absent for every other category and until processed; removed when the thread leaves `notification`. `summary`
   * stays a normal one-line summary beside it.
   */
  event?: NotificationEvent;
  /**
   * The picture to show for `sender` instead of initials: their organisation's own icon, when the mailbox provider
   * proved the domain of their From, they are let in, the thread isn't screened and the mail is an organisation's
   * (docs/contract-avatars.md). Absent otherwise, always for a screened thread or a blocked sender. When it appears,
   * changes or goes, the version rises.
   */
  avatar?: Avatar;
}

export interface AttachmentMeta {
  id: Id;
  filename: string;
  mimeType: string;
  /** Bytes. */
  size: number;
  /** True for pictures shown inside the message body. */
  inline: boolean;
  /** For an inline picture: the Content-ID its HTML refers to (as `cid:`), without angle brackets. */
  contentId?: string;
}

export interface Message {
  id: Id;
  threadId: Id;
  inboxId: Id;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  date: IsoTime;
  subject: string;
  text?: string;
  /**
   * Sanitized HTML: no scripts, no forms, no remote loads except through the server. Each picture from the web it
   * shows points at the server's picture route (`picturePath`); trackers and held-back pictures are taken out.
   */
  html?: string;
  attachments: AttachmentMeta[];
  unread: boolean;
  /**
   * True when the inbox sent it, by the provider's evidence (Gmail's SENT label, IMAP's Sent folder) or because the
   * server itself sent it with this Message-ID. Never because From names the inbox's own address: such mail is
   * treated like anyone's, and apps show its From as written rather than "You".
   */
  outgoing: boolean;
  /** The mailing list's id from the List-Id header: the part in angle brackets, lower case. Rules match on it. */
  listId?: string;
  /** What the server did with the pictures its HTML takes from the web. Absent when it takes none. */
  remotePictures?: RemotePictures;
  /** Set when its HTML was longer than `MAX_SHOWN_HTML_LENGTH`: `html` is left out, and `text` is the message. */
  htmlTooLarge?: true;
  /**
   * The picture to show for `from` instead of initials, by the same rules as `Thread.avatar` applied to this
   * message's own From (docs/contract-avatars.md). Never on the inbox's own mail.
   */
  avatar?: Avatar;
}

export type DraftState = "draft" | "sending" | "sent" | "failed";

/**
 * `draft` and `failed` drafts are listed. A sent draft that carries a `note` is kept for a day from its `updatedAt`
 * (when it was sent), in its thread's `drafts`, so the note can be shown; a sent draft without one is removed once
 * sent. A draft left `sending` by a stop is `failed` after the next start, saying it may have gone out.
 */
export interface Draft {
  id: Id;
  inboxId: Id;
  /** Set for a reply. */
  threadId?: Id;
  inReplyToMessageId?: Id;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** Plain text. */
  body: string;
  /** An agent may change or delete only a draft an agent wrote. A person may change or delete any. */
  createdBy: Actor;
  state: DraftState;
  updatedAt: IsoTime;
  /** Why sending failed. */
  error?: string;
  /** Something a person should know about a send that worked, for example that no copy was saved to Sent. */
  note?: string;
  /** Rises with every change to the draft and may rise by more than one. Of two copies, keep the higher. */
  version: number;
}

export interface ThreadDetail {
  thread: Thread;
  /** Oldest first. */
  messages: Message[];
  /** The thread's drafts in state `draft`, `sending` or `failed`, and sent ones with a `note` for a day. Oldest first. */
  drafts: Draft[];
}

/** Who did something. `ai` is the server's own AI, naming the job and the model that did it. */
export type Actor =
  | { kind: "person"; deviceId: Id }
  | { kind: "rule"; ruleId: Id }
  | { kind: "agent"; agentId: Id; name: string }
  | { kind: "ai"; job: AiJob; model: string }
  | { kind: "system" };

/** Something that can be done to a thread. */
export type ActionInput =
  /**
   * Sets the category. It lets no sender in, and a screened thread stays screened, except that a thread put in `otp`
   * stops being screened and loses its summary.
   */
  | { kind: "categorize"; category: DecidedCategory }
  | { kind: "done" }
  | { kind: "not_done" }
  | { kind: "read" }
  | { kind: "unread" }
  | { kind: "stack"; stack: Stack }
  | { kind: "unstack" }
  | { kind: "come_back"; at: IsoTime; ifNoReply?: boolean }
  | { kind: "cancel_come_back" }
  /** Screening answer: this sender may reach the inbox. Their threads stop being screened. */
  | { kind: "allow_sender" }
  /** Screening answer: never show this sender again. */
  | { kind: "block_sender" }
  | { kind: "trash" };

export type ActionKind = ActionInput["kind"];

/**
 * Actions an outside agent, or a rule an agent made, may never apply alone, whatever the trust level. A rule a person
 * taught applies them, as the person's own instruction.
 */
export const NEEDS_PERSON: readonly ActionKind[] = ["trash", "block_sender"];

export type ActionState = "proposed" | "applied" | "undone" | "rejected" | "failed";

/** One entry in an inbox's history. Handled is a list of these. */
export interface ActionRecord {
  id: Id;
  threadId: Id;
  inboxId: Id;
  action: ActionInput;
  actor: Actor;
  /** One line a person can read, for example "Promotion from a shop you never open". */
  reason?: string;
  state: ActionState;
  at: IsoTime;
  undoneAt?: IsoTime;
  /** False once it can no longer be reversed. */
  undoable: boolean;
  /**
   * True when a rule or an agent applied it alone in an inbox whose trust is "act_silently", or the server's AI
   * applied it, and nothing went wrong. A proposal is never silent, nor is anything a person does. When the provider
   * refuses the record or its undo, or adds a note, it turns false for good, so silence never hides trouble. Silent
   * records can be undone like any other. Handled leaves them out unless asked, and a brief's counts always do.
   */
  silent: boolean;
  /** Why it failed, or why an undo of it was refused. */
  error?: string;
  /** Something a person should know about a write-back that worked, for example "This server can't keep stacks". */
  note?: string;
  /** Rises with every change to the record and may rise by more than one. Of two copies, keep the higher. */
  version: number;
}

/**
 * A sender an inbox has blocked, as a person's Settings lists them (docs/contract.md, "Blocked senders"; the owner's
 * request of 2026-11-20). Person only: no agent reads it.
 */
export interface BlockedSender {
  inboxId: Id;
  /** The blocked address, lower case. */
  address: string;
  /** The name their newest stored mail gives; absent when none does. */
  name?: string;
  /** Since when they are blocked: when the block in force now was applied. */
  blockedAt: IsoTime;
  /** Who blocked them, as that action's record says it (a person, a rule, an agent); absent when no record of it is left. */
  blockedBy?: Actor;
  /**
   * How many messages from this address the server holds in this inbox with a date after `blockedAt`: mail they sent
   * that was blocked. Counted from the stored messages, never guessed: mail the mailbox itself kept out (its spam) or
   * that has since been deleted there isn't counted.
   */
  messagesSinceBlocked: number;
  /** The date of their newest stored mail in this inbox, before or after the block; null when none is held. */
  lastMessageAt: IsoTime | null;
  /** Asking them to stop, when a person unsubscribed from them in this inbox (docs/contract.md, "Unsubscribing"). */
  unsubscribe?: Unsubscribe;
}

/** A rule matches a message when every field that is set matches. */
export interface RuleMatch {
  /** Exact sender address, lower case. */
  from?: string;
  /** Sender's domain, lower case, without "@". Also matches its subdomains. */
  domain?: string;
  /** A mailing list's id, as `Message.listId` gives it. */
  listId?: string;
  /** Case-insensitive. */
  subjectContains?: string;
  /** The address the mail was sent to, for aliases. */
  to?: string;
  /** True matches mail a machine sent (bulk, auto-submitted, no-reply). */
  automated?: boolean;
}

/**
 * `person` and `correction` (a teach prompt the person answered yes) are rules the person taught: they always apply,
 * whatever the inbox's trust. `agent` rules apply under the trust table.
 */
export type RuleSource = "person" | "correction" | "agent";

export interface Rule {
  id: Id;
  inboxId: Id;
  /** Plain language, shown as written: "Receipts from stripe.com are receipts". */
  text: string;
  match: RuleMatch;
  /** Applied in order to a matching new thread. Only kinds in `RULE_ACTIONS`. */
  then: ActionInput[];
  source: RuleSource;
  /**
   * A rule an agent creates starts disabled. Only a person turns a rule on. An agent changing the `match` or
   * `then` of an enabled agent rule switches it off.
   */
  enabled: boolean;
  /** How many threads it has sorted. */
  hits: number;
  /**
   * Who made it: a person (also by answering a teach prompt) or an agent. `system` for a rule made before rules
   * recorded their maker.
   */
  createdBy: Actor;
  createdAt: IsoTime;
  /**
   * Rises with every change to the rule, its `hits` included, and may rise by more than one. Of two copies, keep
   * the higher.
   */
  version: number;
}

/** The kinds of action a rule may hold. */
export const RULE_ACTIONS: readonly ActionKind[] = [
  "categorize",
  "done",
  "read",
  "stack",
  "allow_sender",
  "block_sender",
  "trash",
];

export type RuleDraft = Pick<Rule, "inboxId" | "text" | "match" | "then">;

/** Asked after a person corrects something: "Always treat mail from this sender as a newsletter?" */
export interface TeachPrompt {
  id: Id;
  question: string;
  rule: RuleDraft;
  fromActionId: Id;
  expiresAt: IsoTime;
}

/** A thread whose category nobody has decided and the server's AI won't, with what an agent needs to decide. */
export interface TriageItem {
  thread: Thread;
  /** The newest message, with its text. */
  latest: Message;
}

export interface TriageDecision {
  threadId: Id;
  category: DecidedCategory;
  /** True when the person need not see it in Home. */
  done?: boolean;
  need?: Need;
  /** Required: one line a person can read. */
  reason: string;
}

export interface BriefHighlight {
  threadId: Id;
  /** The thread's subject when the brief was written. Filled in by the server. */
  subject: string;
  /** One sentence. */
  line: string;
}

export interface BriefSection {
  inboxId: Id;
  /** Written by an agent. Plain text. */
  summary?: string;
  /** How many threads rules and agents handled in the period, by where they are now. */
  counts: Partial<Record<Category | "done" | "trash", number>>;
  highlights: BriefHighlight[];
}

/** A readable account of what happened across inboxes between two times. */
export interface Brief {
  id: Id;
  createdAt: IsoTime;
  from: IsoTime;
  to: IsoTime;
  sections: BriefSection[];
  writtenBy: Actor;
}

/** How many threads are in each list, as the contract's "Lists" table defines them. */
export interface ThreadCounts {
  /** Home. */
  home: number;
  /** Home's unread threads: its "New" for now. */
  unread: number;
  /** Each category's list. */
  categories: Record<Category, number>;
  /** Each stack's list. */
  stacks: Record<Stack, number>;
  /** The waiting list: threads whose come-back time is ahead. */
  waiting: number;
  /** The screening list. */
  screened: number;
}

export interface InboxCounts extends ThreadCounts {
  inboxId: Id;
}

/** Counts for every inbox the caller may see, and for all of them together. */
export interface Counts {
  /** The sum of `inboxes`. */
  all: ThreadCounts;
  /** One per inbox the caller may see, in the inbox list's order. */
  inboxes: InboxCounts[];
  /** Rises whenever a count changes and may rise by more than one. Of two copies, keep the higher. */
  version: number;
}

export type DeviceKind = "person" | "agent";

/** Something that holds a token: one of the person's apps, or an agent. */
export interface Device {
  id: Id;
  name: string;
  kind: DeviceKind;
  /** Agents only: the inboxes this agent was given. It also needs each inbox's agentAccess. */
  inboxIds?: Id[];
  createdAt: IsoTime;
  lastSeenAt?: IsoTime;
}

export interface ServerInfo {
  name: "usual-mail";
  version: string;
  apiVersion: 1;
  /** Whether Gmail can be connected by signing in with Google here. A server that leaves it out can't. */
  googleSignIn: GoogleSignInInfo;
  /** Whether the owner has a password and whether the server can be claimed (docs/contract.md, "The owner's password"). */
  owner: OwnerInfo;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` for the next page. Absent on the last page. */
  nextCursor?: string;
}
