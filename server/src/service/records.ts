// The action history's rows: adding a record, changing one (its version goes up and an event goes out), and
// retiring undo when something later changes the same part of a thread. Callers hold `ctx.lock`.

import type { ActionInput, ActionKind, Actor } from "@usualmail/core";
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { actions, type ActionRow, type InboxRow } from "../db/index.ts";
import { inList } from "../db/params.ts";
import type { Ctx } from "./context.ts";
import { toRecord } from "./rows.ts";
import { kindsTouching, type Before, type Group } from "./state.ts";

export interface NewRecord {
  inbox: InboxRow;
  threadId: string;
  action: ActionInput;
  actor: Actor;
  reason?: string;
  state: ActionRow["state"];
  undoable: boolean;
  silent?: boolean;
  before: Before;
}

/** Stores a new record at version 1 and sends `action.recorded`. */
export async function insertRecord(ctx: Ctx, input: NewRecord): Promise<ActionRow> {
  const row: ActionRow = {
    id: ctx.id("act"),
    threadId: input.threadId,
    inboxId: input.inbox.id,
    action: input.action,
    kind: input.action.kind,
    actor: input.actor,
    actorKind: input.actor.kind,
    reason: input.reason ?? null,
    state: input.state,
    at: ctx.now(),
    undoneAt: null,
    undoable: input.undoable,
    error: null,
    silent: input.silent ?? false,
    note: null,
    before: input.before,
    version: 1,
  };
  await ctx.db.insert(actions).values(row);
  ctx.emit({ type: "action.recorded", record: toRecord(row) });
  return row;
}

type RecordPatch = Partial<Pick<ActionRow, "state" | "at" | "undoneAt" | "undoable" | "error" | "before" | "silent" | "note">>;

/** Changes a record: its version goes up by one and `action.recorded` goes out. Returns it as it is now. */
export async function updateRecord(ctx: Ctx, id: string, patch: RecordPatch): Promise<ActionRow> {
  await ctx.db.update(actions).set({ ...patch, version: sql`${actions.version} + 1` }).where(eq(actions.id, id));
  const row = await ctx.db.select().from(actions).where(eq(actions.id, id)).get();
  if (!row) throw new Error(`Action ${id} vanished while it was being changed`);
  ctx.emit({ type: "action.recorded", record: toRecord(row) });
  return row;
}

/**
 * Earlier applied records on these threads that touch any of `groups` can no longer be undone exactly, since
 * something later changed the same part. Each one changed gets a new version and an event. Allow and block are
 * left alone: they stay undoable until a later allow or block of the same sender (see `retireSenderUndo`).
 */
export async function retireUndo(ctx: Ctx, threadIds: string[], groups: readonly Group[], except?: string): Promise<void> {
  if (threadIds.length === 0 || groups.length === 0) return;
  const kinds = [...new Set(groups.flatMap((group) => kindsTouching(group)))] as ActionKind[];
  const rows = await ctx.db.select({ id: actions.id }).from(actions).where(and(
    inList(actions.threadId, threadIds),
    eq(actions.state, "applied"),
    eq(actions.undoable, true),
    inArray(actions.kind, kinds),
    notInArray(actions.kind, ["allow_sender", "block_sender"]),
    except ? ne(actions.id, except) : undefined,
  ));
  for (const { id } of rows) await updateRecord(ctx, id, { undoable: false });
}

/** A later allow or block of this sender was applied: earlier allows and blocks of them can't be undone. */
export async function retireSenderUndo(ctx: Ctx, inboxId: string, email: string, except: string): Promise<void> {
  const rows = await ctx.db.select({ id: actions.id }).from(actions).where(and(
    eq(actions.inboxId, inboxId),
    eq(actions.state, "applied"),
    eq(actions.undoable, true),
    inArray(actions.kind, ["allow_sender", "block_sender"]),
    sql`json_extract(${actions.before}, '$.sender.email') = ${email}`,
    ne(actions.id, except),
  ));
  for (const { id } of rows) await updateRecord(ctx, id, { undoable: false });
}

/**
 * The provider added a note to a write-back this record caused: the record shows it (a later note replaces an
 * earlier one) and is never silent again.
 */
export async function noteRecord(ctx: Ctx, id: string, note: string): Promise<void> {
  const row = await ctx.db.select({ note: actions.note, silent: actions.silent }).from(actions).where(eq(actions.id, id)).get();
  if (!row || (row.note === note && !row.silent)) return;
  await updateRecord(ctx, id, { note, silent: false });
}
