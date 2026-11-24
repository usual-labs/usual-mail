// The lists people and agents read (docs/contract.md, "Lists"). Newest first, paged with opaque cursors.

import type {
  ActionState,
  Caller,
  Category,
  HandledItem,
  HandledQuery,
  ListQuery,
  Message,
  Page,
  Stack,
  Thread,
  ThreadDetail,
  TriageItem,
} from "@usualmail/core";
import { and, asc, desc, eq, exists, inArray, isNotNull, ne, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { aiWontDecide } from "../ai/work.ts";
import { messageAvatars } from "../avatars/settle.ts";
import { actions, attachments, drafts, messages, threads, type ThreadRow } from "../db/index.ts";
import { inList } from "../db/params.ts";
import { decodeCursor, encodeCursor, pageLimit } from "../util.ts";
import { listScope, requireThread } from "./access.ts";
import type { Ctx } from "./context.ts";
import { keptSent } from "./drafts.ts";
import { picturesHeldBack, withPictures } from "./pictures.ts";
import { blockedSenders, shownIn } from "./store.ts";
import { categoryWhere, homeOrder, homeWhere, screeningWhere, stackWhere, undecidedWhere, visible, waitingWhere } from "./lists.ts";
import { publishedSecond, toDraft, toMessage, toRecord, toThread, wholeSecond } from "./rows.ts";
import { check, HandledQuerySchema, ListQuerySchema, TriageQuerySchema } from "./schemas.ts";

/**
 * A page of threads, by `order` (default `lastMessageAt`) in the whole seconds it is published in, then by id: newest
 * first (both descending) unless `ascending`. Trashed threads and threads gone from the mailbox are never listed.
 */
async function threadPage(
  ctx: Ctx,
  scope: string[],
  where: SQL | undefined,
  query: ListQuery,
  order: SQL<number> | AnyColumn = threads.lastMessageAt,
  ascending = false,
): Promise<Page<Thread>> {
  if (scope.length === 0) return { items: [] };
  const limit = pageLimit(query.limit);
  const after = query.cursor ? decodeCursor(query.cursor) : undefined;
  const second = publishedSecond(order);
  const past = ascending
    ? after && sql`(${second} > ${after.at} OR (${second} = ${after.at} AND ${threads.id} > ${String(after.tie)}))`
    : after && sql`(${second} < ${after.at} OR (${second} = ${after.at} AND ${threads.id} < ${String(after.tie)}))`;
  const direction = ascending ? asc : desc;
  const rows = await ctx.db.select({ thread: threads, at: second }).from(threads)
    .where(and(inList(threads.inboxId, scope), visible(), where, past))
    .orderBy(direction(second), direction(threads.id)).limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const page: Page<Thread> = { items: items.map((row) => toThread(row.thread)) };
  if (rows.length > limit && last) page.nextCursor = encodeCursor({ at: last.at, tie: last.thread.id });
  return page;
}

async function scoped(ctx: Ctx, caller: Caller, input: ListQuery): Promise<{ query: ListQuery; scope: string[] }> {
  const query = check(ListQuerySchema, input, "Query");
  return { query, scope: await listScope(ctx, caller, query.inboxId) };
}

/** Conversations and undecided threads that aren't screened, done, stacked or waiting. */
export async function home(ctx: Ctx, caller: Caller, input: ListQuery): Promise<Page<Thread>> {
  const { query, scope } = await scoped(ctx, caller, input);
  return threadPage(ctx, scope, homeWhere(ctx.now()), query, homeOrder);
}

/** The threads of one or more categories that aren't screened, done or waiting, stacked ones included, merged. */
export async function category(ctx: Ctx, caller: Caller, names: Category[], input: ListQuery): Promise<Page<Thread>> {
  const { query, scope } = await scoped(ctx, caller, input);
  return threadPage(ctx, scope, categoryWhere(names, ctx.now()), query);
}

export async function stack(ctx: Ctx, caller: Caller, name: Stack, input: ListQuery): Promise<Page<Thread>> {
  const { query, scope } = await scoped(ctx, caller, input);
  return threadPage(ctx, scope, stackWhere(name), query);
}

/** Threads whose come-back time is ahead, soonest first, equal times by id, ascending. */
export async function waiting(ctx: Ctx, caller: Caller, input: ListQuery): Promise<Page<Thread>> {
  const { query, scope } = await scoped(ctx, caller, input);
  return threadPage(ctx, scope, waitingWhere(ctx.now()), query, threads.comeBackAt, true);
}

/** Screened threads that aren't done. */
export async function screening(ctx: Ctx, caller: Caller, input: ListQuery): Promise<Page<Thread>> {
  const { query, scope } = await scoped(ctx, caller, input);
  return threadPage(ctx, scope, screeningWhere(), query);
}

/**
 * What rules, agents and the server's AI did or propose, newest first by the whole second of the record's time, equal
 * times by id, descending. Silent records (the AI's always, unless something went wrong) only with `includeSilent`; a
 * record that failed or carries a note is never silent. With `attentionOnly`, only records that failed or carry an
 * error or a note, from every state unless `states` says, and whoever made them: a person's own refused write-back
 * too. Records of trashed threads stay, each with its thread, so a trash can be undone here; records of a thread gone
 * from the mailbox leave.
 */
export async function handled(ctx: Ctx, caller: Caller, input: HandledQuery): Promise<Page<HandledItem>> {
  const query = check(HandledQuerySchema, input, "Query");
  const scope = await listScope(ctx, caller, query.inboxId);
  if (scope.length === 0) return { items: [] };
  const attention = query.attentionOnly === true;
  const states: ActionState[] = query.states ?? (attention ? ["proposed", "applied", "undone", "rejected", "failed"] : ["proposed", "applied"]);
  const limit = pageLimit(query.limit);
  const after = query.cursor ? decodeCursor(query.cursor) : undefined;
  const second = publishedSecond(actions.at);
  const rows = await ctx.db.select({ record: actions, thread: threads }).from(actions)
    .innerJoin(threads, eq(threads.id, actions.threadId))
    .where(and(
      inList(actions.inboxId, scope),
      // What needs a look is anyone's; Handled's ordinary list is rules', agents' and the AI's.
      attention ? undefined : inArray(actions.actorKind, ["rule", "agent", "ai"]),
      inArray(actions.state, [...new Set(states)]),
      query.includeSilent === true ? undefined : eq(actions.silent, false),
      attention ? or(eq(actions.state, "failed"), isNotNull(actions.error), isNotNull(actions.note)) : undefined,
      eq(threads.removed, false),
      after && sql`(${second} < ${after.at} OR (${second} = ${after.at} AND ${actions.id} < ${String(after.tie)}))`,
    )).orderBy(desc(second), desc(actions.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const items: HandledItem[] = page.map((row) => ({ record: toRecord(row.record), thread: toThread(row.thread) }));
  const last = page.at(-1);
  return rows.length > limit && last
    ? { items, nextCursor: encodeCursor({ at: wholeSecond(last.record.at), tie: last.record.id }) }
    : { items };
}

/**
 * The messages a person sees in these threads, oldest first: not what a blocked sender wrote into someone else's.
 * Their HTML shows pictures from the web through the server, with trackers taken out and held-back pictures left out.
 */
export async function messagesOf(ctx: Ctx, threadRows: ThreadRow[]) {
  if (threadRows.length === 0) return [];
  const blocked = new Map<string, Set<string>>();
  for (const inboxId of new Set(threadRows.map((row) => row.inboxId))) blocked.set(inboxId, await blockedSenders(ctx, inboxId));
  const byId = new Map(threadRows.map((row) => [row.id, row]));
  const shown = new Map(threadRows.map((row) => [row.id, shownIn(row.sender, blocked.get(row.inboxId)!)]));
  const rows = (await ctx.db.select().from(messages).where(inList(messages.threadId, threadRows.map((row) => row.id)))
    .orderBy(asc(messages.date), asc(messages.id))).filter((row) => shown.get(row.threadId)!(row));
  const files = rows.length
    ? await ctx.db.select().from(attachments).where(inList(attachments.messageId, rows.map((m) => m.id)))
      .orderBy(asc(attachments.position))
    : [];
  const avatars = new Map<string, NonNullable<Message["avatar"]>>();
  for (const thread of threadRows) {
    for (const [id, avatar] of await messageAvatars(ctx, thread, rows.filter((row) => row.threadId === thread.id))) avatars.set(id, avatar);
  }
  return Promise.all(rows.map(async (row) => {
    const thread = byId.get(row.threadId)!;
    const held = picturesHeldBack(thread, row, blocked.get(thread.inboxId)!);
    const message = await withPictures(ctx, toMessage(row, files.filter((file) => file.messageId === row.id)), held);
    const avatar = avatars.get(row.id);
    return avatar ? { ...message, avatar } : message;
  }));
}

/** A thread with its messages and drafts: unsent ones, and sent ones with a note for a day after sending. */
export async function threadDetail(ctx: Ctx, caller: Caller, id: string): Promise<ThreadDetail> {
  const { thread } = await requireThread(ctx, caller, id);
  const draftRows = await ctx.db.select().from(drafts)
    .where(and(eq(drafts.threadId, thread.id), or(ne(drafts.state, "sent"), keptSent(ctx))))
    .orderBy(asc(drafts.createdAt), asc(drafts.id));
  return { thread: toThread(thread), messages: await messagesOf(ctx, [thread]), drafts: draftRows.map(toDraft) };
}

/**
 * The triage queue's condition: undecided threads nobody has decided, not done or screened, with mail, that the
 * server's AI won't process: the AI isn't working, or the AI's answer was dropped and no mail joined since (history
 * reaches all synced mail, so age is no reason). `working` is whether the AI's state is `working`.
 */
export async function triageWhere(ctx: Ctx, working: boolean): Promise<SQL> {
  return and(
    visible(),
    undecidedWhere(),
    exists(ctx.db.select({ one: sql`1` }).from(messages).where(eq(messages.threadId, threads.id))),
    aiWontDecide(working),
  )!;
}

/** Undecided threads the AI won't process, each with its newest message: oldest first, equal times by id, ascending. */
export async function triageQueue(ctx: Ctx, caller: Caller, input: { inboxId?: string; limit?: number }, working: boolean): Promise<TriageItem[]> {
  const query = check(TriageQuerySchema, input, "Query");
  const scope = await listScope(ctx, caller, query.inboxId);
  if (scope.length === 0) return [];
  const rows: ThreadRow[] = await ctx.db.select().from(threads)
    .where(and(inList(threads.inboxId, scope), await triageWhere(ctx, working)))
    .orderBy(asc(publishedSecond(threads.lastMessageAt)), asc(threads.id)).limit(pageLimit(query.limit));
  const all = await messagesOf(ctx, rows);
  return rows.flatMap((row) => {
    const latest = all.filter((m) => m.threadId === row.id).at(-1);
    return latest ? [{ thread: toThread(row), latest }] : [];
  });
}

/** How many threads wait in each inbox's triage queue. */
export async function triageCounts(ctx: Ctx, working: boolean): Promise<Map<string, number>> {
  const rows = await ctx.db.select({ inboxId: threads.inboxId, count: sql<number>`count(*)` }).from(threads)
    .where(await triageWhere(ctx, working)).groupBy(threads.inboxId);
  return new Map(rows.map((row) => [row.inboxId, row.count]));
}
