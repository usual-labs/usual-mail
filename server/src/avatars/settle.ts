// Which sender picture each thread and message shows (docs/contract-avatars.md). A thread's is kept on its row
// (`threads.avatar`) and worked out again whenever something it depends on changes: its mail, its category or
// screening (`saveThreadState`), its sender being let in or blocked, or its domain's picture; when it changes the
// version rises and the caller (or this module) sends the thread. A message's is worked out when it is served.
//
// A picture is shown only when every one of these holds: the server carries the Public Suffix List; the thread isn't
// screened; the address is let in (not unknown, not blocked); the mailbox provider's own checker proved the From
// domain of that address's message; the mail is an organisation's (machine-sent, or a filed category); the domain
// isn't a mailbox provider's anyone can sign up to; and its site gave a picture.

import type { Address, Avatar } from "@usualmail/core";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { messages, senders, threads, type MessageRow, type ThreadRow } from "../db/index.ts";
import { endsWith } from "../db/match.ts";
import { inList } from "../db/params.ts";
import type { Ctx } from "../service/context.ts";
import { emitThread, getThread } from "../service/store.ts";
import { avatarDomain, organisational } from "./rules.ts";
import { sitePictures, wantSite } from "./sites.ts";

/** Whether settling may want a domain's picture fetched: new mail (`fresh`), a domain never wanted (`new`), or not. */
export type Want = "fresh" | "new" | false;

interface Candidate {
  row: ThreadRow;
  domain: string | null;
}

/** The registrable domain a thread's picture would come from, if everything but the picture itself holds. */
async function candidate(ctx: Ctx, row: ThreadRow): Promise<string | null> {
  const avatars = ctx.avatars;
  if (!avatars || row.removed || row.screened || !row.sender) return null;
  const status = await ctx.db.select({ status: senders.status }).from(senders)
    .where(and(eq(senders.inboxId, row.inboxId), eq(senders.email, row.sender))).get();
  if (status?.status !== "known") return null;
  // The sender's own message: the oldest incoming one from that address (the one `sender` was taken from).
  const incoming = await ctx.db.select({ from: messages.from, fromVerified: messages.fromVerified, automated: messages.automated })
    .from(messages).where(and(eq(messages.threadId, row.id), eq(messages.outgoing, false)))
    .orderBy(asc(messages.date), asc(messages.id));
  const own = incoming.find((message) => message.from.email.toLowerCase() === row.sender);
  if (!own || !organisational(row.category, own.automated)) return null;
  return avatarDomain(own.fromVerified, row.sender, avatars.suffixes);
}

/**
 * Works out the pictures of these threads again. Each that changed gets its new picture and a higher version, and is
 * sent when `emit` says so (otherwise the caller sends it). `want` says whether a domain may be wanted for fetching
 * here. Returns the threads that changed. Callers hold `ctx.lock`.
 */
export async function settleThreadAvatars(
  ctx: Ctx,
  threadIds: Iterable<string>,
  options: { emit?: boolean; want?: Want | ((threadId: string) => Want) } = {},
): Promise<ThreadRow[]> {
  const found: Candidate[] = [];
  for (const id of new Set(threadIds)) {
    const row = await getThread(ctx, id);
    if (row) found.push({ row, domain: await candidate(ctx, row) });
  }
  let wanted = false;
  for (const { row, domain } of found) {
    const want = typeof options.want === "function" ? options.want(row.id) : options.want ?? false;
    if (domain && want) wanted = (await wantSite(ctx, domain, want === "fresh")) || wanted;
  }
  if (wanted) ctx.avatars?.wake();
  const pictures = await sitePictures(ctx, found.flatMap(({ domain }) => (domain ? [domain] : [])));
  const changed: ThreadRow[] = [];
  for (const { row, domain } of found) {
    const avatar = (domain && pictures.get(domain)) || null;
    if (JSON.stringify(avatar) === JSON.stringify(row.avatar ?? null)) continue;
    await ctx.db.update(threads).set({ avatar, version: sql`${threads.version} + 1` }).where(eq(threads.id, row.id));
    const saved = (await getThread(ctx, row.id))!;
    changed.push(saved);
    if (options.emit) emitThread(ctx, saved);
  }
  return changed;
}

/**
 * After senders were let in, blocked or made unknown: their threads' pictures again, each change sent, and a domain
 * never wanted before wanted now (letting a sender in is one way a picture comes to be wanted). Callers hold `ctx.lock`.
 */
export async function settleSenders(ctx: Ctx, inboxId: string, emails: readonly string[]): Promise<void> {
  if (!ctx.avatars || emails.length === 0) return;
  const rows = await ctx.db.select({ id: threads.id }).from(threads)
    .where(and(eq(threads.inboxId, inboxId), inList(threads.sender, emails.map((email) => email.toLowerCase())), eq(threads.removed, false)));
  await settleThreadAvatars(ctx, rows.map((row) => row.id), { emit: true, want: "new" });
}

/**
 * After a domain's picture appeared, changed or went: every thread that may show it, its own picture or a message's.
 * Each is sent with a higher version, so an app takes it, and the mail page, again. Callers hold `ctx.lock`.
 */
export async function settleDomain(ctx: Ctx, domain: string): Promise<void> {
  // Suffixes compared without LIKE, whose pattern a Durable Object limits to 50 bytes (src/db/match.ts).
  const bySender = await ctx.db.select({ id: threads.id }).from(threads)
    .where(and(eq(threads.removed, false), or(endsWith(threads.sender, `@${domain}`), endsWith(threads.sender, `.${domain}`))));
  const byMessage = new Set((await ctx.db.selectDistinct({ id: messages.threadId }).from(messages)
    .where(and(eq(messages.outgoing, false), or(eq(messages.fromVerified, domain), endsWith(messages.fromVerified, `.${domain}`)))))
    .map((row) => row.id));
  const ids = new Set([...bySender.map((row) => row.id), ...byMessage]);
  const changed = new Set((await settleThreadAvatars(ctx, ids, { emit: true })).map((row) => row.id));
  // Threads whose own picture didn't change but whose messages may show this one: a higher version, so the mail page
  // is read again.
  for (const id of byMessage) {
    if (changed.has(id)) continue;
    const row = await getThread(ctx, id);
    if (!row || row.removed) continue;
    await ctx.db.update(threads).set({ version: sql`${threads.version} + 1` }).where(eq(threads.id, id));
    emitThread(ctx, (await getThread(ctx, id))!);
  }
}

/**
 * The pictures of these messages of one thread, by message id, by the thread's rules applied to each message's own
 * From: never for the inbox's own mail, a screened thread, an address not let in, or mail its domain wasn't proved to
 * have sent.
 */
export async function messageAvatars(ctx: Ctx, thread: ThreadRow, rows: readonly Pick<MessageRow, "id" | "from" | "outgoing" | "fromVerified" | "automated">[]): Promise<Map<string, Avatar>> {
  const out = new Map<string, Avatar>();
  const avatars = ctx.avatars;
  if (!avatars || thread.screened) return out;
  const incoming = rows.filter((row) => !row.outgoing && row.fromVerified);
  if (incoming.length === 0) return out;
  const emails = [...new Set(incoming.map((row) => emailOf(row.from)))];
  const known = new Set((await ctx.db.select({ email: senders.email }).from(senders)
    .where(and(eq(senders.inboxId, thread.inboxId), inList(senders.email, emails), eq(senders.status, "known")))).map((row) => row.email));
  const domains = new Map<string, string>();
  for (const row of incoming) {
    const email = emailOf(row.from);
    if (!known.has(email) || !organisational(thread.category, row.automated)) continue;
    const domain = avatarDomain(row.fromVerified, email, avatars.suffixes);
    if (domain) domains.set(row.id, domain);
  }
  const pictures = await sitePictures(ctx, domains.values());
  for (const [id, domain] of domains) {
    const avatar = pictures.get(domain);
    if (avatar) out.set(id, avatar);
  }
  return out;
}

const emailOf = (address: Address) => address.email.toLowerCase();
