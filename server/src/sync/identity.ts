// Which stored message a reported one is (the security review's third round, 2026-11-18). A Message-ID is written by
// the sender, and everyone the person writes to learns it, so a Message-ID alone never lets new mail change a stored
// message: its content, sender, `outgoing` or placement.
//
// - The same message at the provider is its ref: a Gmail message id, an IMAP folder and UID.
// - On IMAP a message also gets a new ref when another app moves it or the folder's UIDVALIDITY changes, and the same
//   message can sit in INBOX and Sent at once. There, a reported message with the same Message-ID and the same content
//   (`contentFingerprint`: addresses, subject, date, text, HTML, attachments) is the same message. But anyone who
//   received a message knows its content, so such a copy changes the stored message only when no one else could
//   have sent it: the stored copy's ref is reported removed (a move or a reset; in the same batch, or later while
//   the copy is held in `held_copies`), or one of the two is the Sent copy and the other isn't (the Sent copy makes
//   it the inbox's own; nothing else changes). Gmail ids never change, so Gmail needs no such match.
// - Anything else is a separate message, from whoever it says it is from, the inbox's own only by the evidence rule.
//
// The fingerprint is worked out from what a row stores, so rows stored before this rule need nothing new.

import type { ProviderChange, ProviderMessage } from "@usualmail/core";
import { and, asc, eq } from "drizzle-orm";
import { attachments, heldCopies, messages, threads, type InboxRow, type MessageRow } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { getThread, saveThreadState, senderStatus, threadState } from "../service/store.ts";
import { doneState } from "../service/state.ts";
import { sha256 } from "../util.ts";
import { dateOf, findByRef } from "./rows.ts";

const norm = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
const emails = (list: Array<{ email: string }>): string[] => list.map((a) => a.email.toLowerCase()).sort();

interface Content {
  from: { email: string };
  to: Array<{ email: string }>;
  cc: Array<{ email: string }>;
  subject: string;
  date: number;
  text?: string | null;
  html?: string | null;
  attachments: Array<{ filename: string; mimeType: string; size: number }>;
}

/**
 * What a message says, as a hash: who it is from and to (not Bcc, which only the sender's copy has), its subject,
 * date, text, HTML and attachments, whitespace evened out. Two copies of one message have the same; delivery adds
 * headers, but none of these.
 */
export function contentFingerprint(m: Content): Promise<string> {
  return sha256(JSON.stringify(contentParts(m, m.date)));
}

/** The parts both hashes read; `date` is null for the sent key, which can't know the Date header the provider wrote. */
function contentParts(m: Omit<Content, "date" | "attachments"> & { attachments?: Content["attachments"] }, date: number | null) {
  return [
    m.from.email.toLowerCase(),
    emails(m.to),
    emails(m.cc),
    norm(m.subject),
    date,
    norm(m.text),
    norm(m.html),
    (m.attachments ?? []).map((file) => `${file.filename}|${file.mimeType}|${file.size}`).sort(),
  ];
}

async function rowFingerprint(ctx: Ctx, row: MessageRow): Promise<string> {
  const files = await ctx.db.select().from(attachments).where(eq(attachments.messageId, row.id)).orderBy(asc(attachments.position));
  return contentFingerprint({ ...row, attachments: files });
}

/**
 * The stored message a reported one is, and how it was known: by its ref; by content as a move (its stored copy's
 * ref is in `gone`, the refs the same batch reports removed) or as the Sent copy of an inbox copy or the other way
 * round; or `held`, the same kind of copy while the stored one is still there. Undefined for a message new to the
 * server.
 */
export async function sameMessage(
  ctx: Ctx,
  inbox: InboxRow,
  reported: ProviderMessage,
  gone: ReadonlySet<string>,
): Promise<{ row: MessageRow; by: "ref" | "content" | "held" } | undefined> {
  const byRef = await findByRef(ctx, inbox.id, reported.ref);
  if (byRef) return { row: byRef, by: "ref" };
  if (inbox.provider === "gmail" || !reported.messageId) return undefined;
  const candidates = await ctx.db.select().from(messages)
    .where(and(eq(messages.inboxId, inbox.id), eq(messages.messageId, reported.messageId)));
  if (candidates.length === 0) return undefined;
  const wanted = await contentFingerprint({ ...reported, date: dateOf(reported, ctx.now()) });
  let held: MessageRow | undefined;
  for (const row of candidates) {
    if (await rowFingerprint(ctx, row) !== wanted) continue;
    if (gone.has(row.ref) || row.outgoing !== reported.outgoing) return { row, by: "content" };
    held ??= row;
  }
  return held && { row: held, by: "held" };
}

/**
 * Holds a copy of a stored message while that one is still where it was (`heldCopies`), or updates it. A held copy
 * goes when its own ref is reported removed, or with its message or inbox, so what is held is what the mailbox holds.
 */
export async function holdCopy(ctx: Ctx, row: MessageRow, copy: ProviderChange): Promise<void> {
  const state = { messageId: row.id, seen: copy.seen, placement: copy.placement };
  await ctx.db.insert(heldCopies).values({ inboxId: row.inboxId, ref: copy.ref, ...state, heldAt: ctx.now() })
    .onConflictDoUpdate({ target: [heldCopies.inboxId, heldCopies.ref], set: state });
}

/** A change the provider reports for a held copy: kept with it. False when the ref isn't a held copy's. */
export async function changeHeldCopy(ctx: Ctx, inboxId: string, change: ProviderChange): Promise<boolean> {
  const where = and(eq(heldCopies.inboxId, inboxId), eq(heldCopies.ref, change.ref));
  if (!await ctx.db.select({ ref: heldCopies.ref }).from(heldCopies).where(where).get()) return false;
  await ctx.db.update(heldCopies).set({ seen: change.seen, placement: change.placement }).where(where);
  return true;
}

/** The removal of a held copy's ref: forgotten. False when the ref isn't a held copy's. */
export async function dropHeldCopy(ctx: Ctx, inboxId: string, ref: string): Promise<boolean> {
  const where = and(eq(heldCopies.inboxId, inboxId), eq(heldCopies.ref, ref));
  if (!await ctx.db.select({ ref: heldCopies.ref }).from(heldCopies).where(where).get()) return false;
  await ctx.db.delete(heldCopies).where(where);
  return true;
}

/**
 * The stored message's ref is reported removed: a copy held for it is where it moved to, and leaves the held copies
 * (the oldest, if several). Undefined when none is held.
 */
export async function takeHeldCopy(ctx: Ctx, row: MessageRow): Promise<ProviderChange | undefined> {
  const copy = await ctx.db.select().from(heldCopies).where(eq(heldCopies.messageId, row.id))
    .orderBy(asc(heldCopies.heldAt), asc(heldCopies.ref)).get();
  if (!copy) return undefined;
  await ctx.db.delete(heldCopies).where(and(eq(heldCopies.inboxId, copy.inboxId), eq(heldCopies.ref, copy.ref)));
  return { ref: copy.ref, seen: copy.seen, placement: copy.placement };
}

/**
 * The key a message the server sent is remembered by: its Message-ID with a hash of everything the content
 * fingerprint reads but the date (who it was from and to, its subject, text, HTML and attachments), so a copy that
 * comes back counts only when it is exactly what was sent: not the Message-ID reused with other recipients or words,
 * nor with HTML or attachments added to a message sent as text only. The Message-ID ties it to that one sending.
 */
export async function sentKey(m: Omit<Content, "date" | "attachments"> & { attachments?: Content["attachments"] }, messageId: string): Promise<string> {
  const hash = await sha256(JSON.stringify(contentParts(m, null)));
  return `${messageId}\n${hash}`;
}

/**
 * The Sent copy of a message stored from another copy (IMAP: the inbox copy synced first) has joined it: the message
 * is the inbox's own. Its thread's sender and screening are worked out again as if it had arrived that way: a thread
 * left with only the inbox's own mail has no sender, isn't screened (unless the mailbox filed it under Screening)
 * and is done; otherwise its sender is its first incoming message's, screened while that sender isn't let in.
 * Returns whether the thread's placement changed, so it is written back.
 */
export async function becameOwn(ctx: Ctx, row: MessageRow): Promise<boolean> {
  await ctx.db.update(messages).set({ outgoing: true }).where(eq(messages.id, row.id));
  const thread = await getThread(ctx, row.threadId);
  if (!thread) return false;
  const list = await ctx.db.select({ outgoing: messages.outgoing, from: messages.from }).from(messages)
    .where(eq(messages.threadId, thread.id)).orderBy(asc(messages.date), asc(messages.id));
  const firstIncoming = list.find((m) => !m.outgoing);
  const sender = firstIncoming ? firstIncoming.from.email.toLowerCase() : null;
  if (sender === thread.sender) return false;
  await ctx.db.update(threads).set({ sender }).where(eq(threads.id, thread.id));
  const state = await threadState(ctx, { ...thread, sender });
  let next = { ...state };
  if (sender === null) {
    next = { ...doneState(state), screened: state.screenedByMailbox };
  } else if (!state.screenedByMailbox) {
    const status = await senderStatus(ctx, thread.inboxId, sender);
    next = status === "blocked" ? { ...doneState(state), screened: true } : { ...state, screened: status !== "known" };
  }
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  if (changed) await saveThreadState(ctx, thread.id, next);
  return changed;
}
