// Every stored thread's snippet made again by today's rule (`snippetText` in ai/text.ts), once per store at a start
// (`SNIPPET_PASS`, 2026-11-19, after the Inbox page showed raw links, leftover HTML and entities): from the stored
// message text and HTML only, no provider read and no AI request. A thread whose snippet changes gets a new version;
// one that isn't done also a `thread.changed`, a done one changes silently. Logs counts only. Under the lock.

import { and, asc, eq, gt, sql } from "drizzle-orm";
import { threads } from "../db/index.ts";
import { hadRulePass, SNIPPET_PASS } from "../ai/passes.ts";
import { loadState, saveState } from "../ai/state.ts";
import { threadSnippet } from "../sync/rows.ts";
import type { Ctx } from "./context.ts";
import { blockedSenders, emitThread, getThread } from "./store.ts";

export async function remakeSnippetsOnce(ctx: Ctx, id: string = SNIPPET_PASS): Promise<{ changed: number; silent: number }> {
  const counts = { changed: 0, silent: 0 };
  if (hadRulePass((await loadState(ctx)).paymentRulesApplied, id)) return counts;
  const blocked = new Map<string, Set<string>>();
  let after = "";
  for (;;) {
    const page = await ctx.db.select({ id: threads.id, inboxId: threads.inboxId, sender: threads.sender, snippet: threads.snippet, done: threads.done })
      .from(threads).where(and(eq(threads.removed, false), gt(threads.id, after))).orderBy(asc(threads.id)).limit(500);
    if (page.length === 0) break;
    after = page.at(-1)!.id;
    for (const row of page) {
      if (!blocked.has(row.inboxId)) blocked.set(row.inboxId, await blockedSenders(ctx, row.inboxId));
      const snippet = await threadSnippet(ctx, row, blocked.get(row.inboxId)!);
      if (snippet === null || snippet === row.snippet) continue;
      await ctx.db.update(threads).set({ snippet, version: sql`${threads.version} + 1` }).where(eq(threads.id, row.id));
      counts.changed++;
      if (row.done) counts.silent++;
      else emitThread(ctx, (await getThread(ctx, row.id))!);
    }
  }
  await saveState(ctx, { paymentRulesApplied: id });
  if (counts.changed > 0) ctx.host.log.info(`Snippets made plain: ${counts.changed} threads (${counts.silent} done, changed silently)`);
  return counts;
}
