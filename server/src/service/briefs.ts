// Briefs: the caller writes summaries and highlights; the server counts what was handled in the period and
// leaves out inboxes the caller can't see.

import { ServiceError, type Brief, type BriefInput, type BriefSection, type Caller } from "@usualmail/core";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { actions, briefs, inboxes, threads, type BriefRow } from "../db/index.ts";
import { inList } from "../db/params.ts";
import { parseTime, unique } from "../util.ts";
import { isPerson, mayRead } from "./access.ts";
import type { Ctx } from "./context.ts";
import { toBrief } from "./rows.ts";
import { BriefInputSchema, check } from "./schemas.ts";

/**
 * How many threads rules and agents handled in an inbox in the period, by where each is now: its category, plus
 * "done" when it is done; trashed threads count only as "trash". Silent records, and so the AI's, don't count.
 */
export async function countHandled(ctx: Ctx, inboxId: string, from: number, to: number): Promise<BriefSection["counts"]> {
  const handledIds = await ctx.db.selectDistinct({ id: actions.threadId }).from(actions).where(and(
    eq(actions.inboxId, inboxId),
    eq(actions.state, "applied"),
    inArray(actions.actorKind, ["rule", "agent"]),
    eq(actions.silent, false),
    gte(actions.at, from),
    lte(actions.at, to),
  ));
  if (handledIds.length === 0) return {};
  const rows = await ctx.db.select({ category: threads.category, done: threads.done, trashed: threads.trashed })
    .from(threads).where(inList(threads.id, handledIds.map((row) => row.id)));
  const counts: BriefSection["counts"] = {};
  const add = (key: keyof BriefSection["counts"]) => (counts[key] = (counts[key] ?? 0) + 1);
  for (const row of rows) {
    if (row.trashed) {
      add("trash");
      continue;
    }
    add(row.category);
    if (row.done) add("done");
  }
  return counts;
}

async function visibleIds(ctx: Ctx, caller: Caller): Promise<Set<string>> {
  const rows = await ctx.db.select().from(inboxes);
  return new Set(rows.filter((row) => mayRead(caller, row)).map((row) => row.id));
}

function forCaller(row: BriefRow, visible: Set<string>, person: boolean): Brief | null {
  const sections = row.sections.filter((section) => visible.has(section.inboxId));
  if (!person && sections.length === 0) return null;
  return { ...toBrief(row), sections };
}

export async function writeBrief(ctx: Ctx, caller: Caller, input: BriefInput): Promise<Brief> {
  const data = check(BriefInputSchema, input, "Brief");
  const from = parseTime(data.from, "from");
  const to = parseTime(data.to, "to");
  if (from >= to) throw new ServiceError("invalid", "from must be before to");
  const ids = data.sections.map((section) => section.inboxId);
  if (unique(ids).length !== ids.length) throw new ServiceError("invalid", "Each inbox can have one section");
  const visible = await visibleIds(ctx, caller);
  const sections: BriefSection[] = [];
  for (const section of data.sections) {
    if (!visible.has(section.inboxId)) continue;
    const threadIds = section.highlights.map((h) => h.threadId);
    const found = threadIds.length
      ? await ctx.db.select({ id: threads.id, subject: threads.subject }).from(threads)
        .where(and(eq(threads.inboxId, section.inboxId), inArray(threads.id, threadIds)))
      : [];
    const subjects = new Map(found.map((row) => [row.id, row.subject]));
    const missing = threadIds.filter((id) => !subjects.has(id));
    if (missing.length) throw new ServiceError("invalid", `Highlights name threads not in ${section.inboxId}: ${missing.join(", ")}`);
    const out: BriefSection = {
      inboxId: section.inboxId,
      counts: await countHandled(ctx, section.inboxId, from, to),
      // Each highlight says its thread's subject as it is now, when the brief is written.
      highlights: section.highlights.map((h) => ({ threadId: h.threadId, subject: subjects.get(h.threadId)!, line: h.line })),
    };
    if (section.summary !== undefined) out.summary = section.summary;
    sections.push(out);
  }
  const row: BriefRow = { id: ctx.id("brf"), createdAt: ctx.now(), from, to, sections, writtenBy: caller.actor };
  await ctx.db.insert(briefs).values(row);
  ctx.briefInboxes.set(row.id, sections.map((section) => section.inboxId));
  if (ctx.briefInboxes.size > 200) ctx.briefInboxes.delete(ctx.briefInboxes.keys().next().value!);
  ctx.emit({ type: "brief.ready", briefId: row.id });
  return toBrief(row);
}

export async function latestBrief(ctx: Ctx, caller: Caller): Promise<Brief | null> {
  const visible = await visibleIds(ctx, caller);
  const person = isPerson(caller);
  // Newest first, a page at a time, until one has something this caller may see.
  for (let offset = 0; ; offset += 50) {
    const rows = await ctx.db.select().from(briefs)
      .orderBy(desc(briefs.createdAt), desc(sql`${briefs}.rowid`)).limit(50).offset(offset);
    for (const row of rows) {
      const brief = forCaller(row, visible, person);
      if (brief) return brief;
    }
    if (rows.length < 50) return null;
  }
}

export async function brief(ctx: Ctx, caller: Caller, id: string): Promise<Brief> {
  const row = await ctx.db.select().from(briefs).where(eq(briefs.id, id)).get();
  const brief = row && forCaller(row, await visibleIds(ctx, caller), isPerson(caller));
  if (!brief) throw new ServiceError("not_found", "No such brief");
  return brief;
}
