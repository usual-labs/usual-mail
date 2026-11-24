// The stand-in's part for the server's AI, written from core/src/ai.ts and docs/contract-ai.md: settings without the
// key, credentials that replace the stored ones whole and are tested at once, moving to another service putting the
// jobs back on the defaults, pause, testing, a status whose `pending` is counted from threads a test describes (all
// synced mail that isn't done: there is no history setting), and the words before a key is saved, from core's builder.

import {
  AI_GATEWAYS,
  AI_JOBS,
  AI_PROVIDERS,
  aiDisclosure,
  type AiConnection,
  type AiDisclosure,
  type AiCredentials,
  type AiJob,
  type AiSettings,
  type AiState,
  type AiStatus,
  type Inbox,
} from "@usualmail/core";

/** A thread that needs a category or a summary, by its inbox. */
export interface AiWork {
  inboxId: string;
}

/** Thrown for an answer the contract gives as an error; the stand-in turns it into the error body. */
export class AiRefusal extends Error {
  readonly code: "invalid" | "conflict";
  constructor(code: "invalid" | "conflict", message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Keys that make the made-up service answer a failure, so tests can see each state. A key starting with "echo-" is
 * refused with a message that repeats it, as some services do, to check the command never shows it.
 */
export const KEYS = { refused: "refused-key-0000", noCredit: "no-credit-key-0000", down: "down-key-0000" };
/** A model id the made-up service doesn't know. */
export const MISSING_MODEL = "example/missing-model";

const DEFAULTS: Record<string, Record<AiJob, string>> = {
  "gateway:vercel": { categorize: "example/decision-1", summarize: "example/text-small-1" },
  "direct:openai": { categorize: "example-openai-small", summarize: "example-openai-small" },
  "direct:anthropic": { categorize: "example-anthropic-small", summarize: "example-anthropic-small" },
};

const connectionOf = (c: AiCredentials): AiConnection =>
  c.kind === "gateway" ? { kind: "gateway", gateway: c.gateway } : { kind: "direct", provider: c.provider };
const time = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const service = (connection: AiConnection) => (connection.kind === "gateway" ? `gateway:${connection.gateway}` : `direct:${connection.provider}`);

export class StandInAi {
  /** What the person set, key included. Never sent back by any route. */
  credentials: AiCredentials | null = null;
  /** The service of the last credentials set, remembered when they are removed. */
  service: AiConnection | undefined;
  models: Record<AiJob, string | null> = { categorize: null, summarize: null };
  paused = false;
  version = 1;
  /** The state the last test left, before pausing is taken into account. */
  tested: { state: AiState; detail?: string; job?: AiJob; lastRunAt?: string } = { state: "not_set_up" };
  statusVersion = 1;
  /** Threads that need work, to count `pending`. */
  work: AiWork[] = [];
  /** How many times the made-up service was asked (tests and saves), to check a test happened. */
  tests = 0;

  readonly #inboxes: Inbox[];

  /** `inboxes` is the stand-in's own list, so AI processing and its counts follow it. */
  constructor(inboxes: Inbox[]) {
    this.#inboxes = inboxes;
  }

  settings(): AiSettings {
    const connection = this.connection();
    const defaults = connection ? DEFAULTS[service(connection)]! : { categorize: "", summarize: "" };
    return {
      ...(connection ? { connection } : {}),
      credentialsSet: this.credentials !== null,
      jobs: AI_JOBS.map((job) => ({ job, model: this.models[job], defaultModel: defaults[job] })),
      paused: this.paused,
      version: this.version,
    };
  }

  /** `GET /v1/ai/disclosure`, as the server builds it: core's words, the models that would do each job there. */
  disclosure(query: URLSearchParams): AiDisclosure {
    const gateway = query.get("gateway");
    const provider = query.get("provider");
    if ((gateway === null) === (provider === null)) throw new AiRefusal("invalid", "Name the service: gateway=vercel, provider=openai or provider=anthropic");
    if (gateway !== null && !(AI_GATEWAYS as readonly string[]).includes(gateway)) throw new AiRefusal("invalid", "gateway is vercel");
    if (provider !== null && !(AI_PROVIDERS as readonly string[]).includes(provider)) throw new AiRefusal("invalid", "provider is openai or anthropic");
    const connection = (gateway !== null ? { kind: "gateway", gateway } : { kind: "direct", provider }) as AiConnection;
    const current = this.connection() ?? this.service;
    const chosen = current && service(current) === service(connection) ? this.models : { categorize: null, summarize: null };
    const defaults = DEFAULTS[service(connection)]!;
    return aiDisclosure({ connection, jobs: AI_JOBS.map((job) => ({ job, model: chosen[job], defaultModel: defaults[job] })) });
  }

  connection(): AiConnection | undefined {
    return this.credentials ? connectionOf(this.credentials) : undefined;
  }

  status(): AiStatus {
    // Once a key is set, every inbox's mail is processed; without one nothing waits for the AI.
    const mine = this.credentials ? this.work.filter((item) => this.#inboxes.some((inbox) => inbox.id === item.inboxId)) : [];
    const pending = mine.length;
    const base = !this.credentials ? { state: "not_set_up" as const } : this.paused ? { state: "paused" as const } : this.tested;
    const { lastRunAt } = this.tested;
    return { ...base, ...(lastRunAt ? { lastRunAt } : {}), pending, version: this.statusVersion };
  }

  /** `PATCH /v1/ai`, as the contract describes it. Throws `AiRefusal` and changes nothing on a bad patch. */
  update(patch: Record<string, unknown>): AiSettings {
    for (const key of Object.keys(patch)) {
      if (!["credentials", "models", "paused"].includes(key)) throw new AiRefusal("invalid", `Unknown field ${key}`);
    }
    const credentials = patch.credentials === undefined ? undefined : checkCredentials(patch.credentials);
    const models = patch.models === undefined ? undefined : checkModels(patch.models);
    if (patch.paused !== undefined && typeof patch.paused !== "boolean") throw new AiRefusal("invalid", "paused must be true or false");

    let test = false;
    // Credentials a test set straight on the stand-in count as set through here.
    if (this.credentials) this.service = connectionOf(this.credentials);
    if (credentials !== undefined) {
      const after = credentials ? connectionOf(credentials) : undefined;
      // Moving to another service puts the jobs back on the defaults unless the same patch names models. Removing
      // remembers the service, so a new key for it keeps the models; a new key for the same service keeps them. No
      // inbox changes: there is no per-inbox switch.
      const moved = after !== undefined && this.service !== undefined && service(this.service) !== service(after);
      if (moved && !models) this.models = { categorize: null, summarize: null };
      this.credentials = credentials;
      if (after) this.service = after;
      else this.tested = { state: "not_set_up" };
      test = Boolean(after);
    }
    if (models) {
      Object.assign(this.models, models);
      test = this.credentials !== null;
    }
    if (patch.paused !== undefined) this.paused = patch.paused as boolean;
    this.version += 1;
    this.statusVersion += 1;
    // Saving credentials or a model tests them at once (here before answering).
    if (test) this.test();
    return this.settings();
  }

  /** `POST /v1/ai/test`: one small request per job's model, no mail. */
  test(): AiStatus {
    this.tests += 1;
    this.statusVersion += 1;
    const key = this.credentials?.apiKey;
    if (!key) {
      this.tested = { state: "not_set_up" };
      return this.status();
    }
    const missing = AI_JOBS.find((job) => this.models[job] === MISSING_MODEL);
    if (key === KEYS.refused) this.tested = { state: "key_refused", detail: "The service refused the key." };
    else if (key.startsWith("echo-")) this.tested = { state: "key_refused", detail: `Incorrect API key provided: ${key}.` };
    else if (key === KEYS.noCredit) this.tested = { state: "out_of_credit", detail: "Your account has no credit left." };
    else if (key === KEYS.down) this.tested = { state: "unavailable", detail: "The service didn't answer." };
    else if (missing) this.tested = { state: "model_not_found", job: missing, detail: `The service has no model ${MISSING_MODEL}.` };
    else this.tested = { state: "working", lastRunAt: time(Date.now()) };
    return this.status();
  }
}

function checkCredentials(value: unknown): AiCredentials | null {
  if (value === null) return null;
  const c = value as Record<string, unknown>;
  if (typeof c?.apiKey !== "string" || !c.apiKey) throw new AiRefusal("invalid", "credentials need an apiKey");
  if (c.kind === "gateway" && (AI_GATEWAYS as readonly unknown[]).includes(c.gateway) && Object.keys(c).length === 3) {
    return { kind: "gateway", gateway: c.gateway as "vercel", apiKey: c.apiKey };
  }
  if (c.kind === "direct" && (AI_PROVIDERS as readonly unknown[]).includes(c.provider) && Object.keys(c).length === 3) {
    return { kind: "direct", provider: c.provider as "openai" | "anthropic", apiKey: c.apiKey };
  }
  throw new AiRefusal("invalid", "credentials must be a gateway's or a provider's key");
}

function checkModels(value: unknown): Partial<Record<AiJob, string | null>> {
  if (!value || typeof value !== "object") throw new AiRefusal("invalid", "models must be an object");
  for (const [job, model] of Object.entries(value)) {
    if (!(AI_JOBS as readonly string[]).includes(job)) throw new AiRefusal("invalid", `No job ${job}`);
    if (model !== null && (typeof model !== "string" || !model.trim())) throw new AiRefusal("invalid", `models.${job} must be a model id or null`);
  }
  return value as Partial<Record<AiJob, string | null>>;
}
