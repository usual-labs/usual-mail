// An in-memory mailbox that implements `MailProvider` the way a real one behaves: a change log behind the
// sync cursor, placement and seen flags, trash, sending, optional watching, and optionally IMAP-style renames
// when a message moves, flag-only changes, a mailbox without stacks, and losing its place. Tests and demo
// mode use it; nothing here touches the network.

import type {
  Address,
  FromCheck,
  InboxConnection,
  MailProvider,
  OutgoingMessage,
  ProviderAttachment,
  ProviderChange,
  ProviderKind,
  ProviderMessage,
  ProviderOp,
  ProviderOpResult,
  ProviderOptions,
  ProviderPlacement,
  ProviderSearchQuery,
  SendResult,
  SyncBatch,
  SyncOptions,
} from "@usualmail/core";
import { SIGN_IN_REFUSED } from "@usualmail/core";
import { memorySearch, memoryThread } from "./memory-search.ts";

export interface MemoryMailboxOptions {
  address: string;
  kind?: ProviderKind;
  /** Offer `watch`, which calls back after every change. */
  watch?: boolean;
  /** Give a message a new ref whenever it changes folder, as IMAP does. */
  renameOnMove?: boolean;
  /**
   * Report flag and placement changes in `changed` instead of sending the message again. A message this mailbox
   * renamed in `apply` is reported in `changed` under its new ref too, since the server stores that ref.
   */
  sendChanges?: boolean;
  /** False for a mailbox that can't keep stacks (IMAP without keywords): no stack is reported or kept. Default true. */
  keepsStacks?: boolean;
  /**
   * Whether a screened message still reports its category: true for labels (Gmail), false where a message has one
   * folder (IMAP's Screening folder keeps none). Default: false for "imap", true for "gmail".
   */
  categoryWhileScreened?: boolean;
  /** What `connection()` reports. Default: made-up servers named after the address, or a made-up Gmail client. */
  connection?: InboxConnection;
  now?: () => number;
}

/** What `deliver` needs; everything else has a sensible default. */
export type DeliverInput = Partial<Omit<ProviderMessage, "placement" | "attachments">> & {
  from: Address;
  subject: string;
  placement?: Partial<ProviderPlacement>;
  attachments?: Array<ProviderAttachment & { data?: Uint8Array }>;
};

interface Entry {
  message: ProviderMessage;
  /** When anything about it last changed. */
  seq: number;
  /** When it arrived or got a new ref: until then a sync sends it whole, after that only as a change. */
  contentSeq: number;
  files: Map<string, Uint8Array>;
}

export const NO_STACKS_NOTE = "This mailbox can't keep stacks, so the stack only shows in Usual Mail";

export class MemoryMailbox {
  readonly address: string;
  readonly kind: ProviderKind;
  readonly options: MemoryMailboxOptions;
  /** Everything `send` was given, oldest first. */
  readonly sent: OutgoingMessage[] = [];
  /** Every op `apply` was given, oldest first. */
  readonly applied: ProviderOp[] = [];
  /** The refs each `fromChecks` call asked about, oldest first. */
  readonly fromCheckReads: string[][] = [];
  /** Every search the mailbox was asked, oldest first. */
  readonly searches: ProviderSearchQuery[] = [];
  /**
   * Set to act like a failing mailbox: sync, verify, apply and send all fail with this, as a failure that may pass (no
   * connection, say), or as a refused login with `signInRefused`.
   */
  failSync: string | null = null;
  /** With `failSync`, the mailbox refuses the login: its error is core's `SIGN_IN_REFUSED`. */
  signInRefused = false;
  /** Return an error message to refuse an op. */
  refuse: ((op: ProviderOp) => string | undefined) | null = null;
  failSend: string | null = null;
  /** A note `send` adds to its result, as a provider does when no copy was saved to Sent. */
  sendNote: string | null = null;

  #seq = 0;
  #next = 0;
  #entries = new Map<string, Entry>();
  #removed: Array<{ ref: string; seq: number }> = [];
  #watchers = new Set<() => void>();
  #resetPending = false;

  constructor(options: MemoryMailboxOptions) {
    this.options = options;
    this.address = options.address.toLowerCase();
    this.kind = options.kind ?? "imap";
  }

  /** A provider over this mailbox, as `ProviderFactory` would return. `connection` overrides what it reports. */
  provider(providerOptions: ProviderOptions = {}, connection?: InboxConnection): MemoryProvider {
    return new MemoryProvider(this, providerOptions, connection);
  }

  get keepsStacks(): boolean {
    return this.options.keepsStacks !== false;
  }

  get categoryWhileScreened(): boolean {
    return this.options.categoryWhileScreened ?? this.kind !== "imap";
  }

  /** How this mailbox says it is connected, without secrets. */
  get connection(): InboxConnection {
    if (this.options.connection) return structuredClone(this.options.connection);
    if (this.kind === "gmail") return { kind: "gmail", clientId: "memory-client.apps.example" };
    const login = (host: string, port: number) => ({ host, port, secure: true, user: this.address });
    return { kind: "imap", imap: login("imap.memory.example", 993), smtp: login("smtp.memory.example", 465), saveSent: true };
  }

  get cursor(): string {
    return String(this.#seq);
  }

  messages(): ProviderMessage[] {
    return [...this.#entries.values()].map((entry) => structuredClone(entry.message));
  }

  /** Every message as a sync reports it (search and `fetchThread` read these). */
  reported(): ProviderMessage[] {
    return [...this.#entries.values()].map((entry) => this.#report(entry.message));
  }

  get(ref: string): ProviderMessage | undefined {
    const entry = this.#entries.get(ref);
    return entry && structuredClone(entry.message);
  }

  /** Adds a message, as if it had just arrived. Returns it. */
  deliver(input: DeliverInput): ProviderMessage {
    const messageId = input.messageId ?? `${this.#id("m")}@memory.example`;
    // Like the real providers: mail is the mailbox's own only when it was sent (in Sent), never by its From.
    const outgoing = input.outgoing ?? false;
    const message: ProviderMessage = {
      ref: input.ref ?? this.#id("ref"),
      threadKey: input.threadKey ?? this.#threadKeyFor(input.inReplyTo, input.references ?? []) ?? this.#id("key"),
      messageId,
      references: input.references ?? (input.inReplyTo ? [input.inReplyTo] : []),
      from: input.from,
      to: input.to ?? [{ email: this.address }],
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      date: input.date ?? new Date(this.#now()).toISOString(),
      subject: input.subject,
      attachments: (input.attachments ?? []).map(({ data: _data, ...meta }) => meta),
      seen: input.seen ?? outgoing,
      outgoing,
      placement: {
        inInbox: !outgoing,
        category: null,
        screened: false,
        trashed: false,
        spam: false,
        ...(this.keepsStacks && { stack: null }),
        ...input.placement,
      },
      automated: input.automated ?? false,
    };
    for (const key of ["inReplyTo", "replyTo", "text", "html", "listId", "listUnsubscribe", "fromCheck"] as const) {
      if (input[key] !== undefined) (message as unknown as Record<string, unknown>)[key] = input[key];
    }
    const files = new Map<string, Uint8Array>();
    for (const file of input.attachments ?? []) files.set(file.id, file.data ?? new Uint8Array());
    const seq = ++this.#seq;
    this.#entries.set(message.ref, { message, seq, contentSeq: seq, files });
    this.#changed();
    return structuredClone(message);
  }

  /**
   * A change made in the provider's own app: archive, label, read, trash, spam. A message taken out of spam is sent
   * whole again, never as a change, since the server ignored it while it was there.
   */
  update(ref: string, change: { placement?: Partial<ProviderPlacement>; seen?: boolean }): void {
    const entry = this.#entries.get(ref);
    if (!entry) throw new Error(`No message ${ref}`);
    const wasSpam = entry.message.placement.spam;
    if (change.placement) entry.message.placement = { ...entry.message.placement, ...change.placement };
    if (change.seen !== undefined) entry.message.seen = change.seen;
    entry.seq = ++this.#seq;
    if (wasSpam && !entry.message.placement.spam) entry.contentSeq = entry.seq;
    this.#changed();
  }

  /** Deletes a message for good. */
  remove(ref: string): void {
    if (!this.#entries.delete(ref)) throw new Error(`No message ${ref}`);
    this.#removed.push({ ref, seq: ++this.#seq });
    this.#changed();
  }

  /** Deletes a message without a trace, as when a provider's change history runs out. Only a reset finds it. */
  forget(ref: string): void {
    if (!this.#entries.delete(ref)) throw new Error(`No message ${ref}`);
  }

  /** The next sync, whatever its cursor, lists the whole window again and says so with `reset`. */
  loseCursor(): void {
    this.#resetPending = true;
    this.#changed();
  }

  /**
   * Changes after `cursor`. A first sync (no cursor) and a reset list the window, newer than `since`, with no
   * removals; their later pages carry an "F" (first sync) or "L" (reset) cursor so they keep listing. A first sync's
   * batches say how far it has got, as the real providers do: what of the window it has sent, of all it holds now.
   */
  /** The error `failSync` makes, or null while it is unset. */
  failure(): Error | null {
    if (!this.failSync) return null;
    const error = new Error(this.failSync);
    if (this.signInRefused) error.name = SIGN_IN_REFUSED;
    return error;
  }

  sync(cursor: string | null, since: number | null, limit = 100): SyncBatch {
    const failure = this.failure();
    if (failure) throw failure;
    const first = cursor === null || cursor.startsWith("F");
    let listing = first || cursor.startsWith("L");
    let after = cursor === null ? 0 : Number(cursor.replace(/^[FL]/, ""));
    if (!Number.isInteger(after) || after < 0) throw new Error(`Bad cursor ${cursor}`);
    let reset = false;
    if (cursor !== null && this.#resetPending) {
      this.#resetPending = false;
      listing = true;
      reset = true;
      after = 0;
    }
    type Item = { seq: number; upsert?: ProviderMessage; change?: ProviderChange; removed?: string };
    const items: Item[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.seq <= after) continue;
      if (listing && since !== null && Date.parse(entry.message.date) < since) continue;
      const message = this.#report(entry.message);
      if (listing || !this.options.sendChanges || entry.contentSeq > after) items.push({ seq: entry.seq, upsert: message });
      else items.push({ seq: entry.seq, change: { ref: message.ref, seen: message.seen, placement: message.placement } });
    }
    if (!listing) for (const gone of this.#removed) if (gone.seq > after) items.push({ seq: gone.seq, removed: gone.ref });
    items.sort((a, b) => a.seq - b.seq);
    const taken = items.slice(0, Math.max(1, limit));
    const more = items.length > taken.length;
    const changed = taken.flatMap((item) => (item.change ? [item.change] : []));
    const batch: SyncBatch = {
      upserted: taken.flatMap((item) => (item.upsert ? [item.upsert] : [])),
      removed: taken.flatMap((item) => (item.removed ? [item.removed] : [])),
      cursor: more ? `${listing ? (first && !reset ? "F" : "L") : ""}${taken.at(-1)!.seq}` : String(this.#seq),
      more,
    };
    if (changed.length) batch.changed = changed;
    if (reset) batch.reset = true;
    if (first && !reset) {
      const window = [...this.#entries.values()].filter((entry) => since === null || Date.parse(entry.message.date) >= since);
      const left = items.length - taken.length;
      batch.progress = { sent: window.length - left, total: window.length };
    }
    return batch;
  }

  apply(ops: ProviderOp[]): ProviderOpResult[] {
    const results = ops.map((op) => this.#applyOne(op));
    if (results.some((r) => r.ok)) this.#changed();
    return results;
  }

  #applyOne(op: ProviderOp): ProviderOpResult {
    this.applied.push(structuredClone(op));
    const refusal = this.failSync ?? this.refuse?.(op);
    if (refusal) return { ok: false, error: refusal };
    const entry = this.#entries.get(op.ref);
    if (!entry) return { ok: false, error: `No message ${op.ref}` };
    if ((op.op === "place" || op.op === "untrash") && op.inInbox && (op.category !== null || op.screened)) {
      return { ok: false, error: "A message can be in the inbox only without a category's label and without Screening" };
    }
    const before = folderOf(entry.message.placement);
    const placement = entry.message.placement;
    let note: string | undefined;
    switch (op.op) {
      case "seen":
        entry.message.seen = op.seen;
        break;
      case "place":
      case "untrash":
        entry.message.placement = {
          inInbox: op.inInbox,
          category: op.category,
          screened: op.screened,
          trashed: op.op === "place" && placement.trashed,
          spam: placement.spam,
        };
        if (this.keepsStacks) entry.message.placement.stack = op.stack ?? null;
        else if (op.stack) note = NO_STACKS_NOTE;
        break;
      case "trash":
        placement.trashed = true;
        break;
    }
    entry.seq = ++this.#seq;
    let ref = op.ref;
    if (this.options.renameOnMove && folderOf(entry.message.placement) !== before) {
      // The new ref comes before the old one's removal, as the contract asks of a provider.
      ref = this.#id("ref");
      this.#entries.delete(op.ref);
      entry.message.ref = ref;
      this.#entries.set(ref, entry);
      this.#removed.push({ ref: op.ref, seq: ++this.#seq });
    }
    return note ? { ok: true, ref, note } : { ok: true, ref };
  }

  send(message: OutgoingMessage): SendResult {
    const failure = this.failSync ?? this.failSend;
    if (failure) throw new Error(failure);
    this.sent.push(structuredClone(message));
    const sent = this.deliver({
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      text: message.text,
      ...(message.inReplyTo !== undefined && { inReplyTo: message.inReplyTo }),
      ...(message.references !== undefined && { references: message.references }),
      ...(message.threadKey !== undefined && { threadKey: message.threadKey }),
      outgoing: true,
      seen: true,
      placement: { inInbox: false },
    });
    return this.sendNote ? { messageId: sent.messageId!, note: this.sendNote } : { messageId: sent.messageId! };
  }

  fetchAttachment(ref: string, attachmentId: string): Uint8Array {
    const data = this.#entries.get(ref)?.files.get(attachmentId);
    if (!data) throw new Error(`No attachment ${attachmentId} on ${ref}`);
    return data;
  }

  watch(onChange: () => void): () => void {
    this.#watchers.add(onChange);
    return () => void this.#watchers.delete(onChange);
  }

  /**
   * A message as `sync` reports it: without a stack when the mailbox can't keep stacks, and without a category while
   * screened where a message has one folder.
   */
  #report(message: ProviderMessage): ProviderMessage {
    const out = structuredClone(message);
    if (!this.keepsStacks) delete out.placement.stack;
    if (out.placement.screened && !this.categoryWhileScreened) delete out.placement.category;
    return out;
  }

  #changed(): void {
    for (const watcher of [...this.#watchers]) queueMicrotask(watcher);
  }

  #threadKeyFor(inReplyTo: string | undefined, references: string[]): string | undefined {
    const ids = [inReplyTo, ...references].filter((id): id is string => Boolean(id));
    for (const entry of this.#entries.values()) {
      if (entry.message.messageId && ids.includes(entry.message.messageId)) return entry.message.threadKey;
    }
    return undefined;
  }

  #id(prefix: string): string {
    return `${prefix}-${++this.#next}`;
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** Where a message sits as an IMAP folder would see it. */
function folderOf(placement: ProviderPlacement): string {
  if (placement.trashed) return "trash";
  if (placement.inInbox) return "inbox";
  if (placement.screened) return "screening";
  return placement.category ?? "archive";
}

/** A `MailProvider` over a `MemoryMailbox`. */
export class MemoryProvider implements MailProvider {
  readonly kind: ProviderKind;
  readonly mailbox: MemoryMailbox;
  readonly #since: number | null;
  readonly #connection: InboxConnection | undefined;
  /** Whether the server asked for what the provider's checker proved: then delivered `fromCheck`s are reported. */
  readonly #authentication: boolean;
  closed = false;
  watch?: (onChange: () => void) => Promise<() => Promise<void>>;
  /** Like Gmail's: a memory "gmail" mailbox asked for authentication reads delivered `fromCheck`s again. */
  fromChecks?: (refs: readonly string[]) => Promise<Map<string, FromCheck>>;
  /** Like Gmail's: a memory "gmail" mailbox searches itself (memory-search.ts); an "imap" one can't. */
  search?: MailProvider["search"];
  fetchThread?: MailProvider["fetchThread"];

  constructor(mailbox: MemoryMailbox, options: ProviderOptions = {}, connection?: InboxConnection) {
    this.mailbox = mailbox;
    this.kind = mailbox.kind;
    this.#since = options.since ? Date.parse(options.since) : null;
    this.#connection = connection;
    this.#authentication = options.authentication !== undefined;
    if (this.#authentication && mailbox.kind === "gmail") {
      this.fromChecks = async (refs) => {
        mailbox.fromCheckReads.push([...refs]);
        const out = new Map<string, FromCheck>();
        for (const ref of refs) {
          const message = mailbox.get(ref);
          if (message) out.set(ref, message.fromCheck ?? { result: "no_header" });
        }
        return out;
      };
    }
    if (mailbox.kind === "gmail") {
      this.search = async (query, options) => {
        const failure = mailbox.failure();
        if (failure) throw failure;
        mailbox.searches.push(structuredClone(query));
        return memorySearch(mailbox.reported(), query, options);
      };
      this.fetchThread = async (threadKey) => {
        const failure = mailbox.failure();
        if (failure) throw failure;
        return memoryThread(mailbox.reported(), threadKey);
      };
    }
    if (mailbox.options.watch) {
      this.watch = async (onChange) => {
        const stop = mailbox.watch(onChange);
        return async () => stop();
      };
    }
  }

  connection(): InboxConnection {
    return structuredClone(this.#connection ?? this.mailbox.connection);
  }

  async verify(): Promise<{ address: string }> {
    const failure = this.mailbox.failure();
    if (failure) throw failure;
    return { address: this.mailbox.address };
  }

  async sync(cursor: string | null, options?: SyncOptions): Promise<SyncBatch> {
    const batch = await this.mailbox.sync(cursor, this.#since, options?.limit);
    // A checker's word only when the server asked for it, as the real providers do.
    if (!this.#authentication) for (const message of batch.upserted) delete message.fromCheck;
    return batch;
  }

  async fetchAttachment(ref: string, attachmentId: string): Promise<Uint8Array> {
    return this.mailbox.fetchAttachment(ref, attachmentId);
  }

  async apply(ops: ProviderOp[]): Promise<ProviderOpResult[]> {
    return this.mailbox.apply(ops);
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    return this.mailbox.send(message);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * A factory for `ProviderRegistry.register`. Credentials are `{ "mailbox": "<address>" }`, optionally with the
 * `connection` the provider should report (and anything else, such as a password, which it ignores); an address
 * it hasn't seen gets a new, empty mailbox.
 */
export function memoryFactory(mailboxes: Map<string, MemoryMailbox>, defaults: Omit<MemoryMailboxOptions, "address"> = {}) {
  return (credentials: unknown, options?: ProviderOptions): MemoryProvider => {
    const connection = (credentials as { connection?: InboxConnection } | null)?.connection;
    const address = (credentials as { mailbox?: unknown } | null)?.mailbox;
    if (typeof address !== "string" || !address.includes("@")) throw new Error('Memory credentials are { "mailbox": "<address>" }');
    let mailbox = mailboxes.get(address.toLowerCase());
    if (!mailbox) {
      mailbox = new MemoryMailbox({ ...defaults, address });
      mailboxes.set(mailbox.address, mailbox);
    }
    return mailbox.provider(options, connection);
  };
}
