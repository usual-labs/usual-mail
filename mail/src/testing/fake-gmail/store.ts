/**
 * The mailbox behind the fake Gmail API: messages with label ids, threads, labels and the history log,
 * shaped after Gmail's documented resources. No network, no real account.
 *
 * Two behaviours aren't documented by Google (checked 2026-11-16: the reference pages for messages.trash,
 * messages.untrash, sending and threads don't say). The fake takes the case that is harder for a client:
 * untrashing restores no label (trashing removes INBOX by default, `trashRemovesInbox`), and sending
 * replaces the Message-ID with one of Gmail's own, as developers report it sometimes does.
 */
import { randomBytes } from "node:crypto";
import PostalMime from "postal-mime";

export interface FakeLabel {
  id: string;
  name: string;
  type: "system" | "user";
  messageListVisibility?: string;
  labelListVisibility?: string;
}

export interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: Set<string>;
  raw: Buffer;
  internalDate: number;
  historyId: bigint;
  messageId?: string;
  references: string[];
  /** What the fake's search reads (search.ts): read once from the raw message. */
  parsed: FakeParsed;
}

/** A message as the fake's search reads it: lower case, the bodies as text. */
export interface FakeParsed {
  subject: string;
  from: string;
  to: string;
  text: string;
  hasAttachment: boolean;
  /** The top-level Content-Type, as the metadata form's `payload.mimeType` gives it. */
  mimeType: string;
  /** The start of the text as written, for Gmail's snippet. */
  preview: string;
}

export type HistoryKind = "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved";

export interface FakeHistoryRecord {
  id: bigint;
  kind: HistoryKind;
  messageId: string;
  threadId: string;
  labelIds: string[];
  /** For label changes: the labels added or removed. */
  changed?: string[];
}

export const SYSTEM_LABELS = [
  "INBOX", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "CHAT",
  "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
];

export class FakeMailbox {
  readonly address: string;
  readonly now: () => number;
  readonly messages = new Map<string, FakeMessage>();
  readonly labels = new Map<string, FakeLabel>();
  readonly history: FakeHistoryRecord[] = [];
  historyId = 1000n;
  /** History ids below this are gone: history.list answers 404 for them. */
  minHistoryId = 0n;
  /** Whether trashing takes INBOX off. Untrashing never puts a label back. */
  trashRemovesInbox = true;
  #nextLabel = 1;
  #seed = BigInt(`0x${randomBytes(6).toString("hex")}`) << 16n;
  #nextId = 1n;

  constructor(address: string, now: () => number) {
    this.address = address.toLowerCase();
    this.now = now;
    for (const id of SYSTEM_LABELS) this.labels.set(id, { id, name: id, type: "system" });
  }

  #newId(): string {
    return (this.#seed + this.#nextId++).toString(16).padStart(16, "0");
  }

  #record(kind: HistoryKind, message: FakeMessage, changed?: string[]): void {
    this.historyId += BigInt(1 + Math.floor(Math.random() * 3));
    message.historyId = this.historyId;
    const record: FakeHistoryRecord = { id: this.historyId, kind, messageId: message.id, threadId: message.threadId, labelIds: [...message.labelIds] };
    if (changed) record.changed = changed;
    this.history.push(record);
  }

  async insert(raw: Buffer, labelIds: string[], options: { internalDate?: number; threadId?: string } = {}): Promise<FakeMessage> {
    const headers = await PostalMime.parse(raw);
    const messageId = bare(headers.messageId);
    const references = [...ids(headers.references), ...ids(headers.inReplyTo)];
    const threadId = options.threadId ?? this.#threadFor(references) ?? this.#newId();
    const message: FakeMessage = {
      id: this.#newId(),
      threadId,
      labelIds: new Set(labelIds),
      raw,
      internalDate: options.internalDate ?? this.now(),
      historyId: this.historyId,
      references,
      parsed: parsedOf(headers, raw),
    };
    if (messageId) message.messageId = messageId;
    this.messages.set(message.id, message);
    this.#record("messageAdded", message);
    return message;
  }

  /** Gmail threads incoming mail by References and In-Reply-To (and subject, which the fake ignores). */
  #threadFor(references: string[]): string | undefined {
    for (const message of this.messages.values()) {
      if (message.messageId && references.includes(message.messageId)) return message.threadId;
    }
    return undefined;
  }

  threadHasAny(threadId: string, references: string[]): boolean {
    for (const message of this.messages.values()) {
      if (message.threadId === threadId && message.messageId && references.includes(message.messageId)) return true;
    }
    return false;
  }

  modify(message: FakeMessage, add: string[], remove: string[]): void {
    const added = add.filter((id) => !message.labelIds.has(id));
    const removed = remove.filter((id) => message.labelIds.has(id));
    for (const id of added) message.labelIds.add(id);
    for (const id of removed) message.labelIds.delete(id);
    if (added.length) this.#record("labelAdded", message, added);
    if (removed.length) this.#record("labelRemoved", message, removed);
  }

  trash(message: FakeMessage): void {
    if (message.labelIds.has("TRASH")) return;
    this.modify(message, ["TRASH"], this.trashRemovesInbox ? ["INBOX"] : []);
  }

  untrash(message: FakeMessage): void {
    if (!message.labelIds.has("TRASH")) return;
    this.modify(message, [], ["TRASH"]);
  }

  delete(id: string): boolean {
    const message = this.messages.get(id);
    if (!message) return false;
    this.messages.delete(id);
    this.#record("messageDeleted", message);
    return true;
  }

  createLabel(name: string, visibility: { messageListVisibility?: string; labelListVisibility?: string }): FakeLabel | undefined {
    for (const label of this.labels.values()) if (label.name.toLowerCase() === name.toLowerCase()) return undefined;
    const label: FakeLabel = { id: `Label_${this.#nextLabel++}`, name, type: "user", ...visibility };
    this.labels.set(label.id, label);
    return label;
  }

  findByMessageId(messageId: string): FakeMessage | undefined {
    for (const message of this.messages.values()) if (message.messageId === messageId) return message;
    return undefined;
  }
}

function parsedOf(email: Awaited<ReturnType<typeof PostalMime.parse>>, raw: Buffer): FakeParsed {
  const people = (list: Array<{ name?: string; address?: string }> | undefined) =>
    (list ?? []).map((a) => `${a.name ?? ""} <${a.address ?? ""}>`).join(", ").toLowerCase();
  const html = (email.html ?? "").replace(/<[^>]*>/g, " ");
  const type = /^content-type:\s*([^;\r\n]+)/im.exec(raw.toString("latin1").split(/\r?\n\r?\n/)[0] ?? "")?.[1]?.trim().toLowerCase();
  return {
    subject: (email.subject ?? "").toLowerCase(),
    from: people(email.from ? [email.from as { name?: string; address?: string }] : []),
    to: people([...(email.to ?? []), ...(email.cc ?? [])] as Array<{ name?: string; address?: string }>),
    text: `${email.text ?? ""} ${html}`.replace(/\s+/g, " ").toLowerCase(),
    hasAttachment: (email.attachments ?? []).some((a) => a.disposition !== "inline"),
    mimeType: type ?? "text/plain",
    preview: `${email.text ?? ""} ${html}`.replace(/\s+/g, " ").trim().slice(0, 100),
  };
}

function bare(value: string | undefined): string | undefined {
  const id = value?.trim().replace(/^<+|>+$/g, "");
  return id || undefined;
}

function ids(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!).filter(Boolean);
}
