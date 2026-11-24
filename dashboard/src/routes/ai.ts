// Routes for the server's AI: the page, the key, each job's model, pause and test. All are a person's
// (the session guard lets only a person in). The key is sent to the service once and never kept or shown here.
import { AI_JOBS, type AiJob, type AiSettingsPatch } from "@usualmail/core";
import type { Hono } from "hono";
import { messageOf, statusOf, text, type Deps, type Env } from "../http/context.ts";
import { aiPage, chosenService, removeKeyPage, type AiPageOptions } from "../pages/ai.ts";
import { SERVICE_CHOICES } from "../view/ai.ts";
import { scrub } from "./credentials.ts";
import { attempt, callerOf, doneOf, formOf, go, render, viewOf, type Ctx } from "./shared.ts";

type Status = Parameters<typeof render>[2];

/** The longest key or model id the forms accept. */
const MAX_KEY = 1000;
const MAX_MODEL = 200;

export async function showAi(c: Ctx, deps: Deps, o: AiPageOptions = {}, status: Status = 200) {
  const caller = callerOf(c);
  const [settings, aiStatus, inboxes, firstSync] = await Promise.all([
    deps.service.aiSettings(caller),
    deps.service.aiStatus(caller),
    deps.service.listInboxes(caller),
    deps.service.firstSyncWindow(caller),
  ]);
  // The words for the service the key form is for, as the server builds them: the same the command and the apps show.
  const words = await deps.service.aiDisclosure(caller, chosenService(settings, o.service)[2]);
  return render(c, aiPage(viewOf(c), { settings, status: aiStatus, inboxes, words, firstSync }, o), status);
}

export function aiRoutes(app: Hono<Env>, deps: Deps): void {
  const { service } = deps;

  /** Changes the settings; on an error shows the page again with the service's words where the form is. */
  async function change(c: Ctx, patch: AiSettingsPatch, done: string, onError: (message: string) => AiPageOptions) {
    const outcome = await attempt(() => service.updateAiSettings(callerOf(c), patch));
    if (!outcome.ok) return showAi(c, deps, onError(messageOf(outcome.error)), statusOf(outcome.error));
    return go(c, deps, "/ai", done);
  }

  app.get("/ai", (c) => showAi(c, deps, { done: doneOf(c), ...(c.req.query("service") ? { service: c.req.query("service")! } : {}) }));

  app.post("/ai/key", async (c) => {
    const form = formOf(c);
    const choice = SERVICE_CHOICES.find(([value]) => value === text(form, "service"));
    const apiKey = text(form, "apiKey").trim();
    // The service is the one whose words the page showed above the key: saving is the person's yes to it.
    if (!choice) return showAi(c, deps, { keyError: "Choose which service the key is for." }, 400);
    const service = choice[0];
    if (!apiKey || apiKey.length > MAX_KEY) return showAi(c, deps, { service, keyError: "Type the key." }, 400);
    const credentials = { ...choice[2], apiKey } as AiSettingsPatch["credentials"];
    // A service that repeats the key in its answer can't make this page show it.
    return change(c, { credentials }, "ai-key-saved", (message) => ({ service, keyError: scrub(message, [apiKey]) }));
  });

  app.post("/ai/models", async (c) => {
    const form = formOf(c);
    const settings = await service.aiSettings(callerOf(c));
    const values: Partial<Record<string, string>> = {};
    const models: Partial<Record<AiJob, string | null>> = {};
    for (const job of AI_JOBS) {
      const typed = text(form, job).trim();
      values[job] = typed;
      if (/\s/.test(typed) || typed.length > MAX_MODEL) {
        return showAi(c, deps, { models: { values, error: `The model for ${job} is an id without spaces, or empty for the default.` } }, 400);
      }
      const model = typed || null;
      // Only what changed: saving a model tests it at once, which costs a request.
      if (model !== (settings.jobs.find((item) => item.job === job)?.model ?? null)) models[job] = model;
    }
    if (!Object.keys(models).length) return go(c, deps, "/ai", "saved");
    return change(c, { models }, "ai-models-saved", (message) => ({ models: { values, error: message } }));
  });

  app.post("/ai/pause", async (c) => {
    const paused = text(formOf(c), "paused") === "yes";
    return change(c, { paused }, paused ? "ai-paused" : "ai-resumed", (message) => ({ error: message }));
  });

  // Removing the key is setting the credentials to nothing (docs/contract-ai.md): a page asks first.
  app.get("/ai/remove", async (c) => {
    const caller = callerOf(c);
    const [settings, inboxes] = await Promise.all([service.aiSettings(caller), service.listInboxes(caller)]);
    if (!settings.credentialsSet) return go(c, deps, "/ai");
    return render(c, removeKeyPage(viewOf(c), { settings, inboxes }));
  });

  app.post("/ai/remove", async (c) => {
    const caller = callerOf(c);
    const settings = await service.aiSettings(caller);
    if (!settings.credentialsSet) return go(c, deps, "/ai");
    const outcome = await attempt(() => service.updateAiSettings(caller, { credentials: null }));
    if (!outcome.ok) {
      return render(c, removeKeyPage(viewOf(c), { settings, inboxes: await service.listInboxes(caller) }, messageOf(outcome.error)), statusOf(outcome.error));
    }
    return go(c, deps, "/ai", "ai-key-removed");
  });

  app.post("/ai/test", async (c) => {
    const outcome = await attempt(() => service.testAi(callerOf(c)));
    if (!outcome.ok) return showAi(c, deps, { error: messageOf(outcome.error) }, statusOf(outcome.error));
    return go(c, deps, "/ai", "ai-tested");
  });
}
