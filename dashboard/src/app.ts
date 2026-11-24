// The dashboard as one fetch handler: assets, signing in and out, the guard that every other page passes, and
// the sections' routes. It has no data or behaviour of its own: everything goes through `deps.service`.
import type { FetchHandler, InterfaceDeps, ServiceError } from "@usualmail/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { asServiceError, messageOf, safePath, statusOf, text, type Deps, type Env } from "./http/context.ts";
import { securityHeaders, serveAsset } from "./http/headers.ts";
import {
  cameFromThisSite,
  clearSession,
  clearSignInToken,
  cookieScope,
  formToken,
  isLocalHost,
  readSession,
  readSignInToken,
  sameToken,
  signInToken,
  writeSession,
} from "./http/session.ts";
import { errorPage, formRefusedPage, notFoundPage } from "./pages/errors.ts";
import { agentRefusedPage, signInPage } from "./pages/sign-in.ts";
import { aiRoutes } from "./routes/ai.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { homeRoutes } from "./routes/home.ts";
import { inboxRoutes } from "./routes/inboxes.ts";
import { ruleRoutes } from "./routes/rules.ts";
import { render, type Ctx } from "./routes/shared.ts";
import type { View } from "./view/layout.ts";
import { waitWords } from "./view/words.ts";

export interface DashboardOptions {
  /** The clock pages use for "today" and "Yesterday". Tests pin it. */
  now?: () => Date;
  /**
   * Where the server keeps a waiting owner's code, in its host's words: what follows "it" in "the server makes an
   * owner's code: it …". Default: a server its host starts itself, which prints it and writes owner-pairing-code.
   */
  ownerCodeWhere?: string;
}

/** Forms are small; the largest is an inbox's guide. */
const MAX_BODY = 256 * 1024;

/** Sign-in's own words for the two refusals a pairing code gets. */
function signInError(error: ServiceError): string {
  if (error.code === "unauthorized") return "That code didn't work. It may be mistyped, already used or expired.";
  if (error.code === "rate_limited") {
    // The server says how long the pairing limit holds; without that, the contract's ten minutes is the most.
    return `Too many wrong codes. Wait ${waitWords(error.retryAfter) ?? "up to ten minutes"}, then try again.`;
  }
  return messageOf(error);
}

/** "" or "/path", without a trailing slash. */
function normalBase(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  return trimmed && !trimmed.startsWith("/") ? `/${trimmed}` : trimmed;
}

export function createDashboard(interfaceDeps: InterfaceDeps, options: DashboardOptions = {}): FetchHandler {
  const deps: Deps = {
    service: interfaceDeps.service,
    authenticate: interfaceDeps.authenticate,
    base: normalBase(interfaceDeps.basePath),
    now: options.now ?? (() => new Date()),
  };
  const { base } = deps;

  // Routes are written from the dashboard's root. A request may arrive with the base still on its path (a server
  // that passes the request through) or without it (a server that strips the mount path); both work.
  const app = new Hono<Env>({
    getPath: (request) => {
      const path = new URL(request.url).pathname;
      if (base && (path === base || path.startsWith(`${base}/`))) return path.slice(base.length) || "/";
      return path;
    },
  });

  const ownerCodeWhere = options.ownerCodeWhere;
  const bareView = (csrf = ""): View => ({ base, csrf, now: deps.now(), ...(ownerCodeWhere !== undefined && { ownerCodeWhere }) });
  const signInPath = (next?: string) =>
    `${base}/sign-in${next && next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`;

  app.use("*", securityHeaders);
  app.use("*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return bodyLimit({ maxSize: MAX_BODY, onError: (ctx) => ctx.text("That form was too large.", 413) })(c, next);
  });

  app.get("/assets/*", (c) => serveAsset(c, c.req.path) ?? c.text("Not found", 404));

  // --- Signing in ------------------------------------------------------------------------------

  app.get("/sign-in", async (c) => {
    const scope = cookieScope(c.req.raw, base);
    const next = safePath(c.req.query("next") ?? "/", "/");
    const token = readSession(c, scope);
    const caller = token ? await deps.authenticate(token) : null;
    if (caller?.actor.kind === "person") return c.redirect(`${base}${next}`, 303);
    const url = new URL(c.req.url);
    const insecure = url.protocol === "http:" && !isLocalHost(url.hostname) && c.req.header("x-forwarded-proto") !== "https";
    const formTokenValue = signInToken(c, scope);
    return render(c, signInPage(bareView(), { formToken: formTokenValue, next, insecure, done: c.req.query("done") }));
  });

  app.post("/sign-in", async (c) => {
    const scope = cookieScope(c.req.raw, base);
    if (!cameFromThisSite(c.req.raw)) return render(c, formRefusedPage(bareView(), false), 403);
    const form = await c.req.parseBody({ all: true });
    const next = safePath(text(form, "next"), "/");
    const name = text(form, "name").trim().slice(0, 80) || "Web dashboard";
    const expected = readSignInToken(c, scope);
    const again = (status: Parameters<typeof render>[2], error: string) =>
      render(c, signInPage(bareView(), { formToken: signInToken(c, scope), next, name, error }), status);

    if (!expected || !sameToken(expected, text(form, "_csrf"))) {
      return again(403, "This sign-in form had expired. Type the code again.");
    }
    const code = text(form, "code").trim();
    if (!code) return again(400, "Type the pairing code.");

    let paired;
    try {
      paired = await deps.service.pair({ code, name });
    } catch (error) {
      const serviceError = asServiceError(error);
      if (!serviceError) throw error;
      return again(statusOf(serviceError), signInError(serviceError));
    }
    if (paired.device.kind !== "person") {
      // The code was made for an agent. Its new token is ended at once, so it can't be used from here.
      const agent = await deps.authenticate(paired.token).catch(() => null);
      if (agent) await deps.service.revokeDevice(agent, paired.device.id).catch(() => undefined);
      return again(403, "That code was made for an agent, so it can't sign in here. Use a code made for an app.");
    }
    writeSession(c, scope, paired.token);
    clearSignInToken(c, scope);
    return c.redirect(`${base}${next}`, 303);
  });

  // --- Everything below needs a person's session ---------------------------------------------------

  app.use("*", async (c, next) => {
    const scope = cookieScope(c.req.raw, base);
    const token = readSession(c, scope);
    const isPost = c.req.method === "POST";
    const back = isPost ? "/" : safePath(c.req.path + new URL(c.req.url).search, "/");
    if (!token) return c.redirect(signInPath(back), 303);
    const caller = await deps.authenticate(token);
    if (!caller) {
      clearSession(c, scope);
      return c.redirect(signInPath(back), 303);
    }
    if (caller.actor.kind !== "person") {
      clearSession(c, scope);
      return render(c as Ctx, agentRefusedPage(bareView()), 403);
    }
    const view = bareView(await formToken(token));
    c.set("caller", caller);
    c.set("deviceId", caller.actor.deviceId);
    c.set("view", view);
    if (isPost) {
      if (!cameFromThisSite(c.req.raw)) return render(c as Ctx, formRefusedPage(view, true), 403);
      const form = await c.req.parseBody({ all: true });
      if (!sameToken(text(form, "_csrf"), view.csrf)) return render(c as Ctx, formRefusedPage(view, true), 403);
      c.set("form", form);
    }
    return next();
  });

  app.post("/sign-out", async (c) => {
    await deps.service.revokeDevice(c.get("caller"), c.get("deviceId")).catch(() => undefined);
    clearSession(c, cookieScope(c.req.raw, base));
    return c.redirect(`${base}/sign-in?done=signed-out`, 303);
  });

  homeRoutes(app, deps);
  inboxRoutes(app, deps);
  ruleRoutes(app, deps);
  aiRoutes(app, deps);
  deviceRoutes(app, deps);

  app.notFound((c) => {
    const view = c.get("view");
    return render(c as Ctx, notFoundPage(view ?? bareView(), Boolean(view)), 404);
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    const view = c.get("view");
    const serviceError = asServiceError(error);
    if (serviceError?.code === "unauthorized") {
      // The token stopped working between the guard and the call, for example because it was revoked.
      clearSession(c, cookieScope(c.req.raw, base));
      return c.redirect(signInPath(), 303);
    }
    if (serviceError?.code === "not_found") return render(c as Ctx, notFoundPage(view ?? bareView(), Boolean(view)), 404);
    if (serviceError) {
      return render(c as Ctx, errorPage(view ?? bareView(), Boolean(view), "That didn't work", messageOf(serviceError)), statusOf(serviceError));
    }
    console.error("usual-mail dashboard:", error);
    return render(c as Ctx, errorPage(view ?? bareView(), Boolean(view), "Something went wrong", "The server ran into a problem. Try again in a moment."), 500);
  });

  return (request) => app.fetch(request);
}
