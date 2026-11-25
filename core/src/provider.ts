/**
 * What the server needs from a mail provider. `mail/` implements it for Gmail and for IMAP with SMTP.
 * A provider is a plain adapter: it holds no state of its own beyond a connection. The server owns the
 * store, the sync loop and every decision. Sync and write-back rules are in docs/contract-sync.md.
 */
import type { Address, FiledCategory, InboxConnection, ProviderKind, Stack } from "./domain.ts";

export interface ImapCredentials {
  imap: { host: string; port: number; secure: boolean; user: string; password: string };
  smtp: { host: string; port: number; secure: boolean; user: string; password: string };
  /**
   * The mailbox's address, when it differs from the login. `Inbox.connection` doesn't carry it: when changing
   * credentials, a client sends the inbox's own address here only when the IMAP login differs from it.
   */
  address?: string;
  /** Save a copy of sent mail to the Sent folder. Default true; turn off where the server does it itself. */
  saveSent?: boolean;
}

export interface GmailCredentials {
  /** The self-hoster's own Google OAuth client. */
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * A provider's own name for a message where it now sits. Opaque to the server. It is a location, not an
 * identity: moving a message can give it a new ref, which `apply` returns and `sync` reports.
 */
export type ProviderRef = string;

export interface ProviderAttachment {
  /** Opaque; passed back to `fetchAttachment`. */
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  /** For inline pictures: the Content-ID the HTML refers to, without angle brackets. */
  contentId?: string;
}

/**
 * Where a message sits at the provider, in Usual Mail's terms. While `trashed` or `spam` is true, only that counts:
 * the server treats a message in spam like a trashed one, and ignores new mail delivered to spam. So a message that
 * leaves spam is sent whole in `upserted`, never as `changed`, and arrives as new mail where it now sits.
 */
export interface ProviderPlacement {
  /** True while it is in the provider's inbox, so not archived. */
  inInbox: boolean;
  /**
   * The category whose label or folder holds it, or `null` for none (a conversation, or not yet decided). Left out
   * where the mailbox can't keep a category while the message is screened (IMAP, whose Screening folder is the
   * message's one folder): the server then keeps the category itself and doesn't read anything into it.
   */
  category?: FiledCategory | null;
  /** True while the provider's Screening label or folder holds it. */
  screened: boolean;
  /**
   * The stack it is on, or `null` for none. Left out when this mailbox can't keep stacks (an IMAP server
   * without custom keywords): the server then keeps the stack itself and doesn't read anything into it.
   */
  stack?: Stack | null;
  trashed: boolean;
  spam: boolean;
}

export interface ProviderMessage {
  ref: ProviderRef;
  /**
   * Messages with the same key are one conversation. Gmail supplies it; for IMAP it is derived from the
   * References and In-Reply-To headers.
   */
  threadKey: string;
  /** The Message-ID header, without angle brackets. */
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo?: Address[];
  /** ISO 8601, UTC. */
  date: string;
  subject: string;
  text?: string;
  /** Already sanitized: no scripts, no forms, no event handlers. Remote images are left as they are. */
  html?: string;
  attachments: ProviderAttachment[];
  seen: boolean;
  /**
   * True when the provider itself says the mailbox sent it: Gmail's SENT label, IMAP's Sent folder. Never because
   * From names the mailbox: anyone can write that, so it grants nothing (the decision of 2026-11-18).
   */
  outgoing: boolean;
  placement: ProviderPlacement;
  /** Headers the rules read. `listId` is the List-Id's id: the part in angle brackets, lower case. */
  listId?: string;
  listUnsubscribe?: string;
  /** True for bulk or machine-sent mail (Auto-Submitted, Precedence: bulk, a list header, no-reply). */
  automated: boolean;
  /**
   * What the mailbox provider's own checker proved about the From domain, read from the topmost Authentication-Results
   * header it stamped (docs/contract-avatars.md). Absent when the provider has no checker the server trusts (IMAP for
   * now) or wasn't asked (`ProviderOptions.authentication`).
   */
  fromCheck?: FromCheck;
  /**
   * The recipient fields (`to`, `cc`) the sender's own DKIM signature vouches for: each given once in the message, and
   * named in the `h=` of every aligned signature the provider's checker passed. Read only when `fromCheck` is verified.
   * A field given twice, or added after signing, isn't in it (docs/contract-ai.md, the screening gate).
   */
  signedRecipients?: Array<"to" | "cc">;
}

/**
 * The provider's own checker's word on a message's From domain. `verified`: an aligned DMARC pass for exactly the From
 * address's domain, or, with no DMARC result at all, a DKIM pass for its organisation; `domain` is that domain in ASCII.
 * `no_header`: no Authentication-Results at all. `other_checker`: the topmost one isn't the provider's own.
 * `repeated`: the provider's own checker wrote more than one (forwarded or imported mail), which proves nothing.
 * `unverified`: the provider's header proves nothing about the From domain (a failure, another domain, nothing that
 * passed, or a From or header that can't be read).
 */
export type FromCheck = { result: "verified"; domain: string } | { result: "no_header" | "other_checker" | "repeated" | "unverified" };

/** A message whose flags or placement changed and whose content did not. */
export interface ProviderChange {
  ref: ProviderRef;
  seen: boolean;
  placement: ProviderPlacement;
}

export interface SyncBatch {
  /** New messages, and messages the provider chose to send whole again. In any order. */
  upserted: ProviderMessage[];
  /**
   * Known messages whose flags or placement changed. A provider may send these as `upserted` instead. The server
   * ignores an entry for a ref it doesn't hold. A message that leaves spam never comes here: it is sent whole in
   * `upserted`, since the server ignored it while it was in spam and doesn't hold it.
   */
  changed?: ProviderChange[];
  /**
   * Refs that no longer hold a message. When a message moved, its new ref arrives in `upserted` or `changed`
   * in the same batch or an earlier one, never a later one.
   */
  removed: ProviderRef[];
  /**
   * True when the provider lost its place and is listing its whole window again from this batch on. The listing is
   * every ref in `upserted` and `changed` from this batch until a batch says `more: false`, in this call or a later
   * one. Then the server drops every message it holds that the listing didn't include. A provider that can still
   * say exactly which refs are gone (IMAP after a UIDVALIDITY change) may report them in `removed` instead.
   */
  reset?: boolean;
  /** Opaque; pass back to continue. */
  cursor: string;
  /** True when another call would return more straight away. */
  more: boolean;
  /**
   * On every batch of a first sync, from the call with a `null` cursor until the batch that sends the last of its
   * window: how far it has got once this batch is in. Counted from the cursor, so the count goes on across calls, a
   * restart and a smaller window. Absent on later batches, and from a provider that can't count (the server then
   * shows no count).
   */
  progress?: SyncProgress;
}

/**
 * How far a first sync has got, as the provider counts it: `sent` messages of its window sent so far, of `total` it
 * holds, sent and still to send. Messages, not conversations, as the window's listing has them (spam and trash too).
 * `total` is never below `sent`; it falls when a smaller window narrows the first sync, or when mail in the window
 * leaves the mailbox before it was sent.
 */
export interface SyncProgress {
  sent: number;
  total: number;
}

export interface SyncOptions {
  /** Bounds `upserted` and `changed` together; `removed` doesn't count. */
  limit?: number;
  /**
   * Called while a batch of a first sync is under way, whenever more of it is in (Gmail: once the window is listed,
   * then after each message, about one a second within its quota), with the count so far, this batch's messages
   * included. Interim: the batch's own `progress` is what its cursor stands for, so after a restart in the middle of
   * a batch the count goes back to it. A provider that fetches a batch quickly may never call it.
   */
  onProgress?: (progress: SyncProgress) => void;
}

/** A change to write back to the provider. */
export type ProviderOp =
  | { op: "seen"; ref: ProviderRef; seen: boolean }
  /**
   * Put a message where Usual Mail has it: in or out of the provider's inbox, under the label or folder for its
   * category (`null` for none), under the Screening label or folder while `screened`, with or without a stack
   * label. `inInbox` is true only with `category: null` and `screened: false`, and only for a conversation or
   * undecided thread that shows in Home (not done, on no stack, not waiting to come back); a notification shows in
   * Home but stays under its label or folder. A mailbox with one folder per message (IMAP) puts a
   * screened message in Screening and keeps no category for it.
   */
  | {
    op: "place";
    ref: ProviderRef;
    inInbox: boolean;
    category: FiledCategory | null;
    screened: boolean;
    stack?: Stack;
  }
  | { op: "trash"; ref: ProviderRef }
  /** Take a message out of the trash and put it where Usual Mail has it, as `place` would, with the same limits. */
  | {
    op: "untrash";
    ref: ProviderRef;
    inInbox: boolean;
    category: FiledCategory | null;
    screened: boolean;
    stack?: Stack;
  };

export interface ProviderOpResult {
  ok: boolean;
  /** The message's ref after the change. IMAP moves give a message a new one. */
  ref?: ProviderRef;
  /** Why it failed. Only when `ok` is false. */
  error?: string;
  /**
   * Something a person should know although it worked, for example "This server can't keep stacks". The server
   * puts it on the action record that caused the write-back (`ActionRecord.note`).
   */
  note?: string;
}

export interface OutgoingMessage {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  /** For replies. */
  inReplyTo?: string;
  references?: string[];
  /** For replies: the `threadKey` of the conversation, so the provider needn't search for it. */
  threadKey?: string;
}

export interface SendResult {
  /** The Message-ID it went out with, without angle brackets. */
  messageId: string;
  /**
   * Something a person should know although it was sent, for example that no copy was saved to Sent. The server
   * puts it on the draft (`Draft.note`).
   */
  note?: string;
}

/**
 * A search of the mailbox itself, for mail the server doesn't hold (docs/contract-search.md), as the server parsed
 * it. The provider translates it into its own query language; what it can't express it leaves out.
 */
export interface ProviderSearchQuery {
  /** Words the mail holds. */
  words: string[];
  /** Phrases the mail holds, word for word. */
  phrases: string[];
  /** Words the mail must not hold. */
  exclude: string[];
  from?: string;
  to?: string;
  /** Words the subject holds. */
  subject?: string;
  hasAttachment?: boolean;
  /** ISO 8601: mail at or after it. */
  after?: string;
  /** ISO 8601: mail before it. */
  before?: string;
  unread?: boolean;
  /** Under any of these categories' labels or folders. */
  categories?: FiledCategory[];
  /** Under the Screening label or folder. */
  screened?: boolean;
  /** Out of the provider's inbox (archived). */
  archived?: boolean;
}

/** One conversation the mailbox found, light: nothing of its bodies. */
export interface ProviderSearchHit {
  /** The conversation's key, as `ProviderMessage.threadKey` carries it, which `fetchThread` takes. */
  threadKey: string;
  subject: string;
  /** The sender of its newest message. */
  from: Address;
  /** Its newest message's time, ISO 8601 in UTC. */
  date: string;
  /** The provider's own preview, plain text. */
  snippet: string;
  hasAttachments: boolean;
  messageCount: number;
  /** True while any message of it is in the provider's inbox. */
  inInbox: boolean;
}

export interface ProviderSearchPage {
  /** Newest first. */
  hits: ProviderSearchHit[];
  /** Pass back as `page` for the next page. Absent on the last. */
  next?: string;
}

export interface MailProvider {
  readonly kind: ProviderKind;
  /**
   * The parts of its credentials that aren't secret, as `Inbox.connection` shows them: servers, ports, TLS and
   * logins for IMAP, the client id for Gmail. Never a password, secret or token. Answers at once, without the
   * network. The server stores it when it stores the credentials.
   */
  connection(): InboxConnection;
  /**
   * Checks the credentials and says which address this mailbox is. Throws with a readable message. The server
   * calls it before storing credentials, when connecting an inbox and when a person changes its credentials.
   */
  verify(): Promise<{ address: string }>;
  /**
   * Changes since `cursor`. `null` starts a first sync of the window the provider was created with (see
   * `ProviderOptions.since`); a provider may send that newest first. A provider created with a later `since` while
   * the first sync is still being sent takes nothing older than it from then on; an earlier one changes nothing.
   * Safe to call again with the same cursor.
   * A placement is reported exactly as `apply` last wrote it, or the server takes it for a change made
   * elsewhere. `limit` bounds `upserted` and `changed` together; `removed` doesn't count. A first sync says how far
   * it has got (`SyncBatch.progress`, `SyncOptions.onProgress`).
   */
  sync(cursor: string | null, options?: SyncOptions): Promise<SyncBatch>;
  fetchAttachment(ref: ProviderRef, attachmentId: string): Promise<Uint8Array>;
  /**
   * Applies each change. One failure doesn't stop the rest. Results are in the same order. The server stores each
   * new `ref` before its next `sync`, so a provider may report a message it moved itself under that ref in
   * `changed` instead of fetching it again, and should where it can.
   */
  apply(ops: ProviderOp[]): Promise<ProviderOpResult[]>;
  send(message: OutgoingMessage): Promise<SendResult>;
  /**
   * Optional: call `onChange` whenever the mailbox may have changed. Returns a function that stops it. The server
   * checks every inbox on a timer as well, since a watch may miss changes. IMAP watches INBOX with IDLE; Gmail has
   * none until its push notifications are built (see docs/contract-sync.md).
   */
  watch?(onChange: () => void): Promise<() => Promise<void>>;
  /**
   * Optional: the provider's own checker's word on the From domain of messages already synced (`fromCheck`), read
   * again from the provider, for mail stored before the server kept it. Only providers with a checker the server
   * trusts have it (Gmail: its metadata form, Authentication-Results and From only). A ref the provider no longer has
   * is left out of the answer.
   */
  fromChecks?(refs: readonly ProviderRef[]): Promise<Map<ProviderRef, FromCheck>>;
  /**
   * Optional: searches the mailbox itself, newest first, a page at a time (docs/contract-search.md), leaving out
   * spam and trash. Read-only: it changes nothing at the provider. Gmail has it (its own search operators); IMAP
   * doesn't yet, and an inbox without it answers `unsupported`. Throws with a readable message when the provider
   * refuses.
   */
  search?(query: ProviderSearchQuery, options: { page?: string; limit: number }): Promise<ProviderSearchPage>;
  /**
   * Optional, with `search`: every message of one conversation as `sync` would send it (refs, placement, flags,
   * `outgoing` on the provider's own evidence), oldest first, leaving out spam, trash, drafts and chats. Read-only.
   * Empty when the provider has no such conversation.
   */
  fetchThread?(threadKey: string): Promise<ProviderMessage[]>;
  /** Close connections. */
  close(): Promise<void>;
}

export interface ProviderOptions {
  /**
   * On first sync, only take mail newer than this. ISO 8601. The server gives the inbox's window as it is set when it
   * opens the provider, so after the window was made smaller it can be later than the one a first sync in progress
   * began with: the provider then sends nothing older than it from then on, and reports nothing it sent as removed (a
   * listing after it lost its place still covers the window the first sync began with). An earlier `since` never
   * widens a first sync: more mail for an inbox already connected would be a new first sync. Mail that arrives
   * later is taken whatever its date.
   */
  since?: string;
  /** Names for the labels or folders that hold categories, screening and stacks. Defaults under "Usual Mail/". */
  names?: Partial<Record<FiledCategory | "screening" | Stack, string>>;
  /**
   * When given, a provider whose own checker the server trusts says what it proved about each message's From domain
   * (`ProviderMessage.fromCheck`, `fromChecks`). The server gives it when it shows sender pictures.
   */
  authentication?: {
    /** A domain's organisational (registrable) domain in ASCII by the Public Suffix List, or null when it has none. */
    organisationalDomain(domain: string): string | null;
  };
}

export type ProviderFactory = (credentials: unknown, options?: ProviderOptions) => MailProvider;
