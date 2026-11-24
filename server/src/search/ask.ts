// A search asked in a sentence (docs/contract-search.md, "Asking in a sentence"): the summarize job's model turns it
// into the filters and text a search takes. Person only. One request, never sent twice, given up on after a few
// seconds; only the sentence and today's date leave the server (`ask-words.ts`). The answer searches nothing and
// returns no mail. Whatever the AI does, what comes back is a search that can be run: the sentence as if it had been
// typed, when the AI isn't set up, is paused, is waiting after a failure, fails now, or gives nothing usable.

import { ServiceError, type AiState, type Caller, type SearchAskInput, type SearchAskResult, type SearchUnderstood } from "@usualmail/core";
import { AiServiceError, type AiObjectAnswer } from "../ai/models.ts";
import { boundaryId, sentDay } from "../ai/prompt.ts";
import { effectiveModels, loadState, mayRun, openCredentials } from "../ai/state.ts";
import { currentStatus, recordAnswer, recordFailure } from "../ai/status.ts";
import { recordUsage } from "../ai/usage.ts";
import { requirePerson } from "../service/access.ts";
import type { Ctx } from "../service/context.ts";
import { check, SearchAskSchema } from "../service/schemas.ts";
import { askRequest, checkAsk, oneLine } from "./ask-words.ts";
import { prepare, zoneOf } from "./local.ts";

/** How many sentences one device may ask in a minute: each is a request to the person's AI account. */
export const ASK_PER_MINUTE = 10;
/** How long the server waits for the model before it answers with the sentence as typed. */
export const ASK_TIMEOUT_MS = 15_000;
const MINUTE = 60_000;

/** When each device asked in the last minute, per server. In memory: a restart forgets it. */
const asked = new WeakMap<Ctx, Map<string, number[]>>();

export async function askSearch(ctx: Ctx, caller: Caller, input: SearchAskInput): Promise<SearchAskResult> {
  requirePerson(caller, "ask search in a sentence");
  const given = check(SearchAskSchema, input, "Ask");
  const question = oneLine(given.question);
  if (!question) throw new ServiceError("invalid", "Ask needs a sentence");
  const scope = { ...(given.inboxIds && { inboxIds: given.inboxIds }), ...(given.tz !== undefined && { tz: given.tz }) };
  // The sentence as if it had been typed: what stands when the AI can't help. It also checks the inboxes and the zone.
  const typed = (await prepare(ctx, caller, { q: question, ...scope })).parsed.understood;
  const zone = zoneOf(given.tz, ctx.host.timeZone);
  const asTyped = (ai: AiState, detail?: string): SearchAskResult => result(typed, false, ai, detail);

  const row = await loadState(ctx);
  if (!mayRun(row, ctx.now()).ok) {
    // Not set up, paused, or waiting after a failure: nothing is sent.
    const status = await currentStatus(ctx);
    return asTyped(status.state === "working" ? "unavailable" : status.state, status.detail);
  }
  const credentials = await openCredentials(ctx, row);
  const model = effectiveModels(ctx, row)?.summarize;
  if (!credentials || !model) return asTyped("not_set_up", "Set an AI key to have mail categorized and summarized.");
  limitRate(ctx, caller);

  const request = askRequest(model, question, boundaryId(ctx.host.random.bytes(9)), sentDay(ctx.now(), zone));
  const abort = new AbortController();
  let cancel = () => {};
  const tooLong = new Promise<"too_long">((resolve) => {
    cancel = ctx.host.scheduler.setTimer(ASK_TIMEOUT_MS, () => resolve("too_long"));
  });
  const sent = ctx.models.open(credentials).extract({ ...request, signal: abort.signal });
  // A request given up on still ends by itself; nothing waits on it but a stop.
  ctx.background(sent.catch(() => undefined));
  let answer: AiObjectAnswer | "too_long";
  try {
    answer = await Promise.race([sent, tooLong]);
  } catch (error) {
    await recordUsage(ctx, "ask", model, { failed: true });
    // Only a service error's own words are kept, as for mail: never the error, which may hold what was sent.
    const known = error instanceof AiServiceError ? error : new AiServiceError("unavailable", "The AI request failed in an unexpected way.");
    await ctx.lock.run(() => recordFailure(ctx, known, "summarize"));
    return asTyped(known.failure, (await currentStatus(ctx)).detail);
  } finally {
    cancel();
  }
  if (answer === "too_long") {
    abort.abort();
    await recordUsage(ctx, "ask", model, { failed: true });
    return asTyped("unavailable", "The AI took too long to answer, so the sentence is searched as typed.");
  }
  await recordUsage(ctx, "ask", model, { usage: answer.usage, generation: answer.generation ?? null });
  await ctx.lock.run(() => recordAnswer(ctx, false));

  const checked = checkAsk(answer.value, question, zone, ctx.now());
  // By field and reason only: never what the person or the model wrote.
  if (checked.dropped.length) ctx.host.log.info(`AI search ask dropped ${checked.dropped.join(", ")}`);
  if (!checked.usable || Object.keys(checked.query).length === 0) return asTyped("working");
  let understood: SearchUnderstood;
  try {
    // The same parser and limits a typed search goes through.
    understood = (await prepare(ctx, caller, { ...checked.query, ...scope })).parsed.understood;
  } catch (error) {
    if (error instanceof ServiceError && error.code === "invalid") return asTyped("working");
    throw error;
  }
  const { text: _text, inboxIds: _inboxIds, ...filters } = understood;
  return result(understood, Object.keys(filters).length > 0, "working");
}

/** `text` is what stands in the search field: the free text, then each word to leave out with its minus. */
function result(understood: SearchUnderstood, found: boolean, ai: AiState, detail?: string): SearchAskResult {
  const left = (understood.exclude ?? []).map((word) => (/\s/.test(word) ? `-"${word}"` : `-${word}`));
  return { understood, text: [understood.text, ...left].filter(Boolean).join(" "), found, ai, ...(detail && { detail }) };
}

/** At most `ASK_PER_MINUTE` sentences per device a minute; `rate_limited` beyond, with the wait. */
function limitRate(ctx: Ctx, caller: Caller): void {
  const device = caller.actor.kind === "person" ? caller.actor.deviceId : "-";
  let byDevice = asked.get(ctx);
  if (!byDevice) asked.set(ctx, byDevice = new Map());
  const now = ctx.now();
  const recent = (byDevice.get(device) ?? []).filter((at) => at > now - MINUTE);
  if (recent.length >= ASK_PER_MINUTE) {
    const retryAfter = Math.max(1, Math.ceil((recent[0]! + MINUTE - now) / 1000));
    throw new ServiceError("rate_limited", "Too many sentences asked in a minute; try again shortly, or search by typing", { retryAfter });
  }
  recent.push(now);
  byDevice.set(device, recent);
}
