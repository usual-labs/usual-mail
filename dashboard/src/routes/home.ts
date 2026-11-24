// Home and Handled: what needs the person, and what rules and agents did. Approve, reject, undo and the teach
// question all come back here.
import type { ActionState, Rule } from "@usualmail/core";
import type { Hono } from "hono";
import { messageOf, safePath, statusOf, text, texts, type Deps, type Env } from "../http/context.ts";
import { handledPage } from "../pages/handled.ts";
import { homePage } from "../pages/home.ts";
import { isSuggestion } from "../pages/rules.ts";
import { NEEDS_PERSON_STATES } from "../view/ai.ts";
import { attempt, callerOf, doneOf, formOf, go, render, viewOf, type Ctx } from "./shared.ts";

const HOME_WAITING = 5;
/** Every proposal is shown on Handled, up to the service's largest page. */
const ALL_WAITING = 200;
const HISTORY_PAGE = 50;
const HISTORY_STATES: ActionState[] = ["applied", "undone", "rejected", "failed"];
/** Home asks for this many records that need a look (`attentionOnly`); Handled has the rest. */
const TROUBLE_PAGE = 50;
const DRAFTS_PAGE = 200;

type Status = Parameters<typeof render>[2];

/**
 * What needs the person: inboxes with a problem, proposals, records that went wrong or carry a note from the
 * provider (Handled with `attentionOnly`, whoever made them, so the person's own refused changes too), drafts that
 * didn't send, rules agents suggested, and the server's AI when it stopped for something only a person can fix (a key
 * refused, a model not found, no credit). Silent records are never part of it: a record that went wrong or has a
 * note is never silent, and any marked silent is dropped.
 */
export async function showHome(c: Ctx, deps: Deps, o: { done?: string; error?: string } = {}, status: Status = 200) {
  const caller = callerOf(c);
  const [inboxes, waiting, attention, drafts, aiStatus] = await Promise.all([
    deps.service.listInboxes(caller),
    deps.service.handled(caller, { states: ["proposed"], limit: HOME_WAITING }),
    deps.service.handled(caller, { attentionOnly: true, limit: TROUBLE_PAGE }),
    deps.service.listDrafts(caller, { limit: DRAFTS_PAGE }),
    deps.service.aiStatus(caller),
  ]);
  const ai = NEEDS_PERSON_STATES.includes(aiStatus.state) ? { status: aiStatus, settings: await deps.service.aiSettings(caller) } : undefined;
  const rules = await Promise.all(inboxes.map((inbox) => deps.service.listRules(caller, inbox.id)));
  const suggestions: Rule[] = rules.flat().filter(isSuggestion);
  const trouble = attention.items.filter((item) => !item.record.silent);
  return render(
    c,
    homePage(
      viewOf(c),
      {
        inboxes,
        waiting: waiting.items.filter((item) => !item.record.silent),
        moreWaiting: Boolean(waiting.nextCursor),
        trouble,
        moreTrouble: Boolean(attention.nextCursor),
        failedDrafts: drafts.items.filter((draft) => draft.state === "failed"),
        suggestions,
        ...(ai ? { ai } : {}),
      },
      o,
    ),
    status,
  );
}

/** Handled for the query in `path` (a dashboard path such as "/handled?inbox=..."). */
export async function showHandled(
  c: Ctx,
  deps: Deps,
  path: string,
  o: Parameters<typeof handledPage>[2] = {},
  status: Status = 200,
) {
  const caller = callerOf(c);
  const params = new URL(path, "http://dashboard.invalid").searchParams;
  const inboxes = await deps.service.listInboxes(caller);
  const requested = params.get("inbox") ?? undefined;
  const inboxId = inboxes.some((inbox) => inbox.id === requested) ? requested : undefined;
  const cursor = params.get("cursor") || undefined;
  const includeSilent = params.get("silent") === "1";
  const [waiting, history] = await Promise.all([
    deps.service.handled(caller, { states: ["proposed"], inboxId, limit: ALL_WAITING }),
    deps.service.handled(caller, {
      states: HISTORY_STATES,
      inboxId,
      cursor,
      limit: HISTORY_PAGE,
      ...(includeSilent ? { includeSilent: true } : {}),
    }),
  ]);
  return render(
    c,
    handledPage(
      viewOf(c),
      {
        inboxes,
        waiting: waiting.items,
        moreWaiting: Boolean(waiting.nextCursor),
        history: history.items,
        inboxId,
        includeSilent,
        cursor,
        nextCursor: history.nextCursor,
      },
      o,
    ),
    status,
  );
}

/** Where a form on Home or Handled returns to: one of those two pages, nothing else. */
function returnPath(value: string): string {
  const path = safePath(value, "/handled");
  return path === "/" || path === "/handled" || path.startsWith("/handled?") ? path : "/handled";
}

export function homeRoutes(app: Hono<Env>, deps: Deps): void {
  const { service } = deps;

  /** Shows the page a form came from again, with what went wrong. */
  const showError = (c: Ctx, back: string, message: string, status: Status) =>
    back === "/" ? showHome(c, deps, { error: message }, status) : showHandled(c, deps, back, { error: message }, status);

  app.get("/", (c) => showHome(c, deps, { done: doneOf(c) }));

  app.get("/handled", (c) => {
    const url = new URL(c.req.url);
    return showHandled(c, deps, `/handled${url.search}`, { done: doneOf(c) });
  });

  for (const [path, method, done] of [
    ["/handled/approve", "approve", "approved"],
    ["/handled/reject", "reject", "rejected"],
  ] as const) {
    app.post(path, async (c) => {
      const form = formOf(c);
      const back = returnPath(text(form, "return"));
      const ids = texts(form, "ids").filter(Boolean);
      if (!ids.length) return showError(c, back, "Nothing was chosen.", 400);
      const outcome = await attempt(() => service[method](callerOf(c), ids));
      if (!outcome.ok) return showError(c, back, messageOf(outcome.error), statusOf(outcome.error));
      return go(c, deps, back, done);
    });
  }

  app.post("/handled/:id/undo", async (c) => {
    const back = returnPath(text(formOf(c), "return"));
    const outcome = await attempt(() => service.undo(callerOf(c), c.req.param("id")));
    if (!outcome.ok) return showError(c, back, messageOf(outcome.error), statusOf(outcome.error));
    // The server may ask one question to turn the correction into a rule. Show it here instead of redirecting,
    // because it can't be fetched again.
    const teach = outcome.value.teach;
    if (teach) return showHandled(c, deps, back === "/" ? "/handled" : back, { done: "undone", teach });
    return go(c, deps, back, "undone");
  });

  app.post("/teach/:id", async (c) => {
    const form = formOf(c);
    const back = returnPath(text(form, "return"));
    const accept = text(form, "accept") === "yes";
    const outcome = await attempt(() => service.answerTeach(callerOf(c), c.req.param("id"), accept));
    if (!outcome.ok) return showError(c, back, messageOf(outcome.error), statusOf(outcome.error));
    return go(c, deps, back, outcome.value ? "taught" : "not-taught");
  });
}

