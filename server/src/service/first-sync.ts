// The first sync's window (docs/contract-sync.md, "Sync"): how many days of mail a new inbox's first sync takes, the
// one setting that decides how much older mail the server holds and so what the AI works through. Person only. A new
// window is kept where the host keeps its settings and applies at once: an inbox connected afterwards takes it, a
// first sync still in progress fetches nothing older than a smaller one from its next sync (the engine opens its
// provider again), and a larger one changes no inbox already connected.

import { FIRST_SYNC_MAX_DAYS, ServiceError, type Caller, type FirstSyncWindow, type FirstSyncWindowPatch } from "@usualmail/core";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import { inboxes } from "../db/index.ts";
import { requirePerson } from "./access.ts";
import type { Ctx } from "./context.ts";
import { check } from "./schemas.ts";

const PatchSchema = v.strictObject({
  days: v.pipe(
    v.number("days is a number"),
    v.integer("days is a whole number"),
    v.minValue(1, "days is 1 or more"),
    v.maxValue(FIRST_SYNC_MAX_DAYS, `days is at most ${FIRST_SYNC_MAX_DAYS}`),
  ),
}, "The first sync's window has one field, days");

function windowOf(ctx: Ctx): FirstSyncWindow {
  const { days, setBy, save } = ctx.firstSync;
  return { days, setBy, changeable: setBy !== "environment" && save !== null };
}

export function firstSyncWindow(ctx: Ctx, caller: Caller): FirstSyncWindow {
  requirePerson(caller, "see the first sync's window");
  return windowOf(ctx);
}

export async function updateFirstSyncWindow(ctx: Ctx, caller: Caller, input: FirstSyncWindowPatch): Promise<FirstSyncWindow> {
  requirePerson(caller, "change the first sync's window");
  const { days } = check(PatchSchema, input, "First sync");
  return ctx.lock.run(async () => {
    const current = ctx.firstSync;
    if (current.setBy === "environment") {
      throw new ServiceError("conflict", "USUAL_MAIL_SYNC_DAYS sets the first sync's window where this server starts; change it there");
    }
    if (current.save === null) throw new ServiceError("conflict", "This server keeps no settings, so the first sync's window can't be changed here");
    if (days === current.days && current.setBy === "settings") return windowOf(ctx);
    await current.save(days);
    Object.assign(ctx.firstSync, { days, setBy: "settings" as const });
    // A first sync still in progress narrows from its next sync: ask for one now.
    const running = await ctx.db.select({ id: inboxes.id }).from(inboxes).where(eq(inboxes.historyDone, false));
    for (const row of running) ctx.hooks.requestSync(row.id);
    return windowOf(ctx);
  });
}
