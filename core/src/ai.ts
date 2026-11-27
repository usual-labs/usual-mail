/**
 * The server's own AI: the jobs it runs on mail, the person's settings for it, and its status.
 * What the AI may do, what leaves the server and how mail is passed to a model are in docs/contract-ai.md.
 */
import type { IsoTime } from "./domain.ts";
import type { BrowserAgentCredentials, BrowserAgentSettings } from "./unsubscribe.ts";

/**
 * A job the server's AI does, each with its own model. `categorize` sets a thread's category and `summarize` writes
 * its summary, or for a receipt or an invoice its payment details (`Thread.payment`). Planned, not built: a one-time
 * code and when it expires, and drafting replies. They join this list when they are built.
 */
export type AiJob = "categorize" | "summarize";
export const AI_JOBS = ["categorize", "summarize"] as const;

/** A service whose one key reaches several providers' models. Model ids are "provider/model". */
export type AiGateway = "vercel";
export const AI_GATEWAYS = ["vercel"] as const;

/** A provider whose own key reaches only its own models. Model ids are the provider's own. */
export type AiProvider = "openai" | "anthropic";
export const AI_PROVIDERS = ["openai", "anthropic"] as const;

/**
 * How the server reaches models, without anything secret, so a form can show it again. A later revision adds a kind
 * for signing in with a provider instead of a key; these two stay as they are.
 */
export type AiConnection =
  | { kind: "gateway"; gateway: AiGateway }
  | { kind: "direct"; provider: AiProvider };

/**
 * What a person gives to set the AI up, in the shape of `AiConnection` plus the key. Stored encrypted like mailbox
 * credentials. Never returned by any route, never shown to an agent, never written to a log.
 */
export type AiCredentials =
  | { kind: "gateway"; gateway: AiGateway; apiKey: string }
  | { kind: "direct"; provider: AiProvider; apiKey: string };

/** One job's model. */
export interface AiJobSetting {
  job: AiJob;
  /**
   * The model the person chose, as the service names it, or null for the server's default. On a gateway the
   * `categorize` job needs a decision model and `summarize` a language model; a model that can't do its job fails the
   * test with `model_not_found` and words that say why.
   */
  model: string | null;
  /**
   * The model the server uses when `model` is null, for the current connection. The server chooses it and may change
   * it in a later version; it is shown to the person. Empty while no connection is set.
   */
  defaultModel: string;
}

/** The server's AI as the person set it up. Person only. */
export interface AiSettings {
  /** How models are reached. Absent until a person sets credentials. */
  connection?: AiConnection;
  /** Whether credentials are stored. The key itself is never returned. */
  credentialsSet: boolean;
  /** One per job, in the order of `AI_JOBS`. */
  jobs: AiJobSetting[];
  /** True while the person paused the AI: nothing is sent to the service, for any inbox. */
  paused: boolean;
  /**
   * The browser agent that opens a sender's unsubscribe page when nothing cheaper works (docs/contract.md,
   * "Unsubscribing"), without its key. Absent while none is set up. Optional, and apart from the AI's key: pausing the
   * AI doesn't stop it, and it never reads mail.
   */
  browserAgent?: BrowserAgentSettings;
  /** Rises with every change and may rise by more than one. Of two copies, keep the higher. */
  version: number;
}

/** A change to the settings. Person only. */
export interface AiSettingsPatch {
  /**
   * New credentials, which replace the stored ones whole, or null to remove them: removing the AI key is setting the
   * credentials to nothing, which stops all processing. Setting them is the person's consent to every inbox's mail,
   * now and later, going to that gateway or provider: an interface shows what is sent and to whom (`aiDisclosure`)
   * before it sends them, and again for another gateway or provider. Moving to another gateway or provider puts every
   * job back on the server's default model unless the same patch sets `models`. The server stores them without asking the service, then tests
   * them at once (see `AiStatus`), and answers only after that test has run.
   */
  credentials?: AiCredentials | null;
  /** A model id per job, as the service names it, or null for the server's default. */
  models?: Partial<Record<AiJob, string | null>>;
  paused?: boolean;
  /**
   * A browser agent's key, which replaces a stored one whole, or null to remove it. Setting it is the person's consent
   * to what `BROWSER_AGENT_DISCLOSURE` says, which an interface shows first. The server stores it, then tests it at
   * once with a request that starts nothing, and answers after that test.
   */
  browserAgent?: BrowserAgentCredentials | null;
}

/**
 * Whether the AI works. `not_set_up`: no credentials. `paused`: the person paused it. `working`: its last request was
 * answered. `key_refused`: the service refused the key. `model_not_found`: the service doesn't know a job's model, or
 * the model can't do that job (on a gateway, categorizing needs a decision model), and `job` says which; `detail` says
 * why. `out_of_credit`: the account has no credit or reached its limit. `unavailable`: the service couldn't be reached
 * or failed for a while, which usually passes by itself.
 */
export type AiState =
  | "not_set_up"
  | "paused"
  | "working"
  | "key_refused"
  | "model_not_found"
  | "out_of_credit"
  | "unavailable";
export const AI_STATES = [
  "not_set_up",
  "paused",
  "working",
  "key_refused",
  "model_not_found",
  "out_of_credit",
  "unavailable",
] as const;

/** Whether the server's AI works, so an interface can say why there are no summaries. Anyone may read it. */
export interface AiStatus {
  state: AiState;
  /**
   * Why the state isn't `working`, in words a person can act on, for example the service's own message. It never
   * carries the key or any recognisable part of it, in any form (written out, in base64 or hexadecimal, spaced out or
   * broken up), and nor do events, logs or errors.
   */
  detail?: string;
  /** With `model_not_found`: the job whose model the service doesn't know. */
  job?: AiJob;
  /** When the server last processed a thread with the AI. */
  lastRunAt?: IsoTime;
  /**
   * How many threads the AI still has to process: every synced thread that isn't done or trashed and needs a category
   * or a summary, however old (the AI works through all synced mail; how far back that goes is the first sync's
   * window, `FirstSyncWindow`). Counted whatever the state, so an interface can say how much is held up.
   */
  pending: number;
  /** Rises with every change and may rise by more than one. Of two copies, keep the higher. */
  version: number;
}
