// Talks to the server over its REST routes, and nothing else. Paths and methods come from core's route table.

import { ROUTES, type Device, type ErrorCode, type RouteName } from "@usualmail/core";
import { readConfig } from "./config.ts";
import type { Context } from "./context.ts";
import { ApiError, explain, Failure, retryAfterSeconds, type ErrorScene } from "./errors.ts";
import { VERSION } from "./version.ts";

const CODES = new Set<string>([
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid",
  "conflict",
  "needs_person",
  "rate_limited",
  "provider_error",
  "internal",
]);

export interface CallOptions {
  params?: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: unknown;
  timeoutMs?: number;
  /** How to explain an error answer. */
  scene?: ErrorScene;
}

export class Client {
  readonly server: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(server: string, token: string | undefined, fetcher: typeof fetch, now: () => number = Date.now) {
    this.server = server.replace(/\/+$/, "");
    this.#token = token;
    this.#fetch = fetcher;
    this.#now = now;
  }

  get hasToken(): boolean {
    return Boolean(this.#token);
  }

  /** Calls one route. Returns the parsed body, or undefined for `204`. Error answers become a `Failure`. */
  async call<T>(name: RouteName, options: CallOptions = {}): Promise<T> {
    try {
      return await this.raw<T>(name, options);
    } catch (error) {
      if (error instanceof ApiError) throw explain(error, { ...options.scene, pairing: name === "pair" });
      throw error;
    }
  }

  /** Like `call`, but an error answer stays an `ApiError`, for callers that handle a code themselves. */
  async raw<T>(name: RouteName, options: CallOptions = {}): Promise<T> {
    const route = ROUTES[name];
    const path = route.path.replace(/:(\w+)/g, (_, key: string) => {
      const value = options.params?.[key];
      if (value === undefined) throw new Error(`Missing path parameter ${key} for ${name}`);
      return encodeURIComponent(value);
    });
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) search.set(key, value);
    const url = `${this.server}${path}${search.size ? `?${search}` : ""}`;
    const headers: Record<string, string> = { accept: "application/json", "user-agent": `usual-mail-cli/${VERSION}` };
    if (route.auth !== "none") {
      if (!this.#token) {
        throw new Failure("This command isn't paired with the server yet. Run `usual-mail init` first.", "not_set_up");
      }
      headers.authorization = `Bearer ${this.#token}`;
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: route.method,
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw unreachable(this.server, error);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      throw new Failure(
        `${this.server} answered HTTP ${response.status} with something other than JSON. Is it a Usual Mail server?`,
      );
    }
    if (!response.ok) {
      const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      if (error && typeof error.code === "string" && CODES.has(error.code)) {
        const retryAfter = retryAfterSeconds(response.headers.get("retry-after"), this.#now());
        throw new ApiError(response.status, error.code as ErrorCode, String(error.message ?? error.code), retryAfter);
      }
      throw new Failure(`${this.server} answered HTTP ${response.status}. Is it a Usual Mail server?`);
    }
    return data as T;
  }

  /** True when `GET /healthz` answers `{ "ok": true }` within the time given. */
  async healthy(timeoutMs = 2_000): Promise<boolean> {
    try {
      const response = await this.#fetch(`${this.server}${ROUTES.health.path}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { ok?: unknown };
      return data.ok === true;
    } catch {
      return false;
    }
  }
}

export function unreachable(server: string, error: unknown): Failure {
  const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).name;
  const why = cause === "TimeoutError" ? "it didn't answer in time" : "nothing answered";
  return new Failure(
    `Can't reach the server at ${server}: ${why}. \`usual-mail status\` says whether it runs; ` +
      "`usual-mail start` starts it.",
    "unreachable",
  );
}

/** The server and token to use: USUAL_MAIL_SERVER and USUAL_MAIL_TOKEN win over the saved settings. */
export function clientFor(ctx: Context): Client {
  const config = readConfig(ctx);
  const server = ctx.env.USUAL_MAIL_SERVER || config.server;
  if (!server) {
    throw new Failure("No server is set up for this command. Run `usual-mail init` first.", "not_set_up");
  }
  const token = ctx.env.USUAL_MAIL_TOKEN || (config.server === server ? config.token : undefined);
  return new Client(server, token, ctx.fetch, ctx.now);
}

/**
 * The device the token in use belongs to, from `GET /v1/me`: this command's own, another person's device, or an
 * agent when USUAL_MAIL_TOKEN holds an agent's token. Null when the server refuses the token.
 */
export async function whoAmI(client: Client): Promise<Device | null> {
  try {
    return await client.raw<Device>("me");
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthorized") return null;
    throw error instanceof ApiError ? explain(error) : error;
  }
}
