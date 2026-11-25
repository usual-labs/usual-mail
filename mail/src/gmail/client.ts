/**
 * A small Gmail REST client: refreshes access tokens from the self-hoster's own OAuth client, keeps to the
 * quota, and retries with backoff on rate limits and server errors. `fetch` is injected so tests can talk
 * to a fake of Gmail's API.
 */
import type { GmailCredentials } from "@usualmail/core";
import { backoffMs, type Clock, type Gate, type QuotaBucket } from "./limits.ts";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Google refused the token itself: the refresh token (revoked, expired, the password changed: `token_refused`) or
 * the OAuth client (`client_refused`). The server tells the person what to do from `kind`; the message is for logs
 * and for a person who pasted the credentials.
 */
export class GoogleTokenError extends Error {
  readonly kind: "token_refused" | "client_refused";

  constructor(kind: "token_refused" | "client_refused", message: string) {
    super(message);
    this.name = "GoogleTokenError";
    this.kind = kind;
  }
}

/**
 * What a Gmail error means beyond its status, for the server to sort it (server/src/sync/health.ts): the token lacks
 * the scope, which a new sign-in fixes; or the Google project's daily quota is spent, which lasts until Google resets
 * it. The words (`message`) say the same.
 */
export type GmailErrorKind = "scope" | "daily_quota";

export class GmailApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  readonly kind: GmailErrorKind | undefined;

  constructor(status: number, reason: string | undefined, message: string, kind?: GmailErrorKind) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
    this.reason = reason;
    this.kind = kind;
  }
}

/** Gmail or Google couldn't be reached, or an answer broke off, even after the retries: may pass. */
export class GmailUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailUnreachable";
  }
}

/**
 * Google refused to refresh the access token for a reason it didn't name as the token's or the client's (any other
 * answer of the token endpoint, after the retries). Not known to be lasting, so it fails the batch rather than
 * leaving a part out for good, and isn't worded as "sign in again" (that is `GoogleTokenError`).
 */
export class GoogleRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleRefreshError";
  }
}

/** An answer from Gmail that can't be read as Gmail documents it (it will read the same way next time). */
export class GmailDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailDataError";
  }
}

/**
 * Whether an error should fail a sync batch, to be tried again from the same cursor: a failure that may pass (no
 * connection, a rate limit, Gmail's own error, a timeout) or one the server must show the person (the token or the
 * client refused, the scope missing, the daily quota spent). Anything else would repeat with every try, so the
 * caller leaves the part out or stores the message as a note instead, as the raw form does when its parser refuses.
 */
export function failsTheBatch(error: unknown): boolean {
  if (error instanceof GoogleTokenError || error instanceof GoogleRefreshError || error instanceof GmailUnreachable) return true;
  if (error instanceof GmailApiError) return error.status === 401 || error.status === 403 || error.status === 408 || error.status === 429 || error.status >= 500;
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export interface GmailClientOptions {
  fetch: FetchLike;
  clock: Clock;
  quota: QuotaBucket;
  gate: Gate;
  /** Retries after the first try. */
  maxRetries: number;
  timeoutMs: number;
}

const RETRY_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "backendError", "internalError"]);
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export interface RequestOptions {
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  /** Quota units this call costs. */
  cost: number;
}

export class GmailClient {
  readonly credentials: GmailCredentials;
  readonly options: GmailClientOptions;
  #token: { value: string; expiresAt: number } | undefined;
  #refreshing: Promise<string> | undefined;

  constructor(credentials: GmailCredentials, options: GmailClientOptions) {
    this.credentials = credentials;
    this.options = options;
  }

  /** A valid access token, refreshed when it is missing, about to expire, or `force` is set. */
  async accessToken(force = false): Promise<string> {
    const now = this.options.clock.now();
    if (!force && this.#token && this.#token.expiresAt - 60_000 > now) return this.#token.value;
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
      grant_type: "refresh_token",
    }).toString();
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.options.fetch(TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (error) {
        if (attempt >= this.options.maxRetries) throw new GmailUnreachable(`Couldn't reach Google to refresh the access token: ${(error as Error).message}`);
        await this.options.clock.sleep(backoffMs(attempt, null, this.options.clock.now()));
        continue;
      }
      const data = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
      if (response.ok && data.access_token) {
        const lifetime = typeof data.expires_in === "number" ? data.expires_in * 1000 : 3_600_000;
        this.#token = { value: data.access_token, expiresAt: this.options.clock.now() + lifetime };
        return data.access_token;
      }
      if (RETRY_STATUS.has(response.status) && attempt < this.options.maxRetries) {
        await this.options.clock.sleep(backoffMs(attempt, response.headers.get("retry-after"), this.options.clock.now()));
        continue;
      }
      if (data.error === "invalid_grant") {
        throw new GoogleTokenError("token_refused", "Google no longer accepts this refresh token (invalid_grant). Connect the Gmail inbox again.");
      }
      if (data.error === "invalid_client" || data.error === "unauthorized_client") {
        throw new GoogleTokenError("client_refused", `Google refused the OAuth client (${data.error}). Check the client id and secret.`);
      }
      throw new GoogleRefreshError(`Google refused to refresh the access token: ${data.error_description ?? data.error ?? response.status}`);
    }
  }

  async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, options: RequestOptions): Promise<T> {
    const response = await this.response(method, path, options);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Like `request`, with the same quota, retries and token refresh, but hands back Gmail's successful answer unread,
   * so a large body can be read as a stream. The caller must read or cancel the body.
   */
  async response(method: "GET" | "POST" | "PUT" | "DELETE", path: string, options: RequestOptions): Promise<Response> {
    const url = GMAIL_API + path + queryString(options.query);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      await this.options.quota.take(options.cost);
      const token = await this.accessToken();
      let response: Response;
      try {
        response = await this.options.gate.run(() =>
          this.options.fetch(url, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              ...(options.body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: AbortSignal.timeout(this.options.timeoutMs),
          }),
        );
      } catch (error) {
        if (attempt >= this.options.maxRetries) throw new GmailUnreachable(`Couldn't reach Gmail: ${(error as Error).message}`);
        await this.options.clock.sleep(backoffMs(attempt, null, this.options.clock.now()));
        continue;
      }
      if (response.ok) return response;
      const detail = (await response.json().catch(() => undefined)) as
        | { error?: { message?: string; status?: string; errors?: { reason?: string; message?: string }[] } }
        | undefined;
      const reason = detail?.error?.errors?.[0]?.reason ?? detail?.error?.status;
      const message = detail?.error?.message ?? `Gmail answered ${response.status}`;
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        await this.accessToken(true);
        continue;
      }
      const retry = RETRY_STATUS.has(response.status) || (response.status === 403 && reason !== undefined && RETRY_REASONS.has(reason));
      if (retry && attempt < this.options.maxRetries) {
        await this.options.clock.sleep(backoffMs(attempt, response.headers.get("retry-after"), this.options.clock.now()));
        continue;
      }
      const kind = errorKind(response.status, reason, message);
      throw new GmailApiError(response.status, reason, readable(response.status, kind, message), kind);
    }
  }
}

/** The kind of a 403 the words and the server's sorting share: one test, so they always agree. */
function errorKind(status: number, reason: string | undefined, message: string): GmailErrorKind | undefined {
  if (status !== 403) return undefined;
  if (reason === "dailyLimitExceeded") return "daily_quota";
  if (reason === "insufficientPermissions" || /scope/i.test(message)) return "scope";
  return undefined;
}

function readable(status: number, kind: GmailErrorKind | undefined, message: string): string {
  if (status === 401) return "Gmail refused the access token even after refreshing it. Connect the Gmail inbox again.";
  if (kind === "daily_quota") {
    return "The Google project has used up its daily Gmail quota. Gmail answers again once Google resets it, at midnight " +
      "Pacific time.";
  }
  if (kind === "scope") return "The Gmail token lacks the needed scope (https://www.googleapis.com/auth/gmail.modify).";
  return `Gmail: ${message}`;
}

function queryString(query: RequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else params.append(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}
