// Messages and threads as sync writes them: finding a known message, adding a new one, starting a thread,
// and recomputing what a thread shows from its messages. Runs under `ctx.lock`.

import type { Address, ProviderMessage } from "@usualmail/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { attachments, heldCopies, messages, threads, type InboxRow, type MessageRow, type ThreadRow } from "../db/index.ts";
import { inList } from "../db/params.ts";
import type { Ctx } from "../service/context.ts";
import { normalizeListId } from "../service/match.ts";
import { snippetText } from "../ai/text.ts";
import { blockedSenders, getThread, runBatch, shownIn } from "../service/store.ts";

export async function findByRef(ctx: Ctx, inboxId: string, ref: string): Promise<MessageRow | undefined> {
  return ctx.db.select().from(messages).where(and(eq(messages.inboxId, inboxId), eq(messages.ref, ref))).get();
}

/** By ref, or by Message-ID: a provider that renames messages when they move (IMAP) shows a moved one under a new ref. */
export function dateOf(message: { date: string }, fallback: number): number {
  const ms = Date.parse(message.date);
  return Number.isNaN(ms) ? fallback : ms;
}

/** A new thread for this message, at version 1, waiting to be filled and sorted. */
export async function createThread(ctx: Ctx, inbox: InboxRow, first: ProviderMessage): Promise<ThreadRow> {
  const row: ThreadRow = {
    id: ctx.id("thr"),
    inboxId: inbox.id,
    threadKey: first.threadKey,
    subject: first.subject,
    snippet: "",
    participants: [],
    lastMessageAt: dateOf(first, ctx.now()),
    messageCount: 0,
    unread: false,
    hasAttachments: false,
    category: "unknown",
    categorizedBy: null,
    categorizedByActor: null,
    screened: false,
    screenedByMailbox: false,
    gatePending: false,
    skippedScreening: null,
    summary: null,
    payment: null,
    paymentAgain: false,
    event: null,
    eventKey: null,
    avatar: null,
    categoryDue: false,
    categoryAskAgain: false,
    summaryDue: false,
    done: false,
    stack: null,
    comeBackAt: null,
    comeBackIfNoReply: false,
    comeBackSetAt: null,
    need: null,
    reason: null,
    sender: first.outgoing ? null : first.from.email.toLowerCase(),
    trashed: false,
    removed: false,
    version: 1,
    revision: 0,
    comeBackAnnounced: false,
    createdAt: ctx.now(),
  };
  await ctx.db.insert(threads).values(row);
  return row;
}

export async function insertMessage(
  ctx: Ctx,
  inbox: InboxRow,
  thread: ThreadRow,
  m: ProviderMessage,
  listed: number | null,
): Promise<void> {
  const id = ctx.id("msg");
  await runBatch(ctx, [
    ctx.db.insert(messages).values({
      id,
      threadId: thread.id,
      inboxId: inbox.id,
      ref: m.ref,
      messageId: m.messageId ?? null,
      inReplyTo: m.inReplyTo ?? null,
      references: m.references,
      from: m.from,
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
      replyTo: m.replyTo ?? null,
      date: dateOf(m, ctx.now()),
      subject: m.subject,
      text: m.text ?? null,
      html: m.html ?? null,
      unread: !m.seen,
      outgoing: m.outgoing,
      // The list's id as rules and Message carry it: the part in angle brackets, lower case.
      listId: normalizeListId(m.listId),
      listUnsubscribe: m.listUnsubscribe ?? null,
      automated: m.automated,
      // What the provider's own checker proved about the From domain, when the server asked (sender pictures).
      fromCheck: m.fromCheck?.result ?? null,
      fromVerified: m.fromCheck?.result === "verified" ? m.fromCheck.domain : null,
      placement: m.placement,
      seen: m.seen,
      listed,
      createdAt: ctx.now(),
    }),
    ...m.attachments.map((file, position) => ctx.db.insert(attachments).values({
      id: ctx.id("att"),
      messageId: id,
      providerId: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      inline: file.inline,
      contentId: file.contentId ?? null,
      position,
    })),
  ]);
}

export async function deleteMessage(ctx: Ctx, id: string): Promise<void> {
  await runBatch(ctx, [
    ctx.db.delete(attachments).where(eq(attachments.messageId, id)),
    ctx.db.delete(heldCopies).where(eq(heldCopies.messageId, id)),
    ctx.db.delete(messages).where(eq(messages.id, id)),
  ]);
}

/**
 * Recomputes what a thread shows from its messages, oldest first by date. A thread left with no messages no
 * longer exists. The version goes up only when something shown changed. The revision doesn't: mail arriving
 * doesn't change where the thread is (bringing it back from done does, through `saveThreadState`).
 */
export async function refreshThread(ctx: Ctx, threadId: string): Promise<void> {
  const row = await getThread(ctx, threadId);
  if (!row) return;
  const list = await ctx.db.select().from(messages).where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.date), asc(messages.id));
  if (list.length === 0) {
    if (!row.removed) {
      await ctx.db.update(threads).set({ removed: true, version: sql`${threads.version} + 1` }).where(eq(threads.id, threadId));
    }
    return;
  }
  // The sender comes from every message; what a person sees, from the messages they see: what a blocked sender wrote
  // into this thread changes none of it.
  const sender = list.find((m) => !m.outgoing)?.from.email.toLowerCase() ?? row.sender;
  const shown = list.filter(shownIn(sender, await blockedSenders(ctx, row.inboxId)));
  const latest = shown.at(-1)!;
  const files = await ctx.db.select({ inline: attachments.inline }).from(attachments)
    .where(inList(attachments.messageId, shown.map((m) => m.id)));
  const next = {
    subject: shown[0]!.subject,
    snippet: snippetText(latest.text, latest.html),
    participants: participantsOf(shown),
    lastMessageAt: latest.date,
    messageCount: shown.length,
    unread: shown.some((m) => m.unread),
    hasAttachments: files.some((file) => !file.inline),
    sender,
    removed: false,
  };
  const same = (Object.keys(next) as Array<keyof typeof next>)
    .every((key) => JSON.stringify(row[key]) === JSON.stringify(next[key]));
  if (same) return;
  await ctx.db.update(threads).set({ ...next, version: sql`${threads.version} + 1` }).where(eq(threads.id, threadId));
}

/**
 * The snippet a thread shows, made again from its stored messages as `refreshThread` makes it: its newest message a
 * person sees. Reads only that message's body. Null when it has no messages.
 */
export async function threadSnippet(ctx: Ctx, row: Pick<ThreadRow, "id" | "inboxId" | "sender">, blocked: Set<string>): Promise<string | null> {
  const heads = await ctx.db.select({ id: messages.id, from: messages.from, outgoing: messages.outgoing }).from(messages)
    .where(eq(messages.threadId, row.id)).orderBy(asc(messages.date), asc(messages.id));
  if (heads.length === 0) return null;
  const sender = heads.find((m) => !m.outgoing)?.from.email.toLowerCase() ?? row.sender;
  const latest = heads.filter(shownIn(sender, blocked)).at(-1);
  if (!latest) return null;
  const body = await ctx.db.select({ text: messages.text, html: messages.html }).from(messages).where(eq(messages.id, latest.id)).get();
  return snippetText(body?.text ?? null, body?.html ?? null);
}

/** Senders, newest first; recipients too when only the mailbox itself has written. */
function participantsOf(list: MessageRow[]): Address[] {
  const out: Address[] = [];
  const add = (address: Address) => {
    if (!out.some((a) => a.email.toLowerCase() === address.email.toLowerCase())) out.push(address);
  };
  for (const message of [...list].reverse()) add(message.from);
  if (list.every((m) => m.outgoing)) for (const address of list.at(-1)!.to) add(address);
  return out;
}
