// The AI's settings (docs/contract-ai.md, "Jobs and settings"), for a person only. Credentials are sealed like
// mailbox credentials and never returned, logged or sent in an event: the settings say only whether they are set.
// Setting them is the person's consent to every inbox's mail going to that service (there is no per-inbox switch);
// moving to another gateway or provider puts the jobs back on its defaults unless the same change names models;
// removing them stops all processing. New credentials or models are stored first, then tested at once. The words to
// show before a key is saved come from here too (`aiDisclosureFor`), built by core.

import {
  AI_GATEWAYS,
  AI_JOBS,
  AI_PROVIDERS,
  BROWSER_AGENT_SERVICES,
  aiDisclosure,
  ServiceError,
  type AiConnection,
  type AiDisclosure,
  type AiJob,
  type AiSettings,
  type AiSettingsPatch,
  type AiStatus,
  type Caller,
} from "@usualmail/core";
import * as v from "valibot";
import { requirePerson } from "../service/access.ts";
import type { Ctx } from "../service/context.ts";
import { AiServiceError, connectionOf, sameService } from "./models.ts";
import { dataBlock, CATEGORY_OPTIONS, boundaryId, categorizeInstructions } from "./prompt.ts";
import { effectiveModels, loadState, openCredentials, saveState, sealCredentials } from "./state.ts";
import { freshStart, recordAnswer, recordFailure } from "./status.ts";
import { recordUsage } from "./usage.ts";
import { assertBrowserAgentAllowed, browserAgentFields, cancelAgentRuns, openBrowserAgent, readBrowserAgent, testBrowserAgent } from "../unsubscribe/agent.ts";

// Every message here is the server's own words: a wrong value is never repeated back, so a key can't be.
const apiKey = v.pipe(
  v.string("apiKey must be text"),
  v.trim(),
  v.minLength(1, "apiKey is empty"),
  v.maxLength(1000, "apiKey is too long"),
  v.regex(/^[\x21-\x7e]+$/, "apiKey must be one word of printable characters"),
);
const credentialsSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("gateway"), gateway: v.picklist(AI_GATEWAYS, `gateway must be ${AI_GATEWAYS.join(" or ")}`), apiKey }),
  v.strictObject({ kind: v.literal("direct"), provider: v.picklist(AI_PROVIDERS, `provider must be ${AI_PROVIDERS.join(" or ")}`), apiKey }),
], 'credentials must be { "kind": "gateway", "gateway", "apiKey" }, { "kind": "direct", "provider", "apiKey" } or null');
const modelId = v.nullable(v.pipe(
  v.string("a model is text or null"),
  v.trim(),
  v.minLength(1, "a model can't be empty; null means the default"),
  v.maxLength(200, "a model's name is at most 200 characters"),
  v.regex(/^[A-Za-z0-9._:/@+-]+$/, "a model is named as the service names it, like provider/model"),
));
const browserAgentSchema = v.strictObject({
  service: v.picklist(BROWSER_AGENT_SERVICES, `service must be ${BROWSER_AGENT_SERVICES.join(" or ")}`),
  apiKey,
}, 'browserAgent must be { "service": "browser_use", "apiKey" } or null');
const patchSchema = v.strictObject({
  credentials: v.optional(v.nullable(credentialsSchema)),
  models: v.optional(v.strictObject({ categorize: v.optional(modelId), summarize: v.optional(modelId) }, "models names categorize and summarize only")),
  paused: v.optional(v.boolean("paused is true or false")),
  browserAgent: v.optional(v.nullable(browserAgentSchema)),
}, "The AI settings' fields are credentials, models, paused and browserAgent");

function checkPatch(input: unknown): AiSettingsPatch {
  const result = v.safeParse(patchSchema, input);
  if (result.success) return result.output as AiSettingsPatch;
  // Only the schema's own messages and the field names: never a value that was sent.
  const problems = result.issues.map((issue) => {
    const path = issue.path?.map((item) => String(item.key)).filter((key) => /^[A-Za-z]+$/.test(key)).join(".");
    return path ? `${path}: ${issue.message.replace(/".*"/g, "that")}` : issue.message.replace(/received ".*"$/, "received something else");
  });
  throw new ServiceError("invalid", `AI settings: ${problems.join("; ")}`);
}

/** The settings as a person's device sees them. Under the lock or not. */
export async function readAiSettings(ctx: Ctx): Promise<AiSettings> {
  const row = await loadState(ctx);
  const set = row.aiCredentials !== null && row.aiService !== null;
  const defaults = set ? ctx.models.defaults(row.aiService!) : null;
  const browserAgent = readBrowserAgent(row);
  return {
    ...(set && { connection: structuredClone(row.aiService!) }),
    credentialsSet: set,
    jobs: AI_JOBS.map((job) => ({ job, model: row.aiModels[job] ?? null, defaultModel: defaults?.[job] ?? "" })),
    paused: row.aiPaused,
    ...(browserAgent && { browserAgent }),
    version: row.settingsVersion,
  };
}

const connectionSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("gateway"), gateway: v.picklist(AI_GATEWAYS, `gateway is ${AI_GATEWAYS.join(" or ")}`) }),
  v.strictObject({ kind: v.literal("direct"), provider: v.picklist(AI_PROVIDERS, `provider is ${AI_PROVIDERS.join(" or ")}`) }),
], "Name the service: gateway=vercel, provider=openai or provider=anthropic");

/**
 * What saving a key for `connection` would send, and to whom: core's words, with the models that would do each job
 * there (the person's chosen ones for the service already set, otherwise its defaults). Person only; no credentials
 * needed.
 */
export async function aiDisclosureFor(ctx: Ctx, caller: Caller, input: AiConnection): Promise<AiDisclosure> {
  requirePerson(caller, "read what the AI would be sent");
  const result = v.safeParse(connectionSchema, input);
  if (!result.success) throw new ServiceError("invalid", result.issues[0]?.message ?? "Name the service");
  const connection = result.output as AiConnection;
  const row = await loadState(ctx);
  const defaults = ctx.models.defaults(connection);
  const chosen = sameService(row.aiService, connection) ? row.aiModels : {};
  return aiDisclosure({
    connection,
    jobs: AI_JOBS.map((job) => ({ job, model: chosen[job] ?? null, defaultModel: defaults[job] })),
  });
}

export async function aiSettings(ctx: Ctx, caller: Caller): Promise<AiSettings> {
  requirePerson(caller, "see the AI's settings");
  return readAiSettings(ctx);
}

export async function updateAiSettings(ctx: Ctx, caller: Caller, input: AiSettingsPatch): Promise<AiSettings> {
  requirePerson(caller, "change the AI's settings");
  const patch = checkPatch(input);
  if (patch.browserAgent) assertBrowserAgentAllowed(ctx);
  // A key replaced or removed stops what its runs are doing first, while the key still reaches them.
  if (patch.browserAgent !== undefined) {
    const old = await ctx.lock.run(async () => openBrowserAgent(ctx, await loadState(ctx)));
    if (old) await cancelAgentRuns(ctx, old);
  }
  const { test, testAgent } = await ctx.lock.run(async () => {
    const row = await loadState(ctx);
    const next = { ...row, aiModels: { ...row.aiModels } };
    let test = false;
    if (patch.credentials === null) {
      if (row.aiCredentials !== null) {
        // Removing the key stops all processing: the mail would go nowhere the person chose any more.
        next.aiCredentials = null;
        Object.assign(next, freshStart());
      }
    } else if (patch.credentials !== undefined) {
      const connection = connectionOf(patch.credentials);
      // Saving a key is the person's consent to every inbox's mail going to that service, now and later. Another
      // gateway or provider takes its defaults unless this change names models; a new key for the same one keeps them.
      if (!sameService(row.aiService, connection) && patch.models === undefined) next.aiModels = {};
      next.aiService = connection;
      next.aiCredentials = await sealCredentials(ctx, patch.credentials);
      Object.assign(next, freshStart());
      test = true;
    }
    if (patch.models !== undefined) {
      for (const job of AI_JOBS) {
        const model = patch.models[job];
        if (model === undefined || (next.aiModels[job] ?? null) === model) continue;
        next.aiModels[job] = model;
        Object.assign(next, freshStart());
        test = true;
      }
    }
    if (patch.paused !== undefined) next.aiPaused = patch.paused;
    // The browser agent's key, apart from the AI's: a new one is tested at once; none stops it being used.
    if (patch.browserAgent !== undefined && (patch.browserAgent !== null || row.browserAgentCredentials !== null)) {
      Object.assign(next, await browserAgentFields(ctx, patch.browserAgent));
    }
    const fields = ["aiCredentials", "aiService", "aiPaused", "browserAgentCredentials"] as const;
    const changed = fields.some((key) => JSON.stringify(next[key]) !== JSON.stringify(row[key]))
      || JSON.stringify(next.aiModels) !== JSON.stringify(row.aiModels);
    if (changed) {
      next.settingsVersion = row.settingsVersion + 1;
      const { id: _id, ...rest } = next;
      await saveState(ctx, rest);
    }
    if (changed) ctx.emit({ type: "ai.settings.changed", settings: await readAiSettings(ctx) });
    return { test: test && next.aiCredentials !== null, testAgent: Boolean(patch.browserAgent) };
  });
  if (test) await runTest(ctx);
  if (testAgent) await testBrowserAgent(ctx);
  ctx.aiQueue.wake();
  // Resuming, a new key or none: the cost lookups carry on, or drop what waits.
  ctx.costLookups.wake();
  return readAiSettings(ctx);
}

/** Person only: one small request per job's model, with no mail in it, and the status that follows. */
export async function testAi(ctx: Ctx, caller: Caller, status: () => Promise<AiStatus>): Promise<AiStatus> {
  requirePerson(caller, "test the AI");
  await runTest(ctx);
  ctx.aiQueue.wake();
  ctx.costLookups.wake();
  return status();
}

/** The test itself: no mail, a fixed sentence. The first job that fails says why in the status. */
async function runTest(ctx: Ctx): Promise<void> {
  const row = await ctx.lock.run(() => loadState(ctx));
  const credentials = await openCredentials(ctx, row);
  const models = effectiveModels(ctx, row);
  if (!credentials || !models) return;
  const open = ctx.models.open(credentials);
  const sample = (id: string) => dataBlock([{ subject: "A test from Usual Mail", text: "This is a test. It holds no mail." }], id);
  for (const job of AI_JOBS) {
    const id = boundaryId(ctx.host.random.bytes(9));
    try {
      // A model that can't do its job (on a gateway: categorizing needs a decision model) fails the test in words.
      const unfit = await open.fitFor?.(job, models[job]);
      if (unfit) throw new AiServiceError("model_not_found", unfit, { unfit: true });
      // A test's request counts in the usage like any other: it is a request to the person's account.
      const answer = job === "categorize"
        ? await open.choose({ model: models.categorize, instructions: categorizeInstructions(id), data: sample(id), options: CATEGORY_OPTIONS.map((option) => ({ ...option })) })
        : await open.write({ model: models.summarize, instructions: "Say in one short sentence what this is about.", data: sample(id), maxCharacters: 200 });
      await recordUsage(ctx, job, models[job], { usage: answer.usage, generation: answer.generation ?? null });
    } catch (error) {
      // A model the gateway says can't do the job was never sent anything: no request to count.
      if (!(error instanceof AiServiceError && error.unfit)) await recordUsage(ctx, job, models[job], { failed: true });
      const known = error instanceof AiServiceError ? error : new AiServiceError("unavailable", "The AI test failed in an unexpected way.");
      await ctx.lock.run(() => recordFailure(ctx, known, job as AiJob));
      return;
    }
  }
  await ctx.lock.run(() => recordAnswer(ctx, false));
}
