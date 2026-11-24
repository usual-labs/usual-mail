// Mail stored before the server asked the mailbox provider's checker about From domains (or while it carried no Public
// Suffix List) has no `fromCheck`. Once per start, in the background, the server asks the provider again for the mail
// that matters: in each inbox whose provider has a checker the server trusts (Gmail), every thread that isn't done,
// trashed or gone and had mail in the last 90 days, its sender's oldest and newest message (the thread's picture and
// the message a mail page opens on). Gmail's metadata form costs 20 quota units a message. What comes back is kept,
// the threads are settled, and one log line counts the outcomes, without an address or a domain: how many were proved,
// had Gmail's own result on top without proof, had it more than once, had another checker's on top, had none, or are
// gone. Those counts are how the owner's first start shows whether Gmail's own result really is on top (few "another
// checker" or "none") and how much mail came in some other way (forwarded twice, imported: "more than once").

import type { FromCheck } from "@usualmail/core";
import { and, asc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { inboxes, messages, threads } from "../db/index.ts";
import { inList } from "../db/params.ts";
import type { Ctx } from "../service/context.ts";
import { settleThreadAvatars } from "./settle.ts";

export const BACKFILL = { days: 90, chunk: 50 };

export interface BackfillCounts {
  asked: number;
  verified: number;
  /** The provider's own checker on top, proving nothing about the From domain. */
  unverified: number;
  otherChecker: number;
  /** The provider's own checker wrote more than one result: forwarded or imported mail. */
  repeated: number;
  noHeader: number;
  gone: number;
}

/** Asks again for what the provider's checker proved, for the mail that matters. `running()` false stops it between chunks. */
export async function backfillFromChecks(ctx: Ctx, running: () => boolean): Promise<BackfillCounts> {
  const counts: BackfillCounts = { asked: 0, verified: 0, unverified: 0, otherChecker: 0, repeated: 0, noHeader: 0, gone: 0 };
  if (!ctx.avatars) return counts;
  const since = ctx.now() - BACKFILL.days * 24 * 60 * 60_000;
  const open = await ctx.db.select({ id: inboxes.id }).from(inboxes).where(eq(inboxes.paused, false));
  for (const inbox of open) {
    if (!running()) break;
    const refs = await wanted(ctx, inbox.id, since);
    if (refs.size === 0) continue;
    let provider;
    try {
      provider = await ctx.hooks.provider(inbox.id);
    } catch {
      continue; // an inbox that can't be opened now is asked at the next start
    }
    if (!provider.fromChecks) continue;
    const list = [...refs.entries()];
    for (let at = 0; at < list.length && running(); at += BACKFILL.chunk) {
      const chunk = list.slice(at, at + BACKFILL.chunk);
      let checks: Map<string, FromCheck>;
      try {
        checks = await provider.fromChecks(chunk.map(([ref]) => ref));
      } catch (error) {
        ctx.host.log.error(`Sender pictures: the provider's checks couldn't be read for an inbox (${error instanceof Error ? error.name : "unknown"}); asked again at the next start`);
        break;
      }
      await ctx.lock.run(async () => {
        const settled = new Set<string>();
        for (const [ref, { id, threadId }] of chunk) {
          counts.asked++;
          const check = checks.get(ref);
          if (!check) {
            counts.gone++;
            continue;
          }
          if (check.result === "verified") counts.verified++;
          else if (check.result === "unverified") counts.unverified++;
          else if (check.result === "other_checker") counts.otherChecker++;
          else if (check.result === "repeated") counts.repeated++;
          else counts.noHeader++;
          await ctx.db.update(messages)
            .set({ fromCheck: check.result, fromVerified: check.result === "verified" ? check.domain : null })
            .where(and(eq(messages.id, id), isNull(messages.fromCheck)));
          if (check.result === "verified") settled.add(threadId);
        }
        await settleThreadAvatars(ctx, settled, { emit: true, want: "new" });
      });
    }
  }
  if (counts.asked > 0) {
    ctx.host.log.info(
      `Sender pictures: asked the mailbox provider again about ${counts.asked} stored message${counts.asked === 1 ? "" : "s"}: ` +
      `${counts.verified} proved, ${counts.unverified} with its own result on top proving nothing, ${counts.repeated} with its own ` +
      `result more than once, ${counts.otherChecker} with another checker's result on top, ${counts.noHeader} with no result at all, ` +
      `${counts.gone} no longer there.`,
    );
  }
  return counts;
}

/** The refs to ask about in an inbox, with their message and thread: each recent live thread's sender's oldest and newest message. */
async function wanted(ctx: Ctx, inboxId: string, since: number): Promise<Map<string, { id: string; threadId: string }>> {
  const rows = await ctx.db.select({ id: threads.id, sender: threads.sender }).from(threads).where(and(
    eq(threads.inboxId, inboxId), eq(threads.done, false), eq(threads.trashed, false), eq(threads.removed, false),
    gte(threads.lastMessageAt, since), isNotNull(threads.sender),
  ));
  const out = new Map<string, { id: string; threadId: string }>();
  for (let at = 0; at < rows.length; at += 500) {
    const part = rows.slice(at, at + 500);
    const sender = new Map(part.map((row) => [row.id, row.sender!]));
    const list = await ctx.db.select({ id: messages.id, threadId: messages.threadId, ref: messages.ref, from: messages.from, fromCheck: messages.fromCheck })
      .from(messages).where(and(inList(messages.threadId, part.map((row) => row.id)), eq(messages.outgoing, false)))
      .orderBy(asc(messages.date), asc(messages.id));
    for (const row of part) {
      const own = list.filter((m) => m.threadId === row.id && m.from.email.toLowerCase() === sender.get(row.id));
      for (const message of new Set([own[0], own.at(-1)])) {
        if (message && message.fromCheck === null) out.set(message.ref, { id: message.id, threadId: message.threadId });
      }
    }
  }
  return out;
}
