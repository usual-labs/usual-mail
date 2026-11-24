// Once per store at a start, by rule only (`MOMENT_PASS`, 2026-11-19, after the audit of the groups): every stored
// notification's key and group worked out again as new events now get them (event-group.ts: a reference's key stays;
// else the key of the sender's notification about the same moment, or its own), and a limit's stored time that the mail
// writes after a word for resetting dropped as `checkEvent` now drops it (with the date, unless it is the mail's own
// day). No model is asked and nothing is read from a provider. Each thread whose served event changes gets a new version
// and a `thread.changed`; one whose key alone changes is written without. Logs counts only. Under the lock.

import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { messages, threads } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { emitThread, getThread } from "../service/store.ts";
import { groupFor, momentKeyAmong, momentOf, withGroup, type Keyed } from "./event-group.ts";
import { resetTimes } from "./event-times.ts";
import { limitLike } from "./event.ts";
import { hadRulePass, MOMENT_PASS } from "./passes.ts";
import { serverTimeZone, zonedDate } from "./payment-dates.ts";
import { senderKey } from "./payment-store.ts";
import { loadState, saveState } from "./state.ts";
import { modelText } from "./text.ts";

export async function regroupEventsOnce(ctx: Ctx, id: string = MOMENT_PASS): Promise<{ changed: number; resets: number }> {
  const counts = { changed: 0, resets: 0 };
  if (hadRulePass((await loadState(ctx)).paymentRulesApplied, id)) return counts;
  const zone = serverTimeZone(ctx.host.timeZone);
  const rows = await ctx.db.select().from(threads)
    .where(and(eq(threads.category, "notification"), eq(threads.removed, false), isNotNull(threads.event)))
    .orderBy(asc(threads.lastMessageAt), asc(threads.id));
  const keyed: Keyed[] = [];
  for (const row of rows) {
    let event = withGroup(row.event!, null);
    if (event.when?.time && limitLike(event.status) && resetTimes(await threadText(ctx, row.id, row.subject)).has(event.when.time)) {
      event = { ...event, when: event.when.date === zonedDate(row.lastMessageAt, zone) ? { date: event.when.date, time: null, endTime: null } : null };
      counts.resets++;
    }
    const sender = row.sender && (senderKey(row.sender, ctx.avatars?.suffixes ?? null) ?? row.sender.split("@").at(-1)!);
    const moment = sender && !row.eventKey?.startsWith("r") ? momentOf(event, row.lastMessageAt, zone) : null;
    const key = row.eventKey?.startsWith("r") ? row.eventKey : moment && sender ? await momentKeyAmong(ctx, row, moment, sender, keyed) : null;
    keyed.push({ ...row, event, eventKey: key });
  }
  const dates = new Map<string, number[]>();
  for (const each of keyed) if (each.eventKey) dates.set(`${each.inboxId}\n${each.eventKey}`, [...dates.get(`${each.inboxId}\n${each.eventKey}`) ?? [], each.lastMessageAt]);
  for (const [index, each] of keyed.entries()) {
    const row = rows[index]!;
    const next = withGroup(each.event!, each.eventKey && groupFor(each.eventKey, dates.get(`${each.inboxId}\n${each.eventKey}`)!));
    if (JSON.stringify(next) !== JSON.stringify(row.event)) {
      await ctx.db.update(threads).set({ event: next, eventKey: each.eventKey, version: sql`${threads.version} + 1` }).where(eq(threads.id, row.id));
      emitThread(ctx, (await getThread(ctx, row.id))!);
      counts.changed++;
    } else if (each.eventKey !== row.eventKey) {
      await ctx.db.update(threads).set({ eventKey: each.eventKey }).where(eq(threads.id, row.id));
    }
  }
  await saveState(ctx, { paymentRulesApplied: id });
  if (counts.changed > 0) {
    ctx.host.log.info(`Notification groups by rule: ${counts.changed} threads changed, ${counts.resets} reset time${counts.resets === 1 ? "" : "s"} dropped`);
  }
  return counts;
}

/** What the model was given of a thread, near enough for the reset rule: its subject and each message as a model reads it. */
async function threadText(ctx: Ctx, threadId: string, subject: string): Promise<string> {
  const list = await ctx.db.select({ text: messages.text, html: messages.html }).from(messages).where(eq(messages.threadId, threadId));
  return [subject, ...list.map((message) => modelText(message.text, message.html))].join("\n");
}
