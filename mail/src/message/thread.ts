/**
 * Thread keys for providers that don't group conversations themselves (IMAP).
 *
 * The rule: a message's key is the first id in its References header (the conversation's root, which
 * RFC 5322 asks every reply to keep), else its In-Reply-To, else its own Message-ID. A message without a
 * Message-ID gets a key hashed from its headers, so it is a conversation of its own.
 *
 * Limits: a reply whose client dropped References and kept only In-Reply-To gets its parent's id. When
 * the parent was itself a reply, the two land in different threads. Subjects are never compared.
 */
import { createHash } from "node:crypto";

export interface ThreadHeaders {
  messageId?: string;
  inReplyTo?: string;
  references: readonly string[];
}

export function threadKeyFor(headers: ThreadHeaders, fallbackSeed: string): string {
  const root = headers.references[0] ?? headers.inReplyTo ?? headers.messageId;
  if (root) return `mid:${root}`;
  return `hash:${createHash("sha256").update(fallbackSeed).digest("hex").slice(0, 32)}`;
}
