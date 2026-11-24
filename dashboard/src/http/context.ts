// What every route shares: the dependencies, the signed-in caller, the parsed form, and service errors in words.
import { ERROR_STATUS, ServiceError, type Caller, type ErrorCode, type MailService, type Authenticate } from "@usualmail/core";
import type { View } from "../view/layout.ts";
import { waitWords } from "../view/words.ts";

export type Form = Record<string, string | File | (string | File)[]>;

export interface Env {
  Variables: {
    caller: Caller;
    /** The signed-in person's own device id. */
    deviceId: string;
    view: View;
    form: Form;
  };
}

export interface Deps {
  service: MailService;
  authenticate: Authenticate;
  base: string;
  now: () => Date;
}

/** A form field's text, or "" when it is missing or a file. */
export function text(form: Form, name: string): string {
  const value = form[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : "";
}

/** Every text value a repeated field (checkboxes) sent. */
export function texts(form: Form, name: string): string[] {
  const value = form[name];
  const all = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return all.filter((item): item is string => typeof item === "string");
}

/** A ServiceError, or something shaped like one from another copy of core. Anything else is not. */
export function asServiceError(error: unknown): ServiceError | null {
  if (error instanceof ServiceError) return error;
  if (error && typeof error === "object" && (error as { name?: unknown }).name === "ServiceError") {
    const { code, message, retryAfter } = error as { code?: unknown; message?: unknown; retryAfter?: unknown };
    if (typeof code === "string" && code in ERROR_STATUS && typeof message === "string") {
      return new ServiceError(code as ErrorCode, message, typeof retryAfter === "number" ? { retryAfter } : undefined);
    }
  }
  return null;
}

/**
 * What to tell the person. The service's messages are written for people; internal ones are not shown. A
 * `rate_limited` answer says how long to wait, from its `retryAfter`.
 */
export function messageOf(error: ServiceError): string {
  if (error.code === "internal") return "Something went wrong on the server. Try again in a moment.";
  if (error.code === "rate_limited") {
    const wait = waitWords(error.retryAfter);
    return wait ? `Too many tries. Wait ${wait}, then try again.` : "Too many tries. Wait a few minutes, then try again.";
  }
  return error.message || "That didn't work. Try again.";
}

export function statusOf(error: ServiceError): 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 {
  return ERROR_STATUS[error.code] as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502;
}

/**
 * A path inside the dashboard to go back to after a form, from a hidden field. Only a plain path on this site is
 * accepted; anything else gives the fallback.
 */
export function safePath(value: string, fallback: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  try {
    const url = new URL(value, "http://dashboard.invalid");
    if (url.origin !== "http://dashboard.invalid") return fallback;
    // Dot segments can leave "//host" behind ("/.//evil.example"), which a browser reads as another site.
    if (url.pathname.startsWith("//") || url.pathname.startsWith("/\\")) return fallback;
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}
