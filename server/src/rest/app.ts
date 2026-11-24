// The REST surface: every route in core's ROUTES, mounted from one table so none can be missed. Handlers
// only translate HTTP to `MailServer` calls; the service validates and decides.

import {
  ERROR_STATUS,
  GOOGLE_CLIENT_FILE_MAX_BYTES,
  ROUTES,
  ServiceError,
  type ActInput,
  type ActionState,
  type AllowSenderInput,
  type AiConnection,
  type AiSettingsPatch,
  type FirstSyncWindowPatch,
  type Caller,
  type Category,
  type ConnectInboxInput,
  type DraftInput,
  type ErrorCode,
  type GoogleSignInInput,
  type BriefInput,
  type HandledQuery,
  type InboxPatch,
  type ListQuery,
  type PairingCodeInput,
  type PairInput,
  type RouteName,
  type RuleDraft,
  type SearchAskInput,
  type SearchKind,
  type SearchQuery,
  type SendersQuery,
  type Stack,
  type TriageDecision,
} from "@usualmail/core";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { signInPage } from "../google/page.ts";
import { clientWords } from "../google/words.ts";
import type { Log, Scheduler } from "../host.ts";
import type { MountedInterface } from "../parts.ts";
import type { MailServer } from "../service/server.ts";
import { eventStream } from "./events.ts";
import { attachmentResponse, avatarResponse, pictureResponse } from "./files.ts";
import { mountInterfaces } from "./mount.ts";

export interface RestOptions {
  scheduler: Scheduler;
  log: Log;
  /** How often the event stream sends a comment line. Default 25 seconds. */
  keepAliveMs?: number;
  /** Largest request body for the REST routes. Default 2 MB. Mounted interfaces set their own. */
  maxBodyBytes?: number;
  /** Interfaces served beside the REST routes, each under its base path. */
  interfaces?: readonly MountedInterface[];
}

type Env = { Variables: { auth?: { caller: Caller; token: string } } };
type Ctx = Context<Env>;

interface Request {
  c: Ctx;
  caller: Caller;
  token: string;
}

type Handler = (request: Request) => Promise<Response> | Response;

/** The largest body `POST /v1/pair` reads: a code and a device's name. */
export const PAIR_MAX_BYTES = 16 * 1024;

export function createApp(server: MailServer, options: RestOptions): Hono<Env> {
  const app = new Hono<Env>();
  const handlers = routeHandlers(server, options);
  const tooLarge = (words: string) => (c: Ctx) => errorResponse(c, new ServiceError("invalid", words), options.log);
  // Every route checks its token before reading any of its body, then reads the body only up to its limit (refused at
  // once when Content-Length says more, else as soon as more arrives): 16 KiB for the Google client's file and for
  // pairing, the general limit for the rest. A path that is no route reads nothing.
  const limits: Partial<Record<RouteName, MiddlewareHandler<Env>>> = {
    setGoogleClient: bodyLimit({ maxSize: GOOGLE_CLIENT_FILE_MAX_BYTES, onError: tooLarge(clientWords.tooLarge) }),
    pair: bodyLimit({ maxSize: PAIR_MAX_BYTES, onError: tooLarge("The request body is too large") }),
  };
  const general = bodyLimit({ maxSize: options.maxBodyBytes ?? 2 * 1024 * 1024, onError: tooLarge("The request body is too large") });
  for (const name of Object.keys(ROUTES) as RouteName[]) {
    const route = ROUTES[name];
    const handler = handlers[name];
    const auth: MiddlewareHandler<Env> = async (c, next) => {
      if (route.auth !== "none") c.set("auth", await callerFor(server, c, route.auth));
      await next();
    };
    app.on(route.method, route.path, auth, limits[name] ?? general, async (c) =>
      handler({ c, ...(c.get("auth") ?? { caller: { actor: { kind: "system" } }, token: "" }) }));
  }
  mountInterfaces(app, server, options.interfaces ?? []);
  app.notFound((c) => errorResponse(c, new ServiceError("not_found", "No such route"), options.log));
  app.onError((error, c) => errorResponse(c, error, options.log));
  return app;
}

function routeHandlers(server: MailServer, options: RestOptions): Record<RouteName, Handler> {
  const noContent = ({ c }: Request) => c.body(null, 204);
  return {
    health: ({ c }) => c.json({ ok: true }),
    info: async ({ c }) => c.json(await server.info()),

    pair: async ({ c }) => c.json(await server.pair(await body<PairInput>(c))),
    me: async ({ c, caller }) => c.json(await server.me(caller)),
    listDevices: async ({ c, caller }) => c.json(await server.listDevices(caller)),
    createPairingCode: async ({ c, caller }) => c.json(await server.createPairingCode(caller, await body<PairingCodeInput>(c))),
    revokeDevice: async (r) => (await server.revokeDevice(r.caller, r.c.req.param("id")!), noContent(r)),

    listInboxes: async ({ c, caller }) => c.json(await server.listInboxes(caller)),
    connectInbox: async ({ c, caller }) => c.json(await server.connectInbox(caller, await body<ConnectInboxInput>(c))),
    updateInbox: async ({ c, caller }) => c.json(await server.updateInbox(caller, c.req.param("id")!, await body<InboxPatch>(c))),
    removeInbox: async (r) => (await server.removeInbox(r.caller, r.c.req.param("id")!), noContent(r)),
    syncInbox: async (r) => (await server.syncInbox(r.caller, r.c.req.param("id")!), noContent(r)),

    startGoogleSignIn: async ({ c, caller }) => c.json(await server.startGoogleSignIn(caller, await body<GoogleSignInInput>(c))),
    googleSignIn: async ({ c, caller }) => c.json(await server.googleSignIn(caller, c.req.param("id")!)),
    // A page for the person's browser, not JSON. The query is read here and never logged.
    googleCallback: async ({ c }) => signInPage(await server.finishGoogleSignIn(new URL(c.req.url).searchParams)),
    googleSetup: async ({ c, caller }) => c.json(await server.googleSetup(caller)),
    // The body is the client file as Google downloads it, kept as it is: read as text, never logged or answered.
    setGoogleClient: async ({ c, caller }) => c.json(await server.setGoogleClient(caller, { file: await c.req.text(), ...replaceQuery(c) })),

    home: async ({ c, caller }) => c.json(await server.home(caller, listQuery(c))),
    category: async ({ c, caller }) => c.json(await server.category(caller, categories(c.req.param("category")!), listQuery(c))),
    stack: async ({ c, caller }) => c.json(await server.stack(caller, c.req.param("stack") as Stack, listQuery(c))),
    waiting: async ({ c, caller }) => c.json(await server.waiting(caller, listQuery(c))),
    screening: async ({ c, caller }) => c.json(await server.screening(caller, listQuery(c))),
    counts: async ({ c, caller }) => c.json(await server.counts(caller)),
    handled: async ({ c, caller }) => {
      const query: HandledQuery = listQuery(c);
      const states = c.req.query("states");
      if (states) query.states = states.split(",").map((s) => s.trim()) as ActionState[];
      for (const name of ["includeSilent", "attentionOnly"] as const) {
        const value = c.req.query(name);
        if (value === undefined) continue;
        if (value !== "true" && value !== "false") throw new ServiceError("invalid", `${name} must be true or false`);
        query[name] = value === "true";
      }
      return c.json(await server.handled(caller, query));
    },
    thread: async ({ c, caller }) => c.json(await server.thread(caller, c.req.param("id")!)),
    search: async ({ c, caller }) => c.json(await server.search(caller, searchQuery(c))),
    searchRemote: async ({ c, caller }) => c.json(await server.searchRemote(caller, searchQuery(c))),
    openRemote: async ({ c, caller }) => c.json(await server.openRemote(caller, c.req.param("id")!)),
    askSearch: async ({ c, caller }) => c.json(await server.askSearch(caller, await body<SearchAskInput>(c))),
    attachment: async ({ c, caller }) =>
      attachmentResponse(await server.fetchAttachment(caller, c.req.param("id")!, c.req.param("attachmentId")!)),
    picture: async ({ c, caller }) =>
      pictureResponse(await server.fetchPicture(caller, c.req.param("id")!, c.req.param("pictureId")!)),
    avatar: async ({ c, caller }) => avatarResponse(await server.fetchAvatar(caller, c.req.param("id")!)),

    senders: async ({ c, caller }) => {
      const query: SendersQuery = listQuery(c);
      const state = c.req.query("state");
      if (state !== undefined) query.state = state as "blocked";
      return c.json(await server.senders(caller, query));
    },
    allowSender: async ({ c, caller }) => c.json(await server.allowSender(caller, await body<AllowSenderInput>(c))),
    act: async ({ c, caller }) => c.json(await server.act(caller, await body<ActInput>(c))),
    undo: async ({ c, caller }) => c.json(await server.undo(caller, c.req.param("id")!)),
    approve: async ({ c, caller }) => c.json(await server.approve(caller, field(await body(c), "actionIds") as string[])),
    reject: async ({ c, caller }) => c.json(await server.reject(caller, field(await body(c), "actionIds") as string[])),

    listRules: async ({ c, caller }) => c.json(await server.listRules(caller, c.req.param("id")!)),
    createRule: async ({ c, caller }) => {
      const draft = await body<Omit<RuleDraft, "inboxId">>(c);
      if (!isObject(draft)) throw new ServiceError("invalid", "The body must be a rule: { text, match, then }");
      if ("inboxId" in draft) throw new ServiceError("invalid", "The inbox comes from the path; leave inboxId out");
      return c.json(await server.createRule(caller, { ...draft, inboxId: c.req.param("id")! }));
    },
    updateRule: async ({ c, caller }) => c.json(await server.updateRule(caller, c.req.param("id")!, await body(c))),
    deleteRule: async (r) => (await server.deleteRule(r.caller, r.c.req.param("id")!), noContent(r)),
    answerTeach: async ({ c, caller }) =>
      c.json(await server.answerTeach(caller, c.req.param("id")!, field(await body(c), "accept") as boolean)),

    triageQueue: async ({ c, caller }) => {
      const { inboxId, limit } = listQuery(c);
      return c.json(await server.triageQueue(caller, { ...(inboxId && { inboxId }), ...(limit !== undefined && { limit }) }));
    },
    decide: async ({ c, caller }) => c.json(await server.decide(caller, field(await body(c), "decisions") as TriageDecision[])),

    listDrafts: async ({ c, caller }) => c.json(await server.listDrafts(caller, listQuery(c))),
    saveDraft: async ({ c, caller }) => c.json(await server.saveDraft(caller, await body<DraftInput>(c))),
    deleteDraft: async (r) => (await server.deleteDraft(r.caller, r.c.req.param("id")!), noContent(r)),
    sendDraft: async ({ c, caller }) => c.json(await server.sendDraft(caller, c.req.param("id")!)),

    aiSettings: async ({ c, caller }) => c.json(await server.aiSettings(caller)),
    updateAiSettings: async ({ c, caller }) => c.json(await server.updateAiSettings(caller, await body<AiSettingsPatch>(c))),
    aiStatus: async ({ c, caller }) => c.json(await server.aiStatus(caller)),
    aiDisclosure: async ({ c, caller }) => c.json(await server.aiDisclosure(caller, serviceQuery(c))),
    testAi: async ({ c, caller }) => c.json(await server.testAi(caller)),
    aiUsage: async ({ c, caller }) => c.json(await server.aiUsage(caller, c.req.query("tz") !== undefined ? { tz: c.req.query("tz")! } : {})),

    firstSyncWindow: async ({ c, caller }) => c.json(await server.firstSyncWindow(caller)),
    updateFirstSyncWindow: async ({ c, caller }) => c.json(await server.updateFirstSyncWindow(caller, await body<FirstSyncWindowPatch>(c))),

    latestBrief: async ({ c, caller }) => c.json(await server.latestBrief(caller)),
    brief: async ({ c, caller }) => c.json(await server.brief(caller, c.req.param("id")!)),
    writeBrief: async ({ c, caller }) => c.json(await server.writeBrief(caller, await body<BriefInput>(c))),

    events: ({ c, caller, token }) => eventStream(c, server, caller, token, options),
  };
}

/** The caller of a route that needs a token: `unauthorized` without a known one, `needs_person` for an agent where a person must call. */
async function callerFor(server: MailServer, c: Ctx, auth: "person" | "any"): Promise<{ caller: Caller; token: string }> {
  const token = bearer(c.req.header("authorization")) ?? "";
  const caller = token ? await server.authenticate(token) : null;
  if (!caller) throw new ServiceError("unauthorized", "Sign in with Authorization: Bearer <token> (from POST /v1/pair)");
  if (auth === "person" && caller.actor.kind !== "person") throw new ServiceError("needs_person", "Only a person's device can do this");
  return { caller, token };
}

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

/** `:category`: one category, or several joined by commas for one merged list. An empty name is invalid. */
function categories(param: string): Category[] {
  const names = param.split(",");
  if (names.some((name) => name.trim() === "")) throw new ServiceError("invalid", "Categories are joined by commas, with none empty");
  return names.map((name) => name.trim()) as Category[];
}

/** `?replace=true` or `false` for `PUT /v1/google/client`; anything else is `invalid`. */
function replaceQuery(c: Ctx): { replace?: boolean } {
  const value = c.req.query("replace");
  if (value === undefined) return {};
  if (value !== "true" && value !== "false") throw new ServiceError("invalid", clientWords.replaceFlag);
  return { replace: value === "true" };
}

/** `?gateway=vercel`, `?provider=openai` or `?provider=anthropic`: exactly one. The service checks the names. */
function serviceQuery(c: Ctx): AiConnection {
  const gateway = c.req.query("gateway");
  const provider = c.req.query("provider");
  if ((gateway === undefined) === (provider === undefined)) {
    throw new ServiceError("invalid", "Name the service: gateway=vercel, provider=openai or provider=anthropic");
  }
  return (gateway !== undefined ? { kind: "gateway", gateway } : { kind: "direct", provider }) as AiConnection;
}

/** `inboxId`, `cursor` and `limit` from the query string. */
function listQuery(c: Ctx): ListQuery {
  const query: ListQuery = {};
  const inboxId = c.req.query("inboxId");
  const cursor = c.req.query("cursor");
  const limit = c.req.query("limit");
  if (inboxId) query.inboxId = inboxId;
  if (cursor) query.cursor = cursor;
  if (limit !== undefined) {
    if (!/^\d+$/.test(limit)) throw new ServiceError("invalid", "limit must be a whole number");
    query.limit = Number(limit);
  }
  return query;
}

/**
 * A search's query parameters (core's `SearchQuery`): `inboxIds` and `kinds` comma-separated (`inboxId`, which earlier
 * clients send, counts as one of `inboxIds`), `hasAttachment` and `unread` as `true` or `false`, the rest as given.
 */
function searchQuery(c: Ctx): SearchQuery {
  const { inboxId, ...list } = listQuery(c);
  const query: SearchQuery = { ...list };
  const text = (name: "q" | "from" | "to" | "subject" | "after" | "before" | "tz") => {
    const value = c.req.query(name);
    if (value !== undefined) query[name] = value;
  };
  for (const name of ["q", "from", "to", "subject", "after", "before", "tz"] as const) text(name);
  const ids = [...(inboxId ? [inboxId] : []), ...listParam(c.req.query("inboxIds"))];
  if (ids.length) query.inboxIds = ids;
  const kinds = listParam(c.req.query("kinds"));
  if (kinds.length) query.kinds = kinds as SearchKind[];
  for (const name of ["hasAttachment", "unread"] as const) {
    const value = c.req.query(name);
    if (value === undefined) continue;
    if (value !== "true" && value !== "false") throw new ServiceError("invalid", `${name} must be true or false`);
    query[name] = value === "true";
  }
  return query;
}

function listParam(value: string | undefined): string[] {
  return value ? value.split(",").map((part) => part.trim()).filter(Boolean) : [];
}

async function body<T = unknown>(c: Ctx): Promise<T> {
  const text = await c.req.text();
  if (!text.trim()) throw new ServiceError("invalid", "This route needs a JSON body");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ServiceError("invalid", "The body isn't valid JSON");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The one field a wrapper body like `{ "actionIds": [..] }` carries. */
function field(value: unknown, name: string): unknown {
  if (!isObject(value) || !(name in value)) throw new ServiceError("invalid", `The body must be { "${name}": ... }`);
  const extra = Object.keys(value).filter((key) => key !== name);
  if (extra.length) throw new ServiceError("invalid", `Unexpected fields: ${extra.join(", ")}`);
  return value[name];
}

function serviceError(error: unknown): ServiceError | null {
  if (error instanceof ServiceError) return error;
  // A ServiceError from another copy of core (a bundled provider) still counts.
  const other = error instanceof Error && error.name === "ServiceError" ? (error as unknown as { code?: unknown; retryAfter?: unknown }) : undefined;
  if (other && typeof other.code === "string" && other.code in ERROR_STATUS) {
    const retryAfter = typeof other.retryAfter === "number" ? { retryAfter: other.retryAfter } : undefined;
    return new ServiceError(other.code as ErrorCode, (error as Error).message, retryAfter);
  }
  return null;
}

export function errorResponse(c: Ctx, error: unknown, log: Log): Response {
  const known = serviceError(error);
  if (known) {
    // A rate_limited answer says in whole seconds when to try again.
    if (known.code === "rate_limited" && known.retryAfter !== undefined) c.header("Retry-After", String(Math.max(0, Math.ceil(known.retryAfter))));
    return c.json({ error: { code: known.code, message: known.message } }, ERROR_STATUS[known.code] as ContentfulStatusCode);
  }
  log.error(`${c.req.method} ${c.req.path} failed`, error);
  return c.json({ error: { code: "internal", message: "Something went wrong on the server" } }, 500);
}
