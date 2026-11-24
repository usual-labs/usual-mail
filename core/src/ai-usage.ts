/**
 * How much the server's AI has used of the person's AI account (docs/contract-ai.md, "Usage"), for a person's
 * Settings: requests, failures, tokens and cost, by job and model, for today, the last 7 days and the last 30 days in
 * the person's time zone. Only what the service reported is counted: where it reported no tokens or no cost, the
 * number is null and a client says "not reported", never an estimate. Person only.
 */
import type { AiJob } from "./ai.ts";
import type { IsoTime } from "./domain.ts";

/**
 * What a usage row counts: a job on mail, or `ask`, a search asked in a sentence and turned into filters
 * (docs/contract-search.md), which the summarize job's model answers. `ask` has no setting of its own (`AiJob` stays
 * the jobs a person chooses a model for); a client that doesn't know a name shows it as it is.
 */
export type AiUsageJob = AiJob | "ask";
export const AI_USAGE_JOBS = ["categorize", "summarize", "ask"] as const satisfies readonly AiUsageJob[];

/** How many days of usage the server keeps, by the hour. Older hours are dropped. */
export const AI_USAGE_KEPT_DAYS = 90;

/** A cost the service reported: Vercel's AI Gateway's own figure for each generation, looked up after the request. */
export interface AiUsageCost {
  amount: number;
  /** ISO 4217. The gateway reports US dollars. */
  currency: "USD";
}

/**
 * One job with one model over a period: a model changed in the middle shows as two rows. A client adds rows up for
 * totals.
 */
export interface AiUsageRow {
  job: AiUsageJob;
  model: string;
  /**
   * Requests the server made: one per call it made to the service for a thread, a test or a search asked in a
   * sentence, whatever came back. The
   * AI SDK's own retries of one call (after a 429, a 5xx or a dropped connection, at most two) are inside it, unseen
   * and not counted apart.
   */
  requests: number;
  /** Of `requests`, those that failed: the service refused, couldn't be reached, or failed after its retries. */
  failed: number;
  /** Input tokens, summed over the requests whose service reported them; null when none did. */
  inputTokens: number | null;
  /** Output tokens, the same. */
  outputTokens: number | null;
  /**
   * True when tokens were reported for some requests and not for others (a failed request reports none), so the
   * numbers are a floor: "at least". False when tokens are null.
   */
  tokensPartial: boolean;
  /**
   * The cost, summed over the requests whose cost the gateway reported (looked up some time after each request, so a
   * recent request's may still be missing); null when none did. A provider's own key reports none.
   */
  cost: AiUsageCost | null;
  /** True when a cost was reported for some requests and not for others: "at least". False when `cost` is null. */
  costPartial: boolean;
}

/** `GET /v1/ai/usage?tz=<IANA time zone>`. */
export interface AiUsage {
  /** When the server began keeping usage: nothing before it is counted. */
  since: IsoTime;
  /** The time zone the periods were cut in, as asked (`tz`), or `UTC`. */
  timeZone: string;
  /**
   * Each a list of rows, in `AI_USAGE_JOBS` order and then by model, only rows with requests. `today` runs from the last
   * midnight in `timeZone`; `last7Days` from midnight six days before it; `last30Days` from midnight 29 days before.
   * Usage is kept by the hour, so a period starts at the whole hour that holds that midnight (exact for zones a whole
   * number of hours from UTC; within half an hour for the rest).
   */
  periods: {
    today: AiUsageRow[];
    last7Days: AiUsageRow[];
    last30Days: AiUsageRow[];
  };
}

/** The query `GET /v1/ai/usage` takes. */
export interface AiUsageQuery {
  /** An IANA time zone, like `Europe/Berlin`. Default `UTC`. Anything else is `invalid`. */
  tz?: string;
}
