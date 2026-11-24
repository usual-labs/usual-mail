// Routes for the Inboxes section: the list, connecting an inbox, one inbox's settings, and removing one.
import {
  INBOX_ICONS,
  TRUST_LEVELS,
  type Caller,
  type ConnectInboxInput,
  type Inbox,
  type InboxIcon,
  type InboxPatch,
  type TrustLevel,
} from "@usualmail/core";
import type { Hono } from "hono";
import { HATS, hatByKey, hatFor } from "../hats.ts";
import { messageOf, statusOf, text, texts, type Deps, type Env, type Form } from "../http/context.ts";
import { notFoundPage } from "../pages/errors.ts";
import { connectPage, DEFAULT_CONNECT_VALUES, type ConnectProvider, type ConnectValues, type FieldErrors } from "../pages/connect.ts";
import { readCredentials, scrub } from "./credentials.ts";
import { googleRoutes } from "./google.ts";
import { inboxListPage, inboxPage, removeInboxPage, type InboxPageOptions } from "../pages/inboxes.ts";
import { attempt, callerOf, doneOf, findInbox, formOf, go, render, viewOf, type Ctx } from "./shared.ts";

const MAX_NAME = 80;
const MAX_GUIDE = 20_000;

const isTrust = (value: string): value is TrustLevel => (TRUST_LEVELS as readonly string[]).includes(value);
const isIcon = (value: string): value is InboxIcon => (INBOX_ICONS as readonly string[]).includes(value);
const checked = (form: Form, name: string) => texts(form, name).includes("on");

/** Reads the connect form. Returns what to show again (never a secret), the input if it is complete, and the secrets. */
export function readConnectForm(form: Form): {
  provider: ConnectProvider;
  values: ConnectValues;
  errors: FieldErrors;
  input?: ConnectInboxInput;
  secrets: string[];
} {
  const provider: ConnectProvider = text(form, "provider") === "gmail" ? "gmail" : "imap";
  const trustText = text(form, "trust");
  const read = readCredentials(form, provider);
  const values: ConnectValues = {
    name: text(form, "name").trim(),
    color: text(form, "color").trim().toLowerCase(),
    trust: isTrust(trustText) ? trustText : "suggest",
    ...read.values,
  };
  const errors: FieldErrors = { ...read.errors };
  if (!(values.name.length > 0 && values.name.length <= MAX_NAME)) errors.name = `Give the inbox a name of up to ${MAX_NAME} characters.`;
  if (!hatByKey(values.color)) errors.color = "Choose a colour.";

  const complete = Object.keys(errors).length === 0 && read.credentials;
  return {
    provider,
    values,
    errors,
    secrets: read.secrets,
    input: complete
      ? { name: values.name, color: values.color, provider, credentials: read.credentials, trust: values.trust }
      : undefined,
  };
}

/** A hat no inbox wears yet, so a new inbox stands apart. */
function freeHat(inboxes: Inbox[]): string {
  const worn = new Set(inboxes.map((inbox) => hatFor(inbox.color).key));
  return (HATS.find((hat) => !worn.has(hat.key)) ?? HATS[0]!).key;
}

async function agentsFor(deps: Deps, caller: Caller, inboxId: string) {
  const devices = await deps.service.listDevices(caller);
  return devices.filter((device) => device.kind === "agent" && device.inboxIds?.includes(inboxId));
}

export function inboxRoutes(app: Hono<Env>, deps: Deps): void {
  const { service } = deps;

  /** Whether the server can connect Gmail by signing in with Google: the choice is shown only then. */
  const googleReady = async () => (await service.info()).googleSignIn?.available === true;

  async function showInbox(c: Ctx, id: string, o: InboxPageOptions = {}, status: Parameters<typeof render>[2] = 200) {
    const caller = callerOf(c);
    const { inbox, inboxes } = await findInbox(deps, caller, id);
    if (!inbox) return render(c, notFoundPage(viewOf(c), true, "This inbox isn't on this server."), 404);
    const [agents, google] = await Promise.all([agentsFor(deps, caller, id), googleReady()]);
    return render(c, inboxPage(viewOf(c), inbox, { agents, total: inboxes.length, google }, o), status);
  }

  /** The Gmail connect page, with the Google choice when the server has it. */
  async function showConnect(c: Ctx, provider: ConnectProvider, o: Parameters<typeof connectPage>[2], status: Parameters<typeof render>[2] = 200) {
    const google = provider === "gmail" && (await googleReady());
    const { google: typed, ...rest } = o ?? {};
    return render(c, connectPage(viewOf(c), provider, { ...rest, ...(google ? { google: typed ?? {} } : {}) }), status);
  }

  googleRoutes(app, deps, {
    connect: async (c, o, status) => {
      const inboxes = await service.listInboxes(callerOf(c));
      const values = { ...DEFAULT_CONNECT_VALUES, color: freeHat(inboxes) };
      return showConnect(c, "gmail", { values, google: { name: o.name, color: o.color, error: o.error } }, status);
    },
    inbox: (c, id, error, status) => showInbox(c, id, { error }, status),
  });

  /** Changes an inbox with one form's fields; on an error shows the page again with what was typed. */
  async function change(c: Ctx, id: string, patch: (inbox: Inbox, form: Form) => InboxPatch | string, done = "saved", keep?: InboxPageOptions["values"]) {
    const caller = callerOf(c);
    const { inbox } = await findInbox(deps, caller, id);
    if (!inbox) return render(c, notFoundPage(viewOf(c), true, "This inbox isn't on this server."), 404);
    const result = patch(inbox, formOf(c));
    if (typeof result === "string") return showInbox(c, id, { error: result, values: keep }, 400);
    if (Object.keys(result).length) {
      const outcome = await attempt(() => service.updateInbox(caller, id, result));
      if (!outcome.ok) return showInbox(c, id, { error: messageOf(outcome.error), values: keep }, statusOf(outcome.error));
    }
    return go(c, deps, `/inboxes/${encodeURIComponent(id)}`, done);
  }

  app.get("/inboxes", async (c) => {
    const inboxes = await service.listInboxes(callerOf(c));
    return render(c, inboxListPage(viewOf(c), inboxes, { done: doneOf(c) }));
  });

  app.get("/inboxes/new", async (c) => {
    const provider: ConnectProvider = c.req.query("provider") === "gmail" ? "gmail" : "imap";
    const inboxes = await service.listInboxes(callerOf(c));
    const color = freeHat(inboxes);
    return showConnect(c, provider, { values: { ...DEFAULT_CONNECT_VALUES, color }, google: { color } });
  });

  app.post("/inboxes", async (c) => {
    const read = readConnectForm(formOf(c));
    if (!read.input) {
      return showConnect(c, read.provider, { values: read.values, errors: read.errors, error: "Some fields need a look." }, 400);
    }
    const input = read.input;
    const outcome = await attempt(() => service.connectInbox(callerOf(c), input));
    if (!outcome.ok) {
      const error = scrub(messageOf(outcome.error), read.secrets);
      return showConnect(c, read.provider, { values: read.values, error }, statusOf(outcome.error));
    }
    return go(c, deps, `/inboxes/${encodeURIComponent(outcome.value.id)}`, "connected");
  });

  app.get("/inboxes/:id", (c) => showInbox(c, c.req.param("id"), { done: doneOf(c) }));

  app.post("/inboxes/:id/name", (c) => {
    const form = formOf(c);
    const name = text(form, "name").trim();
    const color = text(form, "color").trim().toLowerCase();
    return change(
      c,
      c.req.param("id"),
      (inbox) => {
        if (!name || name.length > MAX_NAME) return `Give the inbox a name of up to ${MAX_NAME} characters.`;
        const hat = hatByKey(color);
        if (!hat) return "Choose one of the twelve colours.";
        const patch: InboxPatch = {};
        if (name !== inbox.name) patch.name = name;
        // A stored colour that isn't a hat key shows as its nearest hat; keep it unless another hat was picked.
        if (hat.key !== hatFor(inbox.color).key) patch.color = hat.key;
        return patch;
      },
      "saved",
      { name, color: color || undefined },
    );
  });

  app.post("/inboxes/:id/trust", (c) => {
    const trust = text(formOf(c), "trust");
    return change(c, c.req.param("id"), (inbox) => {
      if (!isTrust(trust)) return "Choose how much rules and agents may do.";
      return trust === inbox.trust ? {} : { trust };
    });
  });

  app.post("/inboxes/:id/agents", (c) => {
    const agentAccess = checked(formOf(c), "agentAccess");
    return change(c, c.req.param("id"), (inbox) => (agentAccess === inbox.agentAccess ? {} : { agentAccess }));
  });

  app.post("/inboxes/:id/guide", (c) => {
    const guide = text(formOf(c), "guide").replace(/\r\n?/g, "\n");
    return change(
      c,
      c.req.param("id"),
      (inbox) => {
        if (guide.length > MAX_GUIDE) return `The guide can be up to ${MAX_GUIDE.toLocaleString("en")} characters.`;
        return guide === inbox.guide ? {} : { guide };
      },
      "saved",
      { guide },
    );
  });

  app.post("/inboxes/:id/place", (c) => {
    const form = formOf(c);
    const icon = text(form, "icon");
    const place = text(form, "position");
    return change(c, c.req.param("id"), (inbox) => {
      if (!isIcon(icon)) return "Choose one of the six icons.";
      if (!/^\d+$/.test(place) || Number(place) < 1) return "Choose a place in the list.";
      const patch: InboxPatch = {};
      if (icon !== inbox.icon) patch.icon = icon;
      if (Number(place) - 1 !== inbox.position) patch.position = Number(place) - 1;
      return patch;
    });
  });

  app.post("/inboxes/:id/pause", (c) => {
    const paused = text(formOf(c), "paused") === "yes";
    return change(c, c.req.param("id"), () => ({ paused }), paused ? "paused" : "resumed");
  });

  app.post("/inboxes/:id/sync", async (c) => {
    const id = c.req.param("id");
    const outcome = await attempt(() => service.syncInbox(callerOf(c), id));
    if (!outcome.ok) return showInbox(c, id, { error: messageOf(outcome.error) }, statusOf(outcome.error));
    return go(c, deps, `/inboxes/${encodeURIComponent(id)}`, "syncing");
  });

  // New credentials for the same mailbox. The server checks them with the provider before keeping them; when the
  // provider refuses (provider_error) or names another address (invalid), nothing changes and its words are shown.
  app.post("/inboxes/:id/reconnect", async (c) => {
    const caller = callerOf(c);
    const { inbox } = await findInbox(deps, caller, c.req.param("id"));
    if (!inbox) return render(c, notFoundPage(viewOf(c), true, "This inbox isn't on this server."), 404);
    const read = readCredentials(formOf(c), inbox.provider);
    if (!read.credentials) {
      return showInbox(c, inbox.id, { reconnect: { values: read.values, errors: read.errors, error: "Some fields need a look." } }, 400);
    }
    const credentials = read.credentials;
    const outcome = await attempt(() => service.updateInbox(caller, inbox.id, { credentials }));
    if (!outcome.ok) {
      const error = scrub(messageOf(outcome.error), read.secrets);
      return showInbox(c, inbox.id, { reconnect: { values: read.values, errors: {}, error } }, statusOf(outcome.error));
    }
    return go(c, deps, `/inboxes/${encodeURIComponent(inbox.id)}`, "reconnected");
  });

  app.get("/inboxes/:id/remove", async (c) => {
    const { inbox } = await findInbox(deps, callerOf(c), c.req.param("id"));
    if (!inbox) return render(c, notFoundPage(viewOf(c), true, "This inbox isn't on this server."), 404);
    return render(c, removeInboxPage(viewOf(c), inbox));
  });

  app.post("/inboxes/:id/remove", async (c) => {
    const caller = callerOf(c);
    const { inbox } = await findInbox(deps, caller, c.req.param("id"));
    if (!inbox) return render(c, notFoundPage(viewOf(c), true, "This inbox isn't on this server."), 404);
    const outcome = await attempt(() => service.removeInbox(caller, inbox.id));
    if (!outcome.ok) return render(c, removeInboxPage(viewOf(c), inbox, messageOf(outcome.error)), statusOf(outcome.error));
    return go(c, deps, "/inboxes", "removed");
  });
}
