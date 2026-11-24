/** Turns what the service throws into a tool result an agent can act on. */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { ServiceError, type ErrorCode } from "@usualmail/core";
import { toolError } from "./boundary.ts";

/** What each code means for an agent, and what to do next. Constant text only. */
const EXPLAIN: Record<ErrorCode, { lead: string; next: string }> = {
  not_found: {
    lead: "Not found.",
    next:
      "It doesn't exist, or it is in an inbox this agent wasn't given (or whose agent access is off). " +
      "Use ids from list_inboxes, take_triage_batch, list_threads or search_threads.",
  },
  needs_person: {
    lead: "Needs a person. Nothing was changed.",
    next:
      "Only a person can do this, in the Usual Mail app. Don't retry. If it matters, tell the person what you " +
      "suggest. (Actions that a person must approve are not errors: they come back as \"proposed\".)",
  },
  invalid: {
    lead: "Refused as invalid. Nothing was changed.",
    next: "Fix the arguments the data below names and call the tool again.",
  },
  conflict: {
    lead: "Conflict. Nothing was changed.",
    next: "The thread changed, or it is in the trash. Read it again with read_thread before acting on it.",
  },
  forbidden: {
    lead: "Not allowed. Nothing was changed.",
    next: "This agent may not do this. Don't retry.",
  },
  unauthorized: {
    lead: "This agent's token is no longer valid.",
    next: "Stop. A person has to give this agent a new token.",
  },
  rate_limited: {
    lead: "Too many requests.",
    next: "Wait a minute, then try again.",
  },
  provider_error: {
    lead: "The mail provider refused or didn't answer.",
    next: "Try again later. If it keeps failing, tell the person: the inbox may need attention.",
  },
  internal: {
    lead: "Usual Mail had an internal error.",
    next: "Try again later. If it keeps failing, tell the person.",
  },
};

const CODES = new Set<string>(Object.keys(EXPLAIN));

interface KnownError {
  code: ErrorCode;
  message: string;
  /** With rate_limited: whole seconds to wait. */
  retryAfter?: number;
}

/** Whole seconds from a `retryAfter`, or undefined when it isn't a sensible number. */
function seconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 86_400 * 7 ? Math.ceil(value) : undefined;
}

/** A ServiceError, also when another copy of core threw it (as can happen when packages are linked). */
export function asServiceError(error: unknown): KnownError | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { name, code, message, retryAfter } = error as { name?: unknown; code?: unknown; message?: unknown; retryAfter?: unknown };
  if (!(error instanceof ServiceError) && !(name === "ServiceError" && typeof code === "string" && CODES.has(code))) return undefined;
  const wait = seconds(retryAfter);
  return {
    code: code as ErrorCode,
    message: typeof message === "string" ? message : "",
    ...(wait !== undefined ? { retryAfter: wait } : {}),
  };
}

/** The service's message is the server's, but it may repeat what the caller sent, so it goes in the data block. */
export function errorResult(error: unknown): CallToolResult {
  const known = asServiceError(error);
  const code: ErrorCode = known?.code ?? "internal";
  const message = code === "internal" || !known ? "Internal error." : known.message.slice(0, 500);
  // The wait is a number the server gave, so it may stand in the connector's own words.
  const next =
    code === "rate_limited" && known?.retryAfter !== undefined
      ? `Wait ${known.retryAfter} second${known.retryAfter === 1 ? "" : "s"}, then try again.`
      : EXPLAIN[code].next;
  return toolError({ lead: EXPLAIN[code].lead, data: [{ error: code, message }], next });
}

/** For arguments the connector itself checks before calling the service. */
export function invalid(message: string): CallToolResult {
  return errorResult(new ServiceError("invalid", message));
}
