/**
 * Turns a raw RFC 5322 message into the parts of a ProviderMessage that come from the message itself.
 * Both providers use it: IMAP fetches the source, Gmail fetches the raw form. Placement, seen state and
 * the ref come from the provider.
 */
import PostalMime from "postal-mime";
import type { Address, ProviderAttachment, ProviderMessage } from "@usualmail/core";
import { fromCheckOf, type AuthenticationOptions } from "./auth-results.ts";
import { firstHeader, headerMap, isAutomated, listIdOf, messageIds, stripBrackets } from "./headers.ts";
import { htmlToText } from "./html-to-text.ts";
import { sanitizeHtml } from "./sanitize.ts";
import { signedRecipients } from "./signed-recipients.ts";
import { threadKeyFor } from "./thread.ts";

export type ParsedMessage = Omit<ProviderMessage, "ref" | "seen" | "placement" | "outgoing" | "threadKey"> & {
  /** Derived from References and In-Reply-To; Gmail replaces it with its own thread id. */
  threadKey: string;
  /** True when the From address is one of the mailbox's own. */
  fromSelf: boolean;
};

export interface ParseContext {
  /** The mailbox's own addresses, lower case. */
  ownAddresses: readonly string[];
  /** When the provider received it (IMAP INTERNALDATE, Gmail internalDate). Used when Date is missing or odd. */
  receivedAt?: Date;
  /**
   * The provider's own checker and the organisational-domain rule, when the server wants to know what that checker
   * proved about the From domain (`fromCheck`). Only a provider whose checker the server trusts gives it.
   */
  authentication?: AuthenticationOptions;
}

/** Header dates more than this far after the time of receipt are treated as wrong. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

const PARSER_OPTIONS = { attachmentEncoding: "arraybuffer" } as const;

/**
 * For a message rebuilt without some parts' bytes (Gmail's full form, gmail/payload.ts): the real size of an
 * attachment whose bytes were left out, read from what stands in for them; undefined for real bytes.
 */
export type LeftOutSize = (content: Uint8Array) => number | undefined;

export async function parseMessage(raw: Uint8Array | string, context: ParseContext, leftOut?: LeftOutSize): Promise<ParsedMessage> {
  const email = await PostalMime.parse(raw, PARSER_OPTIONS);
  const headers = headerMap(email.headers);
  const from = firstMailbox(email.from) ?? firstMailbox(email.sender) ?? { email: "" };
  const messageId = email.messageId ? stripBrackets(email.messageId) || undefined : undefined;
  const inReplyTo = messageIds(email.inReplyTo)[0];
  const references = messageIds(email.references);
  // U+0000 means nothing in mail, and SQLite takes it for the end of a text (libSQL reads a text back only up to it):
  // taken out of everything stored as text, so nothing after it is lost.
  const html = email.html === undefined ? undefined : sanitizeHtml(withoutNul(email.html));
  const text = withoutNul(email.text ?? (email.html ? htmlToText(email.html) : undefined));
  const own = new Set(context.ownAddresses.map((address) => address.toLowerCase()));
  const replyTo = addresses(email.replyTo);

  const message: ParsedMessage = {
    threadKey: threadKeyFor({ messageId, inReplyTo, references }, headerSeed(email.headers)),
    messageId,
    inReplyTo,
    references,
    from,
    to: addresses(email.to),
    cc: addresses(email.cc),
    bcc: addresses(email.bcc),
    date: messageDate(email.date, context.receivedAt),
    subject: withoutNul(email.subject ?? "").replace(/[\r\n]+/g, " ").trim(),
    attachments: email.attachments.map((attachment, index) => toAttachment(attachment, index, leftOut)),
    automated: isAutomated(headers, from.email),
    fromSelf: own.has(from.email),
  };
  if (replyTo.length) message.replyTo = replyTo;
  if (text !== undefined && text.trim()) message.text = text.trimEnd();
  if (html !== undefined) message.html = html;
  const listId = listIdOf(firstHeader(headers, "list-id"));
  if (listId) message.listId = listId;
  const listUnsubscribe = firstHeader(headers, "list-unsubscribe");
  if (listUnsubscribe) message.listUnsubscribe = listUnsubscribe;
  // The message's own headers only, top first: never those of a message attached to it.
  if (context.authentication) {
    message.fromCheck = fromCheckOf(email.headers, from.email, context.authentication);
    // Which of To and Cc the sender's own signature vouches for: only once the From domain is proved.
    if (message.fromCheck.result === "verified") message.signedRecipients = signedRecipients(email.headers, message.fromCheck.domain, context.authentication);
  }
  return message;
}

/** The text without U+0000. */
function withoutNul<T extends string | undefined>(text: T): T {
  return (text === undefined || !text.includes("\u0000") ? text : text.replaceAll("\u0000", "")) as T;
}

/** Like parseMessage, but a message the parser refuses (too many parts, say) becomes a short note instead. */
export async function parseOrNote(raw: Uint8Array | string, context: ParseContext, seed: string, leftOut?: LeftOutSize): Promise<ParsedMessage> {
  try {
    return await parseMessage(raw, context, leftOut);
  } catch (error) {
    return unreadable(error, context, seed);
  }
}

/** The short note that stands for a message that couldn't be read. */
export function unreadable(error: unknown, context: ParseContext, seed: string): ParsedMessage {
  return {
    threadKey: `unreadable:${seed}`,
    references: [],
    from: { email: "" },
    to: [],
    cc: [],
    bcc: [],
    date: (context.receivedAt ?? new Date(0)).toISOString(),
    subject: "(This message couldn't be read)",
    text: `Usual Mail couldn't read this message: ${(error as Error)?.message ?? String(error)}`,
    attachments: [],
    automated: false,
    fromSelf: false,
  };
}

/** The bytes of one attachment, by the id parseMessage gave it. */
export async function attachmentContent(raw: Uint8Array | string, attachmentId: string): Promise<Uint8Array | undefined> {
  const index = attachmentIndex(attachmentId);
  if (index === undefined) return undefined;
  return (await attachmentBytes(raw))[index];
}

/** Every attachment's bytes, in the order parseMessage numbers them (its `id`). */
export async function attachmentBytes(raw: Uint8Array | string): Promise<Uint8Array[]> {
  const email = await PostalMime.parse(raw, PARSER_OPTIONS);
  return email.attachments.map((attachment) => contentBytes(attachment.content));
}

export function attachmentIndex(id: string): number | undefined {
  if (!/^\d{1,5}$/.test(id)) return undefined;
  return Number(id);
}

type PostalAddress = NonNullable<Awaited<ReturnType<typeof PostalMime.parse>>["from"]>;
type PostalAttachment = Awaited<ReturnType<typeof PostalMime.parse>>["attachments"][number];

function flatten(list: readonly PostalAddress[] | PostalAddress | undefined): Address[] {
  if (!list) return [];
  const items = Array.isArray(list) ? list : [list];
  const out: Address[] = [];
  for (const item of items as PostalAddress[]) {
    const members = item.group ? item.group : [item];
    for (const member of members) {
      const email = (member.address ?? "").trim().toLowerCase();
      if (!email) continue;
      const name = member.name.replace(/\s+/g, " ").trim();
      out.push(name && name.toLowerCase() !== email ? { name, email } : { email });
    }
  }
  return out;
}

function addresses(list: readonly PostalAddress[] | undefined): Address[] {
  return flatten(list);
}

function firstMailbox(address: PostalAddress | undefined): Address | undefined {
  return flatten(address)[0];
}

function messageDate(header: string | undefined, receivedAt: Date | undefined): string {
  const received = receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : undefined;
  const parsed = header ? new Date(header) : undefined;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    if (!received || parsed.getTime() - received.getTime() <= FUTURE_SLACK_MS) return parsed.toISOString();
  }
  return (received ?? new Date(0)).toISOString();
}

function toAttachment(attachment: PostalAttachment, index: number, leftOut: LeftOutSize | undefined): ProviderAttachment {
  const mimeType = (attachment.mimeType || "application/octet-stream").split(";")[0]!.trim().toLowerCase();
  const contentId = attachment.contentId ? stripBrackets(attachment.contentId) || undefined : undefined;
  const isImage = mimeType.startsWith("image/");
  const inline = Boolean(isImage && contentId && (attachment.related || attachment.disposition !== "attachment"));
  const out: ProviderAttachment = {
    id: String(index),
    filename: cleanFilename(attachment.filename) ?? defaultFilename(mimeType, index),
    mimeType,
    size: sizeOf(contentBytes(attachment.content), leftOut),
    inline,
  };
  if (contentId) out.contentId = contentId;
  return out;
}

function sizeOf(bytes: Uint8Array, leftOut: LeftOutSize | undefined): number {
  return leftOut?.(bytes) ?? bytes.byteLength;
}

function contentBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/** Drops path parts and control or direction characters a sender could use to mislead. */
function cleanFilename(name: string | null): string | undefined {
  if (!name) return undefined;
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "").trim();
  return clean || undefined;
}

const EXTENSIONS: Record<string, string> = {
  "text/calendar": "invite.ics",
  "application/ics": "invite.ics",
  "message/rfc822": "message.eml",
  "message/delivery-status": "delivery-status.txt",
  "message/disposition-notification": "receipt.txt",
  "text/plain": "text.txt",
  "text/html": "page.html",
  "application/pdf": "document.pdf",
};

function defaultFilename(mimeType: string, index: number): string {
  if (EXTENSIONS[mimeType]) return EXTENSIONS[mimeType];
  const [type, subtype] = mimeType.split("/");
  if (type === "image" && subtype && /^[a-z0-9.+-]+$/.test(subtype)) return `image-${index + 1}.${subtype.split("+")[0]}`;
  return `attachment-${index + 1}`;
}

/** A stable seed for messages without a Message-ID: their own header block. */
function headerSeed(headers: readonly { key: string; value: string }[]): string {
  return headers
    .filter(({ key }) => ["from", "to", "date", "subject"].includes(key))
    .map(({ key, value }) => `${key}:${value}`)
    .join("\n");
}
