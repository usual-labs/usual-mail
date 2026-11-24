// Blocked senders as a person's Settings lists them (docs/contract.md, "Blocked senders"; the owner's request of
// 2026-11-20), and `sender.changed`, the event that says a sender became blocked or stopped being blocked, or that
// mail from a blocked sender arrived. A block is a `senders` row with status `blocked`: `updated_at` is when the block
// in force now was applied. Who blocked them is the actor of the newest applied `block_sender` record for that
// address. The count is made from the stored messages each time it is asked for: no counter is kept.

import { ServiceError, type BlockedSender, type Caller, type Page, type SendersQuery } from "@usualmail/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { actions, messages, senders, threads, type SenderStatus } from "../db/index.ts";
import { inList } from "../db/params.ts";
import { decodeCursor, encodeCursor, iso, pageLimit } from "../util.ts";
import { listScope, requirePerson } from "./access.ts";
import type { Ctx } from "./context.ts";
import { publishedSecond, wholeSecond } from "./rows.ts";
import { check, SendersQuerySchema } from "./schemas.ts";
import { senderStatus, setSenderStatus } from "./store.ts";

interface BlockedRow {
  inboxId: string;
  email: string;
  updatedAt: number;
}

/** What orders two blocks made in the same second: the inbox and the address. */
const tie = sql<string>`${senders.inboxId} || ' ' || ${senders.email}`;

/** Person only: the blocked senders of the inboxes asked for, the newest block first. */
export async function listSenders(ctx: Ctx, caller: Caller, input: SendersQuery): Promise<Page<BlockedSender>> {
  requirePerson(caller, "see the blocked senders");
  const query = check(SendersQuerySchema, input, "Query");
  const scope = await listScope(ctx, caller, query.inboxId);
  if (scope.length === 0) return { items: [] };
  const limit = pageLimit(query.limit);
  const after = query.cursor ? decodeCursor(query.cursor) : undefined;
  const second = publishedSecond(senders.updatedAt);
  const rows = await ctx.db.select({ inboxId: senders.inboxId, email: senders.email, updatedAt: senders.updatedAt }).from(senders).where(and(
    inList(senders.inboxId, scope),
    eq(senders.status, "blocked"),
    after && sql`(${second} < ${after.at} OR (${second} = ${after.at} AND ${tie} < ${String(after.tie)}))`,
  )).orderBy(desc(second), desc(tie)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const items = await blockedItems(ctx, page);
  return rows.length > limit && last
    ? { items, nextCursor: encodeCursor({ at: wholeSecond(last.updatedAt), tie: `${last.inboxId} ${last.email}` }) }
    : { items };
}

/**
 * The items of these blocked senders, in their order. For each inbox among them, one read of the stored messages
 * those addresses sent (their date and From alone) and one of its applied `block_sender` records: enough at the sizes
 * involved (a few blocked senders, whose mail is a small part of an inbox).
 */
async function blockedItems(ctx: Ctx, rows: readonly BlockedRow[]): Promise<BlockedSender[]> {
  const items: BlockedSender[] = [];
  for (const inboxId of [...new Set(rows.map((row) => row.inboxId))]) {
    const mine = rows.filter((row) => row.inboxId === inboxId);
    const addresses = mine.map((row) => row.email);
    const from = sql<string>`lower(json_extract(${messages.from}, '$.email'))`;
    const mail = await ctx.db.select({ from: messages.from, date: messages.date }).from(messages)
      .where(and(eq(messages.inboxId, inboxId), eq(messages.outgoing, false), inList(from, addresses)));
    const blocks = await ctx.db.select({ actor: actions.actor, at: actions.at, before: actions.before, sender: threads.sender })
      .from(actions).leftJoin(threads, eq(threads.id, actions.threadId))
      .where(and(eq(actions.inboxId, inboxId), eq(actions.kind, "block_sender"), eq(actions.state, "applied")))
      .orderBy(desc(actions.at), desc(actions.id));
    for (const row of mine) {
      const theirs = mail.filter((message) => message.from.email.toLowerCase() === row.email).sort((a, b) => b.date - a.date);
      const name = theirs.find((message) => message.from.name?.trim())?.from.name?.trim();
      const block = blocks.find((record) => (record.before.sender?.email ?? record.sender) === row.email);
      items.push({
        inboxId,
        address: row.email,
        ...(name && { name }),
        blockedAt: iso(row.updatedAt),
        ...(block && { blockedBy: block.actor }),
        // A message's date in whole seconds, as it is served, against the block's.
        messagesSinceBlocked: theirs.filter((message) => message.date > row.updatedAt).length,
        lastMessageAt: theirs[0] ? iso(theirs[0].date) : null,
      });
    }
  }
  const order = new Map(rows.map((row, index) => [`${row.inboxId} ${row.email}`, index]));
  return items.sort((a, b) => order.get(`${a.inboxId} ${a.address}`)! - order.get(`${b.inboxId} ${b.address}`)!);
}

/** One blocked sender's item, or null when they aren't blocked. */
async function blockedItem(ctx: Ctx, inboxId: string, email: string): Promise<BlockedSender | null> {
  const row = await ctx.db.select({ inboxId: senders.inboxId, email: senders.email, updatedAt: senders.updatedAt }).from(senders)
    .where(and(eq(senders.inboxId, inboxId), eq(senders.email, email), eq(senders.status, "blocked"))).get();
  return row ? (await blockedItems(ctx, [row]))[0] ?? null : null;
}

/** `sender.changed` for a sender as they are now: with their item while blocked. */
export async function senderChanged(ctx: Ctx, inboxId: string, email: string): Promise<void> {
  const sender = await blockedItem(ctx, inboxId, email);
  ctx.emit({ type: "sender.changed", inboxId, address: email, blocked: sender !== null, ...(sender && { sender }) });
}

/**
 * Sets a sender's standing as `setSenderStatus` does, and tells people's devices when that blocked them or ended
 * their block. Returns the sender's new mark.
 */
export async function setSender(ctx: Ctx, inboxId: string, email: string, status: SenderStatus | null): Promise<string | null> {
  const before = await senderStatus(ctx, inboxId, email);
  const mark = await setSenderStatus(ctx, inboxId, email, status);
  if ((before === "blocked") !== (status === "blocked")) await senderChanged(ctx, inboxId, email);
  return mark;
}

/** Mail from a blocked sender was stored: their count changed. */
export async function blockedMailArrived(ctx: Ctx, inboxId: string, email: string): Promise<void> {
  await senderChanged(ctx, inboxId, email);
}

/** An address as senders are kept: trimmed, lower case; `invalid` when it isn't one. */
export function senderAddress(value: string): string {
  const address = value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(address)) throw new ServiceError("invalid", "That isn't an email address");
  return address;
}
