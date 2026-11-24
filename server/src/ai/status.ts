// The AI's status (docs/contract-ai.md, "Status"): whether it works, why not, and how much is left. Failures stop
// processing for a while: a refused key, a missing model or no credit for an hour or until a person changes the
// settings or tests; an unavailable service with growing pauses from a minute up to 15 minutes. Any answer makes it
// working again. Callers hold `ctx.lock`.

import type { AiJob, AiState, AiStatus } from "@usualmail/core";
import { iso } from "../util.ts";
import type { Ctx } from "../service/context.ts";
import { scrubKey, type AiServiceError } from "./models.ts";
import { loadState, openCredentials, saveState } from "./state.ts";
import { pendingWork } from "./work.ts";

const MINUTE = 60_000;
/** The pauses after the service was unavailable that many times in a row. */
const UNAVAILABLE_WAITS = [1, 2, 4, 8, 15].map((minutes) => minutes * MINUTE);
/** How long a refused key, a missing model or no credit stops processing before one request is tried again. */
export const STOPPED_WAIT = 60 * MINUTE;

/** The status as it is now, without its version. */
export async function currentStatus(ctx: Ctx): Promise<Omit<AiStatus, "version">> {
  const row = await loadState(ctx);
  let state: AiState;
  if (row.aiCredentials === null) state = "not_set_up";
  else if (row.aiPaused) state = "paused";
  else state = row.aiState ?? "working";
  const status: Omit<AiStatus, "version"> = { state, ...(await pendingWork(ctx)) };
  if (state === "not_set_up") status.detail = "Set an AI key to have mail categorized and summarized.";
  else if (state === "paused") status.detail = "The AI is paused: no mail is sent to it.";
  else if (state !== "working" && row.aiDetail) status.detail = row.aiDetail;
  if (state === "model_not_found" && row.aiJob) status.job = row.aiJob;
  if (row.aiLastRunAt !== null) status.lastRunAt = iso(row.aiLastRunAt);
  return status;
}

/** The service answered. `processed` says whether it was about a thread (not a test). */
export async function recordAnswer(ctx: Ctx, processed: boolean): Promise<void> {
  const row = await loadState(ctx);
  const patch = {
    aiState: "working" as const,
    aiDetail: null,
    aiJob: null,
    aiRetryAt: null,
    aiFailures: 0,
    ...(processed && { aiLastRunAt: ctx.now() }),
  };
  const same = row.aiState === "working" && row.aiDetail === null && row.aiJob === null && row.aiRetryAt === null && row.aiFailures === 0;
  if (same && !processed) return;
  await saveState(ctx, patch);
  ctx.changes.touch();
}

/**
 * The service refused or couldn't be reached: the status says why, and processing waits. What it says never holds the
 * key or a part of it (`scrubKey`), whatever the service repeated.
 */
export async function recordFailure(ctx: Ctx, error: AiServiceError, job: AiJob): Promise<void> {
  const row = await loadState(ctx);
  const key = (await openCredentials(ctx, row).catch(() => null))?.apiKey;
  const failures = error.failure === "unavailable" ? row.aiFailures + 1 : 1;
  const wait = error.failure === "unavailable" ? UNAVAILABLE_WAITS[Math.min(failures, UNAVAILABLE_WAITS.length) - 1]! : STOPPED_WAIT;
  await saveState(ctx, {
    aiState: error.failure,
    aiDetail: scrubKey(error.message, key) || null,
    aiJob: error.failure === "model_not_found" ? job : null,
    aiRetryAt: ctx.now() + wait,
    aiFailures: failures,
  });
  ctx.changes.touch();
}

/** A person changed the settings or tests: whatever stopped processing is forgotten until the service answers again. */
export function freshStart(): { aiState: null; aiDetail: null; aiJob: null; aiRetryAt: null; aiFailures: number } {
  return { aiState: null, aiDetail: null, aiJob: null, aiRetryAt: null, aiFailures: 0 };
}
