// Starting a Google sign-in from the dashboard: for a new Gmail inbox, or to reconnect one in place. A form posts here
// and the answer is a page that links on to Google; a form redirecting off-site would break the page's form-action.
import type { GoogleSignInStart, Inbox } from "@usualmail/core";
import type { Hono } from "hono";
import { hatByKey } from "../hats.ts";
import { messageOf, statusOf, text, type Deps, type Env } from "../http/context.ts";
import { notFoundPage } from "../pages/errors.ts";
import { continueToGooglePage } from "../pages/google.ts";
import { attempt, callerOf, findInbox, formOf, render, viewOf, type Ctx } from "./shared.ts";

const MAX_NAME = 80;

/** Google's address, linked only when it is a web address. */
function linkable(url: string): boolean {
  return /^https?:\/\//.test(url);
}

export function googleRoutes(app: Hono<Env>, deps: Deps, show: {
  connect: (c: Ctx, o: { name: string; color: string; error: string }, status: 400 | 409 | 403 | 404 | 500 | 502) => Promise<Response>;
  inbox: (c: Ctx, id: string, error: string, status: 400 | 409 | 403 | 404 | 500 | 502) => Promise<Response>;
}): void {
  const { service } = deps;

  async function answer(c: Ctx, started: GoogleSignInStart, inbox: Inbox | undefined, failed: (error: string) => Promise<Response>) {
    if (!linkable(started.url)) return failed("The server answered with an address that isn't a web address, so it isn't shown. Try again.");
    c.header("cache-control", "no-store");
    return render(c, continueToGooglePage(viewOf(c), { url: started.url, expiresAt: started.expiresAt, ...(inbox ? { inbox } : {}) }));
  }

  app.post("/inboxes/google", async (c) => {
    const form = formOf(c);
    const name = text(form, "name").trim();
    const color = text(form, "color").trim().toLowerCase();
    const failed = (error: string, status: 400 | 409 | 403 | 404 | 500 | 502 = 502) => show.connect(c, { name, color, error }, status);
    if (!name || name.length > MAX_NAME) return failed(`Give the inbox a name of up to ${MAX_NAME} characters.`, 400);
    const hat = hatByKey(color);
    if (!hat) return failed("Choose a colour.", 400);
    const outcome = await attempt(() => service.startGoogleSignIn(callerOf(c), { name, color: hat.key }));
    if (!outcome.ok) return failed(messageOf(outcome.error), statusOf(outcome.error) as 409);
    return answer(c, outcome.value, undefined, (error) => failed(error));
  });

  app.post("/inboxes/:id/google", async (c) => {
    const caller = callerOf(c);
    const { inbox } = await findInbox(deps, caller, c.req.param("id"));
    if (!inbox) return render(c, notFoundPage(viewOf(c), true, "This inbox isn't on this server."), 404);
    const failed = (error: string, status: 400 | 409 | 403 | 404 | 500 | 502 = 502) => show.inbox(c, inbox.id, error, status);
    const outcome = await attempt(() => service.startGoogleSignIn(caller, { inboxId: inbox.id }));
    if (!outcome.ok) return failed(messageOf(outcome.error), statusOf(outcome.error) as 409);
    return answer(c, outcome.value, inbox, (error) => failed(error));
  });
}
