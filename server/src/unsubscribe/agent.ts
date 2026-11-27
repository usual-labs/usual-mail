// The browser agent's key (docs/contract.md, "Unsubscribing"; `AiSettings.browserAgent`): sealed in the server's own
// row like the AI's, bound to its own context so the two can't be swapped, never returned, logged or sent in an event.
// The settings say only which service and how it last answered. Saving a key tests it at once with a request that
// starts nothing; a run that the service refuses later (the key revoked, the credit spent) records that too.

import type { BrowserAgentCredentials, BrowserAgentSettings, BrowserAgentState } from "@usualmail/core";
import { ServiceError } from "@usualmail/core";
import { and, eq, inArray } from "drizzle-orm";
import { unsubscribes, type ServerStateRow } from "../db/index.ts";
import { readAiSettings } from "../ai/settings.ts";
import { loadState, saveState } from "../ai/state.ts";
import type { Ctx } from "../service/context.ts";
import { BrowserAgentError, BrowserUse } from "./browser-use.ts";

/** What the sealed key is bound to, so it can't be swapped with the AI's or an inbox's. */
const CREDENTIALS_CONTEXT = "browser-agent";

/** The settings' `browserAgent`: absent while no key is stored. A key not tested yet reads as working. */
export function readBrowserAgent(row: ServerStateRow): BrowserAgentSettings | undefined {
  if (row.browserAgentCredentials === null) return undefined;
  const state = row.browserAgentState ?? "working";
  return { service: "browser_use", state, ...(state !== "working" && row.browserAgentDetail && { detail: row.browserAgentDetail }) };
}

/** Demo mode sets up no browser agent: its senders are made up. */
export function assertBrowserAgentAllowed(ctx: Ctx): void {
  if (ctx.browserAgentAccess.off) throw new ServiceError("conflict", "Demo mode doesn't use a browser agent");
}

/**
 * Stops the runs `agent` has going (the inbox's alone when given), and those it may have started without the server
 * keeping their id: when its key is removed (before it is) or an inbox is, nothing is left running and billed for a
 * sender nobody waits on. Whatever Browser Use answers.
 */
export async function cancelAgentRuns(ctx: Ctx, agent: BrowserUse, inboxId?: string): Promise<void> {
  const rows = await ctx.db.select({ runId: unsubscribes.runId, marker: unsubscribes.marker, tried: unsubscribes.tried }).from(unsubscribes)
    .where(and(eq(unsubscribes.state, "working"), ...(inboxId ? [eq(unsubscribes.inboxId, inboxId)] : []), inArray(unsubscribes.step, ["start", "agent"])));
  for (const row of rows) {
    if (row.runId) await agent.cancel(row.runId);
    else if (row.marker && row.tried.includes("browser_agent")) await agent.cancelMarked(row.marker);
  }
}

/** The row's fields for new credentials, sealed, or for none. */
export async function browserAgentFields(
  ctx: Ctx,
  credentials: BrowserAgentCredentials | null,
): Promise<Pick<ServerStateRow, "browserAgentCredentials" | "browserAgentState" | "browserAgentDetail">> {
  return {
    browserAgentCredentials: credentials ? await ctx.host.secrets.seal(JSON.stringify(credentials), CREDENTIALS_CONTEXT) : null,
    browserAgentState: null,
    browserAgentDetail: null,
  };
}

/** The service with the stored key, or null when none is stored (or in demo mode, which uses none). */
export async function openBrowserAgent(ctx: Ctx, row: ServerStateRow): Promise<BrowserUse | null> {
  if (row.browserAgentCredentials === null || ctx.browserAgentAccess.off) return null;
  const credentials = JSON.parse(await ctx.host.secrets.open(row.browserAgentCredentials, CREDENTIALS_CONTEXT)) as BrowserAgentCredentials;
  return new BrowserUse(credentials.apiKey, ctx.browserAgentAccess);
}

/** Tests the stored key, if any, and records how the service answered. */
export async function testBrowserAgent(ctx: Ctx): Promise<void> {
  const agent = await ctx.lock.run(async () => openBrowserAgent(ctx, await loadState(ctx)));
  if (!agent) return;
  try {
    await agent.test();
    await recordBrowserAgent(ctx, "working");
  } catch (error) {
    const known = error instanceof BrowserAgentError ? error : new BrowserAgentError("unavailable", "The test of Browser Use failed in an unexpected way.");
    await recordBrowserAgent(ctx, known.state, known.message);
  }
}

/**
 * Records how the browser agent's service answered, under the lock, and tells people's devices when that changed what
 * the settings say. Nothing is recorded once the key is gone.
 */
export async function recordBrowserAgent(ctx: Ctx, state: BrowserAgentState, detail?: string): Promise<void> {
  await ctx.lock.run(async () => {
    const row = await loadState(ctx);
    if (row.browserAgentCredentials === null) return;
    const shown = readBrowserAgent(row);
    const next = { browserAgentState: state, browserAgentDetail: state === "working" ? null : detail ?? null };
    if (row.browserAgentState === next.browserAgentState && row.browserAgentDetail === next.browserAgentDetail) return;
    await saveState(ctx, { ...next, settingsVersion: row.settingsVersion + 1 });
    const after = readBrowserAgent({ ...row, ...next });
    if (JSON.stringify(after) === JSON.stringify(shown)) return;
    // The settings as a whole, as every change to them is told.
    ctx.emit({ type: "ai.settings.changed", settings: await readAiSettings(ctx) });
  });
}
