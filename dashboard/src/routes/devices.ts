// Routes for devices and agents: the list, pairing codes for an app or an agent, and removing one.
import type { Hono } from "hono";
import { clearSession, cookieScope } from "../http/session.ts";
import { messageOf, statusOf, texts, type Deps, type Env } from "../http/context.ts";
import { devicesPage, pairingCodePage } from "../pages/devices.ts";
import { attempt, callerOf, doneOf, formOf, go, render, viewOf, type Ctx } from "./shared.ts";

export function deviceRoutes(app: Hono<Env>, deps: Deps): void {
  const { service } = deps;

  async function showDevices(c: Ctx, o: Parameters<typeof devicesPage>[4] = {}, status: Parameters<typeof render>[2] = 200) {
    const caller = callerOf(c);
    const [devices, inboxes] = await Promise.all([service.listDevices(caller), service.listInboxes(caller)]);
    return render(c, devicesPage(viewOf(c), devices, inboxes, c.get("deviceId"), o), status);
  }

  app.get("/devices", (c) => showDevices(c, { done: doneOf(c) }));

  // The code is shown in the answer to the form, never put in a URL, and the page is not cached.
  app.post("/devices/pair-app", async (c) => {
    const outcome = await attempt(() => service.createPairingCode(callerOf(c), { kind: "person" }));
    if (!outcome.ok) return showDevices(c, { error: messageOf(outcome.error) }, statusOf(outcome.error));
    return render(c, pairingCodePage(viewOf(c), outcome.value, "person", []));
  });

  app.post("/devices/pair-agent", async (c) => {
    const caller = callerOf(c);
    const inboxes = await service.listInboxes(caller);
    const chosen = texts(formOf(c), "inboxIds");
    const given = inboxes.filter((inbox) => chosen.includes(inbox.id));
    if (!given.length) return showDevices(c, { error: "Choose at least one inbox the agent may see.", chosen }, 400);
    const inboxIds = given.map((inbox) => inbox.id);
    const outcome = await attempt(() => service.createPairingCode(caller, { kind: "agent", inboxIds }));
    if (!outcome.ok) return showDevices(c, { error: messageOf(outcome.error), chosen }, statusOf(outcome.error));
    return render(c, pairingCodePage(viewOf(c), outcome.value, "agent", given));
  });

  app.post("/devices/:id/revoke", async (c) => {
    const id = c.req.param("id");
    const outcome = await attempt(() => service.revokeDevice(callerOf(c), id));
    if (!outcome.ok) return showDevices(c, { error: messageOf(outcome.error) }, statusOf(outcome.error));
    if (id === c.get("deviceId")) {
      clearSession(c, cookieScope(c.req.raw, deps.base));
      return go(c, deps, "/sign-in", "signed-out");
    }
    return go(c, deps, "/devices", "revoked");
  });
}
