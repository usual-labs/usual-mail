// The server's own row: the AI's settings with its sealed key, how the service last answered, and the counts'
// version. Helpers that read it for the rest of the AI's code. Callers hold `ctx.lock` when they write.

import { AI_JOBS, type AiCredentials, type AiJob } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { serverState, type InboxRow, type ServerStateRow } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";

/** What the sealed credentials are bound to, so they can't be swapped with an inbox's. */
const CREDENTIALS_CONTEXT = "ai-settings";

export async function loadState(ctx: Ctx): Promise<ServerStateRow> {
  const row = await ctx.db.select().from(serverState).where(eq(serverState.id, 1)).get();
  if (row) return row;
  await ctx.db.insert(serverState).values({ id: 1 }).onConflictDoNothing();
  return (await ctx.db.select().from(serverState).where(eq(serverState.id, 1)).get())!;
}

export async function saveState(ctx: Ctx, patch: Partial<Omit<ServerStateRow, "id">>): Promise<void> {
  await loadState(ctx);
  await ctx.db.update(serverState).set(patch).where(eq(serverState.id, 1));
}

export function sealCredentials(ctx: Ctx, credentials: AiCredentials): Promise<string> {
  return ctx.host.secrets.seal(JSON.stringify(credentials), CREDENTIALS_CONTEXT);
}

/** The stored credentials, opened, or null when none are set. */
export async function openCredentials(ctx: Ctx, row: ServerStateRow): Promise<AiCredentials | null> {
  if (row.aiCredentials === null) return null;
  return JSON.parse(await ctx.host.secrets.open(row.aiCredentials, CREDENTIALS_CONTEXT)) as AiCredentials;
}


/** The model each job uses: the one the person chose, or the server's default for the service. */
export function effectiveModels(ctx: Ctx, row: ServerStateRow): Record<AiJob, string> | null {
  if (!row.aiService) return null;
  const defaults = ctx.models.defaults(row.aiService);
  return Object.fromEntries(AI_JOBS.map((job) => [job, row.aiModels[job] ?? defaults[job]])) as Record<AiJob, string>;
}

/**
 * Whether the AI may send anything now: credentials set, not paused, and not waiting after a failure. `retryAt` says
 * when a wait ends.
 */
export function mayRun(row: ServerStateRow, now: number): { ok: true } | { ok: false; retryAt: number | null } {
  if (row.aiCredentials === null || row.aiPaused) return { ok: false, retryAt: null };
  if (row.aiState !== null && row.aiState !== "working" && row.aiRetryAt !== null && row.aiRetryAt > now) {
    return { ok: false, retryAt: row.aiRetryAt };
  }
  return { ok: true };
}

/** Whether the AI may process mail at this moment: a key set, not paused, not in a failure's wait. Every inbox alike. */
export async function mayProcess(ctx: Ctx): Promise<boolean> {
  return mayRun(await loadState(ctx), ctx.now()).ok;
}
