// Who may see and do what. A person sees every inbox; an agent sees an inbox only when its token lists it
// and the inbox's agentAccess is on. Anything an agent can't see answers `not_found`.

import { ServiceError, type Caller } from "@usualmail/core";
import { asc, eq } from "drizzle-orm";
import { inboxes, type InboxRow, type ThreadRow } from "../db/index.ts";
import type { Ctx } from "./context.ts";
import { getInbox, getThread } from "./store.ts";

export function isPerson(caller: Caller): boolean {
  return caller.actor.kind === "person";
}

export function requirePerson(caller: Caller, what: string): void {
  if (!isPerson(caller)) throw new ServiceError("needs_person", `Only a person can ${what}`);
}

/** Whether the caller may see this inbox, from the cached agentAccess flags. */
export function canSee(ctx: Ctx, caller: Caller, inboxId: string): boolean {
  if (!ctx.agentAccess.has(inboxId)) return false;
  if (caller.inboxIds && !caller.inboxIds.includes(inboxId)) return false;
  return isPerson(caller) || ctx.agentAccess.get(inboxId) === true;
}

export function mayRead(caller: Caller, inbox: InboxRow): boolean {
  if (caller.inboxIds && !caller.inboxIds.includes(inbox.id)) return false;
  return isPerson(caller) || inbox.agentAccess;
}

/** Every inbox id the caller may see, in the inbox list's order. */
export async function visibleInboxIds(ctx: Ctx, caller: Caller): Promise<string[]> {
  const rows = await ctx.db.select().from(inboxes).orderBy(asc(inboxes.position), asc(inboxes.id));
  return rows.filter((row) => mayRead(caller, row)).map((row) => row.id);
}

/** The inboxes a list covers: one the caller names (which must be visible) or all visible ones. */
export async function listScope(ctx: Ctx, caller: Caller, inboxId: string | undefined): Promise<string[]> {
  if (inboxId !== undefined) return [(await requireInbox(ctx, caller, inboxId)).id];
  return visibleInboxIds(ctx, caller);
}

export async function requireInbox(ctx: Ctx, caller: Caller, id: string): Promise<InboxRow> {
  const inbox = await getInbox(ctx, id);
  if (!inbox || !mayRead(caller, inbox)) throw new ServiceError("not_found", "No such inbox");
  return inbox;
}

export async function requireThread(ctx: Ctx, caller: Caller, id: string): Promise<{ thread: ThreadRow; inbox: InboxRow }> {
  const thread = await getThread(ctx, id);
  const inbox = thread && await getInbox(ctx, thread.inboxId);
  if (!thread || !inbox || !mayRead(caller, inbox)) throw new ServiceError("not_found", "No such thread");
  return { thread, inbox };
}

/** Loads every inbox's agentAccess into the cache that event filtering reads. */
export async function loadAccessCache(ctx: Ctx): Promise<void> {
  ctx.agentAccess.clear();
  const rows = await ctx.db.select({ id: inboxes.id, agentAccess: inboxes.agentAccess }).from(inboxes);
  for (const row of rows) ctx.agentAccess.set(row.id, row.agentAccess);
}

export async function refreshAccess(ctx: Ctx, inboxId: string): Promise<void> {
  const row = await ctx.db.select({ agentAccess: inboxes.agentAccess }).from(inboxes).where(eq(inboxes.id, inboxId)).get();
  if (row) ctx.agentAccess.set(inboxId, row.agentAccess);
  else ctx.agentAccess.delete(inboxId);
}
