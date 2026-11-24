// What can go wrong, as the command tells it. Every failure carries a code (the contract's error codes for
// answers from the server, a few of the command's own otherwise) and a message that says what to do next.

import type { ErrorCode } from "@usualmail/core";

/** The command's own codes, for failures that are not an answer from the server. */
export type LocalCode = "usage" | "not_set_up" | "unreachable" | "not_a_terminal" | "failed";

export class Failure extends Error {
  readonly code: ErrorCode | LocalCode;
  /** 2 for a mistake in how the command was called, 1 for everything else. */
  readonly exitCode: number;
  /** With rate_limited: whole seconds to wait, from the server's Retry-After. */
  readonly retryAfter?: number;
  constructor(message: string, code: ErrorCode | LocalCode = "failed", options: { retryAfter?: number } = {}) {
    super(message);
    this.name = "Failure";
    this.code = code;
    this.exitCode = code === "usage" || code === "not_a_terminal" ? 2 : 1;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}

/** A mistake in the arguments. The message names the command whose help to read. */
export class UsageError extends Failure {
  constructor(message: string) {
    super(message, "usage");
    this.name = "UsageError";
  }
}

/** An error answer from the server: `{ "error": { "code", "message" } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** Whole seconds to wait, from a `Retry-After` header. */
  readonly retryAfter?: number;
  constructor(status: number, code: ErrorCode, message: string, retryAfter?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/**
 * Seconds from a `Retry-After` header: whole seconds, as the contract sends it, or an HTTP date, which HTTP also
 * allows. Undefined when it is neither.
 */
export function retryAfterSeconds(header: string | null | undefined, now: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/** "45 seconds", "10 minutes": minutes rounded up, so a person doesn't try again too early. */
export function waitWords(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Where an error happened, so the explanation can point at the right next step. */
export interface ErrorScene {
  /** True for `POST /v1/pair`, where `unauthorized` means a bad pairing code, not a bad token. */
  pairing?: boolean;
  /** A command that lists what wasn't found, for example "usual-mail inbox list". */
  listCommand?: string;
}

/** Turns an error answer into a sentence or two a person can act on. */
export function explain(error: ApiError, scene: ErrorScene = {}): Failure {
  const said = error.message.replace(/\.?$/, ".");
  switch (error.code) {
    case "unauthorized":
      return new Failure(
        scene.pairing
          ? "The pairing code is wrong, used or expired. Make a new one in an app that is already paired, " +
              "or with `usual-mail pair` on a machine that is, and try again."
          : "The server didn't accept this command's token. It was revoked, or the server's data was replaced. " +
              "Run `usual-mail init` to pair this command again.",
        "unauthorized",
      );
    case "rate_limited": {
      const wait =
        error.retryAfter === undefined
          ? " Wait up to ten minutes, then try again."
          : error.retryAfter === 0
            ? " Try again now."
            : ` Try again in ${waitWords(error.retryAfter)}.`;
      return new Failure(
        scene.pairing
          ? `Too many wrong pairing codes, so the server refuses new tries for now.${wait}`
          : `The server is turning requests away for now.${wait}`,
        "rate_limited",
        error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter },
      );
    }
    case "needs_person":
      return new Failure(
        `Only a person may do this, and the token in use belongs to an agent (${said}) ` +
          "Unset USUAL_MAIL_TOKEN, or run `usual-mail init` to pair this command as your own device.",
        "needs_person",
      );
    case "forbidden":
      return new Failure(`The server refused: ${said}`, "forbidden");
    case "not_found":
      return new Failure(
        scene.listCommand ? `${said} \`${scene.listCommand}\` shows what there is.` : said,
        "not_found",
      );
    case "invalid":
      return new Failure(`The server refused the request: ${said}`, "invalid");
    case "conflict":
      return new Failure(`${said} Something changed in the meantime; look again and retry.`, "conflict");
    case "provider_error":
      return new Failure(
        `The mail provider answered with an error: ${said} Check the connection details, or try again later.`,
        "provider_error",
      );
    case "internal":
      return new Failure(`The server hit an error: ${said} \`usual-mail logs\` shows what happened.`, "internal");
  }
}
