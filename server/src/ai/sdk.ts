// The real model access, written against the AI SDK 7 (`ai` 7.0.173 with its gateway, OpenAI and Anthropic
// providers, read 2026-11-17): Vercel's AI Gateway with the person's gateway key, or OpenAI's or Anthropic's API with
// the person's own key. Decision models answer a choice through `experimental_decide`; language models through
// structured output limited to the options (Anthropic's native `output_config.format`, never a forced tool). No
// request carries tools. Nothing here logs: a failure becomes an `AiServiceError` whose message holds neither the key
// nor anything that was sent. Never run against a real service by any test: the tests pass `fetch`.

import { createAnthropic } from "@ai-sdk/anthropic";
import {
  GatewayAuthenticationError,
  GatewayError,
  GatewayForbiddenError,
  GatewayModelNotFoundError,
  GatewayRateLimitError,
} from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import type { AiConnection, AiCredentials, AiJob } from "@usualmail/core";
import {
  APICallError,
  createGateway,
  experimental_decide as decide,
  Experimental_DecisionRefusalError,
  Experimental_DecisionUnsupportedQuestionTypeError,
  generateText,
  InvalidResponseDataError,
  JSONParseError,
  LoadAPIKeyError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  NoSuchModelError,
  Output,
  RetryError,
  TypeValidationError,
  type LanguageModel,
} from "ai";
import { AiServiceError, NO_USAGE, scrubKey, unfitWords, type AiAnswer, type AiModelAccess, type AiModels, type AiObjectAnswer, type AiUsageReport, type ChoiceRequest, type ObjectRequest, type TextRequest } from "./models.ts";

// The SDK logs warnings to the console by default; this server logs nothing about AI requests.
globalThis.AI_SDK_LOG_WARNINGS = false;

/**
 * The server's default model for each job, per kind of connection (chosen 2026-11-17 from the providers' and the
 * gateway's model lists). On the gateway, categorizing goes through the Decisions API with `liquid/d1.2` (the owner's
 * choice of 2026-11-18, after the server's own test of it passed on the owner's gateway account) and summarizing
 * uses Claude Haiku 5.5; with a provider's own key, its smallest current model does both (never tried).
 */
export const DEFAULT_MODELS: Record<"vercel" | "openai" | "anthropic", Record<AiJob, string>> = {
  vercel: { categorize: "liquid/d1.2", summarize: "anthropic/claude-haiku-5.5" },
  openai: { categorize: "gpt-6-luna", summarize: "gpt-6-luna" },
  anthropic: { categorize: "claude-haiku-5-5", summarize: "claude-haiku-5-5" },
};

export interface SdkAccessOptions {
  /** Replaces the network, for tests. */
  fetch?: typeof globalThis.fetch;
  /** Per request. Default 60 seconds. */
  timeoutMs?: number;
  /** The SDK's own retries of a failed request (429, 5xx, network) before it counts as unavailable. Default 2. */
  maxRetries?: number;
  /** The most a model may write for one answer, thinking included. Default 4,000 tokens. */
  maxOutputTokens?: number;
}

export function sdkModelAccess(options: SdkAccessOptions = {}): AiModelAccess {
  return {
    label: "AI SDK",
    defaults: (connection) => ({ ...DEFAULT_MODELS[serviceKey(connection)] }),
    open: (credentials) => openModels(credentials, options),
  };
}

function serviceKey(connection: AiConnection): "vercel" | "openai" | "anthropic" {
  return connection.kind === "gateway" ? connection.gateway : connection.provider;
}

function openModels(credentials: AiCredentials, options: SdkAccessOptions): AiModels {
  const settings = { apiKey: credentials.apiKey, ...(options.fetch && { fetch: options.fetch }) };
  const call = { maxRetries: options.maxRetries ?? 2, maxOutputTokens: options.maxOutputTokens ?? 4_000 };
  const signal = (request: { signal?: AbortSignal }) => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    return request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  };
  const guard = <A extends AiAnswer | AiObjectAnswer>(work: () => Promise<A>) => run(work, credentials.apiKey);

  if (credentials.kind === "gateway") {
    const gateway = createGateway(settings);
    // The gateway's own list of models, with each one's kind: asked once per opening, never with mail.
    let listed: Promise<Map<string, string> | null> | null = null;
    const kinds = () => (listed ??= gateway.getAvailableModels()
      .then((list) => new Map(list.models.map((entry) => [entry.id, entry.modelType ?? "language"])))
      .catch(() => null));
    return {
      fitFor: async (job, model) => {
        const kind = (await kinds())?.get(model);
        return kind === undefined ? null : unfitWords(job, model, kind);
      },
      choose: (request) => guard(async () => {
        const result = await decide({
          model: gateway.decisionModel(request.model),
          state: request.data,
          questions: {
            kind: {
              type: "choice",
              instructions: request.instructions,
              criteria: Object.fromEntries(request.options.map((option) => [option.value, option.description])),
            },
          },
          maxRetries: call.maxRetries,
          abortSignal: signal(request),
        });
        const answer = result.answers.kind;
        return {
          value: answer?.type === "choice" ? answer.choice : null,
          usage: reported(result.usage),
          generation: generationOf(result.providerMetadata),
        };
      }),
      write: (request) => guard(() => writeText(gateway(request.model), request, call, signal(request), {})),
      extract: (request) => guard(() => extractObject(gateway(request.model), request, call, signal(request), {})),
      // The gateway's own figure for one generation: `GET /v1/generation?id=…` with the key, nothing else sent.
      lookupCost: async (generation) => {
        const info = await gateway.getGenerationInfo({ id: generation });
        if (typeof info.totalCost !== "number" || !Number.isFinite(info.totalCost) || info.totalCost < 0) throw new Error("No cost in the answer");
        return info.totalCost;
      },
    };
  }
  if (credentials.provider === "openai") {
    const openai = createOpenAI(settings);
    // Nothing is kept at OpenAI for later turns: there are none.
    const providerOptions = { openai: { store: false } };
    return {
      choose: (request) => guard(() => chooseText(openai(request.model), request, call, signal(request), providerOptions)),
      write: (request) => guard(() => writeText(openai(request.model), request, call, signal(request), providerOptions)),
      extract: (request) => guard(() => extractObject(openai(request.model), request, call, signal(request), providerOptions)),
    };
  }
  const anthropic = createAnthropic(settings);
  // Anthropic's own structured output, never the forced "json" tool older models needed.
  const providerOptions = { anthropic: { structuredOutputMode: "outputFormat" as const } };
  return {
    choose: (request) => guard(() => chooseText(anthropic(request.model), request, call, signal(request), providerOptions)),
    write: (request) => guard(() => writeText(anthropic(request.model), request, call, signal(request), {})),
    extract: (request) => guard(() => extractObject(anthropic(request.model), request, call, signal(request), providerOptions)),
  };
}

type Call = { maxRetries: number; maxOutputTokens: number };
type ProviderOptions = Record<string, Record<string, string | boolean>>;

/** A language model's choice, through structured output limited to the options. No tools. */
async function chooseText(model: LanguageModel, request: ChoiceRequest, call: Call, abortSignal: AbortSignal, providerOptions: ProviderOptions): Promise<AiAnswer> {
  const kinds = request.options.map((option) => `${option.value}: ${option.description}`).join("\n");
  const result = await generateText({
    model,
    system: `${request.instructions}\n\nThe kinds:\n${kinds}`,
    prompt: request.data,
    output: Output.choice({ options: request.options.map((option) => option.value), name: "kind" }),
    ...call,
    abortSignal,
    providerOptions,
  });
  return { value: result.output, usage: reported(result.usage) };
}

/** A language model's plain text. No tools. */
async function writeText(model: LanguageModel, request: TextRequest, call: Call, abortSignal: AbortSignal, providerOptions: ProviderOptions): Promise<AiAnswer> {
  const result = await generateText({ model, system: request.instructions, prompt: request.data, ...call, abortSignal, providerOptions });
  return { value: result.text || null, usage: reported(result.usage), generation: generationOf(result.providerMetadata) };
}

/**
 * A language model's object, through structured output of the request's schema (OpenAI's strict JSON schema,
 * Anthropic's native `output_config.format`; on the gateway the call's response format, which the gateway passes to
 * the model's provider). No tools.
 */
async function extractObject(model: LanguageModel, request: ObjectRequest, call: Call, abortSignal: AbortSignal, providerOptions: ProviderOptions): Promise<AiObjectAnswer> {
  const result = await generateText({
    model,
    system: request.instructions,
    prompt: request.data,
    output: Output.object({ schema: request.schema, name: request.name }),
    ...call,
    // A request a person waits on says how often it may be sent again: never (docs/contract-search.md).
    ...(request.retries !== undefined && { maxRetries: request.retries }),
    abortSignal,
    providerOptions,
  });
  return { value: result.output, usage: reported(result.usage), generation: generationOf(result.providerMetadata) };
}

/**
 * The gateway's generation id from an answer's provider metadata (`gateway.generationId`, `gen_<ulid>`), or null:
 * a provider's own key has none, and the gateway documents it for text calls (for the Decisions API only inside
 * fallback attempts, which the server doesn't ask for).
 */
function generationOf(metadata: unknown): string | null {
  const gateway = (metadata as { gateway?: { generationId?: unknown } } | undefined)?.gateway;
  const id = gateway?.generationId;
  return typeof id === "string" && /^gen_[A-Za-z0-9]{1,60}$/.test(id) ? id : null;
}

/**
 * The tokens the AI SDK reported for one call (`usage`, each field possibly undefined), as whole numbers, or null.
 * No cost: none of the services puts one in its answer.
 */
function reported(usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined): AiUsageReport {
  const tokens = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);
  return { inputTokens: tokens(usage?.inputTokens), outputTokens: tokens(usage?.outputTokens), costUsd: null };
}

/**
 * Runs one request. A service that answered with nothing usable (no output, an answer outside the options, a
 * refusal, malformed data) gives a null value, with no usage reported; a service that couldn't be used throws
 * `AiServiceError`.
 */
async function run<A extends AiAnswer | AiObjectAnswer>(work: () => Promise<A>, key: string): Promise<A> {
  try {
    return await work();
  } catch (error) {
    const failure = describeFailure(error, key);
    if (failure) throw failure;
    return { value: null, usage: NO_USAGE } as A;
  }
}

/** What a failure means for the status, or null when the service answered and only the answer was unusable. */
export function describeFailure(thrown: unknown, key: string): AiServiceError | null {
  const error = RetryError.isInstance(thrown) ? thrown.lastError : thrown;
  const said = (fallback: string) => safeWords(error, key, fallback);
  if (GatewayError.isInstance(error)) {
    if (GatewayAuthenticationError.isInstance(error)) return keyRefused();
    if (GatewayModelNotFoundError.isInstance(error)) return new AiServiceError("model_not_found", said("The gateway doesn't know this model."));
    if (error.statusCode === 402 || mentionsCredit(error.message)) return new AiServiceError("out_of_credit", said("The gateway account has no credit left."));
    if (GatewayForbiddenError.isInstance(error)) return keyRefused();
    if (GatewayRateLimitError.isInstance(error)) return new AiServiceError("unavailable", said("The gateway asked to slow down."));
    if (error.statusCode === 404) return new AiServiceError("model_not_found", said("The gateway doesn't know this model."));
    return new AiServiceError("unavailable", said("The gateway couldn't answer."));
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    const body = `${error.message} ${error.responseBody ?? ""}`;
    if (status === 401) return keyRefused();
    if (status === 402 || mentionsCredit(body)) return new AiServiceError("out_of_credit", said("The account has no credit left or reached its limit."));
    if (status === 404 || /model[^.]{0,80}(not found|does not exist|not available|no access)/i.test(body)) {
      return new AiServiceError("model_not_found", said("The service doesn't know this model."));
    }
    if (status === 403) return keyRefused();
    return new AiServiceError("unavailable", said(`The service answered with an error${status ? ` (${status})` : ""}.`));
  }
  if (LoadAPIKeyError.isInstance(error)) return keyRefused();
  if (NoSuchModelError.isInstance(error) || Experimental_DecisionUnsupportedQuestionTypeError.isInstance(error)) {
    return new AiServiceError("model_not_found", "This model can't answer this job's question.");
  }
  // The service answered, but not with something the server can use: no output, a refusal, malformed data.
  const unusable = [
    NoObjectGeneratedError, NoOutputGeneratedError, NoContentGeneratedError, InvalidResponseDataError,
    TypeValidationError, JSONParseError, Experimental_DecisionRefusalError,
  ];
  if (unusable.some((kind) => kind.isInstance(error))) return null;
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError" || error instanceof TypeError) {
    return new AiServiceError("unavailable", "The service couldn't be reached in time.");
  }
  return new AiServiceError("unavailable", "The service failed in a way the server doesn't know.");
}

function keyRefused(): AiServiceError {
  return new AiServiceError("key_refused", "The service refused the key. Check it, or set a new one.");
}

function mentionsCredit(text: string): boolean {
  return /insufficient[_ ](quota|credit|funds|balance)|credit balance|out of credit|no credit|billing|payment required|quota exceeded|spend limit/i.test(text);
}

/**
 * The service's own words, when it gave a short message: without the key or anything that looks like one, and
 * without anything that looks like the data that was sent. Otherwise the fallback.
 */
function safeWords(error: unknown, key: string, fallback: string): string {
  const raw = error instanceof Error ? error.message : "";
  if (!raw || raw.length > 300 || raw.includes("usual-mail-data")) return fallback;
  const text = scrubKey(raw, key);
  return text ? scrubKey(`${fallback} The service said: ${text}`, key) : fallback;
}
