// Routes for the owner's password (docs/contract.md, "The owner's password"): before any session, setting up an
// unclaimed server (with Google's proof when the host named the owner's email) and asking for a recovery code; with
// one, the Account page that sets the password. Signing in with the password is app.ts's `POST /sign-in`.
import { NO_OWNER_INFO, type OwnerInfo, type ServiceError } from "@usualmail/core";
import type { Hono } from "hono";
import { asServiceError, messageOf, statusOf, text, type Deps, type Env } from "../http/context.ts";
import { cameFromThisSite, clearSignInToken, cookieScope, readSignInToken, sameToken, signInToken, writeSession } from "../http/session.ts";
import { formRefusedPage } from "../pages/errors.ts";
import { accountPage, claimGooglePage, claimPage, forgotPage, recoveryWaitingPage } from "../pages/owner.ts";
import type { View } from "../view/layout.ts";
import { callerOf, doneOf, formOf, go, render, viewOf, type Ctx } from "./shared.ts";

/** The owner as `info` says, or as an older server's missing answer means. */
export async function ownerInfoOf(deps: Deps): Promise<OwnerInfo> {
  return (await deps.service.info()).owner ?? NO_OWNER_INFO;
}

/** Two password fields that must agree; the error to show when they don't. */
function passwordsDiffer(form: Parameters<typeof text>[0]): string | null {
  return text(form, "password") === text(form, "passwordAgain") ? null : "The two passwords aren't the same. Type them again.";
}

/** Before any session: setting up an unclaimed server, and recovery codes. `bareView` is a page's view without one. */
export function ownerOpenRoutes(app: Hono<Env>, deps: Deps, bareView: () => View): void {
  const { base, service } = deps;

  /** A form posted before any session: refused when another site sent it, else its fields (`tokenOk` checks its token). */
  async function refused(c: Ctx): Promise<{ response?: Response; form?: Parameters<typeof text>[0] }> {
    if (!cameFromThisSite(c.req.raw)) return { response: render(c, formRefusedPage(bareView(), false), 403) };
    return { form: await c.req.parseBody({ all: true }) };
  }

  /** Whether the form carries the sign-in form's own token (double submit). */
  const tokenOk = (c: Ctx, form: Parameters<typeof text>[0]) => {
    const expected = readSignInToken(c, cookieScope(c.req.raw, base));
    return Boolean(expected && sameToken(expected, text(form, "_csrf")));
  };

  app.get("/claim", async (c) => {
    const owner = await ownerInfoOf(deps);
    if (!owner.claimable) return c.redirect(`${base}/sign-in`, 303);
    const proof = c.req.query("proof") ?? undefined;
    const formToken = signInToken(c, cookieScope(c.req.raw, base));
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    return render(c as Ctx, claimPage(bareView(), { formToken, claim: owner.claim ?? "password", ...(proof && { proof }) }));
  });

  app.post("/claim", async (c) => {
    const { response, form } = await refused(c as Ctx);
    if (response) return response;
    const scope = cookieScope(c.req.raw, base);
    const owner = await ownerInfoOf(deps);
    if (!owner.claimable) return c.redirect(`${base}/sign-in`, 303);
    const proof = text(form!, "proof") || undefined;
    const email = text(form!, "email").trim();
    const name = text(form!, "name").trim().slice(0, 80) || "Web dashboard";
    const again = (status: Parameters<typeof render>[2], error: string) =>
      render(c as Ctx, claimPage(bareView(), { formToken: signInToken(c, scope), claim: owner.claim ?? "password", email, name, error, ...(proof && { proof }) }), status);
    if (!tokenOk(c as Ctx, form!)) return again(403, "This form had expired. Type the password again.");
    const differ = passwordsDiffer(form!);
    if (differ) return again(400, differ);
    let claimed;
    try {
      claimed = await service.claimOwner({ password: text(form!, "password"), name, ...(email && { email }), ...(proof && { proof }) });
    } catch (error) {
      const serviceError = asServiceError(error);
      if (!serviceError) throw error;
      if (serviceError.code === "conflict") return c.redirect(`${base}/sign-in`, 303);
      return again(statusOf(serviceError), messageOf(serviceError));
    }
    writeSession(c, scope, claimed.token);
    clearSignInToken(c, scope);
    return c.redirect(`${base}/?done=claimed`, 303);
  });

  app.post("/claim/google", async (c) => {
    const { response, form } = await refused(c as Ctx);
    if (response) return response;
    const scope = cookieScope(c.req.raw, base);
    const owner = await ownerInfoOf(deps);
    if (!owner.claimable) return c.redirect(`${base}/sign-in`, 303);
    const again = (status: Parameters<typeof render>[2], error: string) =>
      render(c as Ctx, claimPage(bareView(), { formToken: signInToken(c, scope), claim: owner.claim ?? "google", error }), status);
    if (!tokenOk(c as Ctx, form!)) return again(403, "This form had expired. Press the button again.");
    try {
      const start = await service.startOwnerClaim();
      return render(c as Ctx, claimGooglePage(bareView(), start.url));
    } catch (error) {
      const serviceError = asServiceError(error);
      if (!serviceError) throw error;
      return again(statusOf(serviceError), messageOf(serviceError));
    }
  });

  app.get("/forgot", (c) => render(c as Ctx, forgotPage(bareView(), signInToken(c, cookieScope(c.req.raw, base)))));

  app.post("/forgot", async (c) => {
    const { response, form } = await refused(c as Ctx);
    if (response) return response;
    const scope = cookieScope(c.req.raw, base);
    if (!tokenOk(c as Ctx, form!)) return render(c as Ctx, forgotPage(bareView(), signInToken(c, scope), "This form had expired. Press the button again."), 403);
    try {
      return render(c as Ctx, recoveryWaitingPage(bareView(), await service.requestRecoveryCode()));
    } catch (error) {
      const serviceError = asServiceError(error) as ServiceError | null;
      if (!serviceError) throw error;
      return render(c as Ctx, forgotPage(bareView(), signInToken(c, scope), messageOf(serviceError)), statusOf(serviceError));
    }
  });
}

/** With a person's session: the Account page. */
export function accountRoutes(app: Hono<Env>, deps: Deps): void {
  const { service } = deps;

  app.get("/account", async (c) => render(c, accountPage(viewOf(c), await service.owner(callerOf(c)), { done: doneOf(c) })));

  app.post("/account/password", async (c) => {
    const caller = callerOf(c);
    const form = formOf(c);
    const differ = passwordsDiffer(form);
    if (differ) return render(c, accountPage(viewOf(c), await service.owner(caller), { error: differ }), 400);
    try {
      await service.setOwnerPassword(caller, { password: text(form, "password") });
    } catch (error) {
      const serviceError = asServiceError(error);
      if (!serviceError) throw error;
      return render(c, accountPage(viewOf(c), await service.owner(caller), { error: messageOf(serviceError) }), statusOf(serviceError));
    }
    return go(c, deps, "/account", "password-set");
  });
}
