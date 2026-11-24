// Small helpers every route uses: render a page, redirect after a form, and catch the service's errors.
import type { Caller, Inbox, ServiceError } from "@usualmail/core";
import type { Context } from "hono";
import type { Html } from "../html.ts";
import { asServiceError, type Deps, type Env, type Form } from "../http/context.ts";
import type { View } from "../view/layout.ts";

export type Ctx = Context<Env>;

export const viewOf = (c: Ctx): View => c.get("view");
export const callerOf = (c: Ctx): Caller => c.get("caller");
export const formOf = (c: Ctx): Form => c.get("form");

export function render(c: Ctx, body: Html, status: 200 | 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 = 200): Response {
  return c.html(body.value, status);
}

/** After a form: back to a page, with one of the fixed notices (see NOTICES in view/layout.ts). */
export function go(c: Ctx, deps: Deps, path: string, done?: string): Response {
  const target = done ? `${path}${path.includes("?") ? "&" : "?"}done=${encodeURIComponent(done)}` : path;
  return c.redirect(`${deps.base}${target}`, 303);
}

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

/** Runs a service call. A ServiceError comes back to be shown; anything else is thrown on. */
export async function attempt<T>(call: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    const serviceError = asServiceError(error);
    if (!serviceError) throw error;
    return { ok: false, error: serviceError };
  }
}

/** One inbox by id. The service has no single-inbox read, so this lists them. */
export async function findInbox(deps: Deps, caller: Caller, id: string): Promise<{ inbox: Inbox | undefined; inboxes: Inbox[] }> {
  const inboxes = await deps.service.listInboxes(caller);
  return { inbox: inboxes.find((inbox) => inbox.id === id), inboxes };
}

/** The `done` notice key from the query, if any. */
export const doneOf = (c: Ctx) => c.req.query("done") || undefined;
