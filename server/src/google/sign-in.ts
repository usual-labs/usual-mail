// Connecting Gmail by signing in with Google (docs/contract-sync.md). A person's device starts a sign-in and opens
// Google's address; Google sends the browser back to the callback with a code and the state; the server checks the
// state (unguessable, single use, ten minutes, kept for the device that started it), exchanges the code with the PKCE
// verifier, learns the mailbox's address from Gmail, then connects a new inbox or reconnects one in place.
//
// Sign-ins live in this process's memory only: a restart ends those still waiting, and the verifier never touches
// the disk. The state is kept as its SHA-256.

import {
  INBOX_ICONS,
  ServiceError,
  type Caller,
  type GoogleSignIn,
  type GoogleSignInFailure,
  type GoogleSignInInfo,
  type GoogleSignInInput,
  type GoogleSignInMissing,
  type GoogleSignInStart,
} from "@usualmail/core";
import { and, eq, isNull } from "drizzle-orm";
import * as v from "valibot";
import { devices, inboxes } from "../db/index.ts";
import { requireInbox, requirePerson } from "../service/access.ts";
import type { Ctx } from "../service/context.ts";
import { insertInbox, replaceCredentials, verifyWith } from "../service/inboxes.ts";
import { check } from "../service/schemas.ts";
import { getInbox } from "../service/store.ts";
import { base64url, errorMessage, iso, sha256 } from "../util.ts";
import { signedInConnection, type SignedInCredentials } from "./credentials.ts";
import type { CallbackPage, Entry } from "./store.ts";
import { authorizationUrl, exchangeCode, GoogleExchangeError, grantsGmail, pkce } from "./oauth.ts";
import { claimPage, finishOwnerClaim } from "./owner-claim.ts";
import { headings, notAvailable, words } from "./words.ts";

/** How long a person has to come back from Google. */
const LIFETIME_MS = 10 * 60_000;
/** The slate hat's colour, for a new inbox given none. */
const DEFAULT_COLOR = "#5A697C";

const InputSchema = v.strictObject({
  inboxId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100))),
  color: v.optional(v.pipe(v.string(), v.regex(/^#[0-9A-Fa-f]{6}$/, "A colour is #RRGGBB"), v.toUpperCase())),
  icon: v.optional(v.picklist(INBOX_ICONS)),
});

/** Whether Google sign-in is available, and what the host still has to give. */
export async function googleSignInInfo(ctx: Ctx): Promise<GoogleSignInInfo> {
  const client = await ctx.google?.client() ?? null;
  const redirectUri = ctx.google?.redirectUri() ?? null;
  const missing: GoogleSignInMissing[] = [];
  if (!client) missing.push("client");
  if (!redirectUri) missing.push("address");
  return { available: missing.length === 0, ...(redirectUri && { redirectUri }), ...(missing.length && { missing }) };
}

export async function startGoogleSignIn(ctx: Ctx, caller: Caller, input: GoogleSignInInput): Promise<GoogleSignInStart> {
  requirePerson(caller, "sign in with Google");
  const data = check(InputSchema, input, "Google sign-in");
  if (data.inboxId !== undefined && (data.name !== undefined || data.color !== undefined || data.icon !== undefined)) {
    throw new ServiceError("invalid", "Google sign-in: name, color and icon are for a new inbox; a reconnected inbox keeps its own");
  }
  const info = await googleSignInInfo(ctx);
  const client = await ctx.google?.client() ?? null;
  const redirectUri = ctx.google?.redirectUri() ?? null;
  if (!client || !redirectUri) throw new ServiceError("conflict", notAvailable(info.missing ?? []));
  let loginHint: string | undefined;
  if (data.inboxId !== undefined) {
    const inbox = await requireInbox(ctx, caller, data.inboxId);
    if (inbox.provider !== "gmail") throw new ServiceError("invalid", "Only a Gmail inbox can be reconnected by signing in with Google");
    loginHint = inbox.address;
  }
  const now = ctx.now();
  ctx.signIns.prune(now);
  const state = base64url(ctx.host.random.bytes(32));
  const { verifier, challenge } = await pkce((length) => ctx.host.random.bytes(length));
  const entry: Entry = {
    id: ctx.id("gsi"),
    stateHash: await sha256(state),
    verifier,
    caller,
    deviceId: caller.actor.kind === "person" ? caller.actor.deviceId : "",
    ...(data.inboxId !== undefined && { inboxId: data.inboxId }),
    newInbox: { ...(data.name !== undefined && { name: data.name }), ...(data.color !== undefined && { color: data.color }), ...(data.icon !== undefined && { icon: data.icon }) },
    startedAt: now,
    expiresAt: now + LIFETIME_MS,
    phase: "waiting",
  };
  ctx.signIns.add(entry);
  const url = authorizationUrl({
    ...(ctx.google?.authorizationUrl !== undefined && { base: ctx.google.authorizationUrl }),
    clientId: client.clientId,
    redirectUri,
    state,
    challenge,
    ...(loginHint !== undefined && { loginHint }),
  });
  return { id: entry.id, url, expiresAt: iso(entry.expiresAt) };
}

/** How a sign-in the caller's own device started stands. Anyone else's, or one forgotten, is `not_found`. */
export function googleSignIn(ctx: Ctx, caller: Caller, id: string): GoogleSignIn {
  requirePerson(caller, "ask about a Google sign-in");
  ctx.signIns.prune(ctx.now());
  const entry = ctx.signIns.byId(id);
  if (!entry || caller.actor.kind !== "person" || entry.deviceId !== caller.actor.deviceId) {
    throw new ServiceError("not_found", "No such Google sign-in");
  }
  if (entry.phase === "waiting" && ctx.now() > entry.expiresAt) end(entry, fail("expired", words.expired));
  return view(entry);
}

/** Google sent the person's browser back. Answers with what the page says. */
export async function finishGoogleSignIn(ctx: Ctx, query: URLSearchParams): Promise<CallbackPage> {
  ctx.signIns.prune(ctx.now());
  const state = query.get("state");
  const entry = state ? ctx.signIns.byState(await sha256(state)) : undefined;
  if (!entry) return { status: 400, title: headings.unknown, message: words.unknownState };
  if (entry.phase !== "waiting") {
    if (entry.phase === "done" && entry.outcome?.failure === "expired") return page(entry);
    return { status: 400, title: headings.unknown, message: words.alreadyUsed };
  }
  // Taken before anything is awaited, so a second visit with the same state finds it used.
  entry.phase = "finishing";
  try {
    end(entry, await finish(ctx, entry, query));
  } catch (error) {
    ctx.host.log.error("A Google sign-in failed unexpectedly", errorMessage(error));
    end(entry, fail("google_error", words.googleError));
  }
  return page(entry);
}

type Outcome = NonNullable<Entry["outcome"]>;

async function finish(ctx: Ctx, entry: Entry, query: URLSearchParams): Promise<Outcome> {
  if (ctx.now() > entry.expiresAt) return fail("expired", words.expired);
  const error = query.get("error");
  if (error !== null) {
    if (error === "access_denied") return fail("declined", words.declined);
    if (error === "admin_policy_enforced") return fail("google_error", words.adminPolicy);
    if (error === "org_internal") return fail("google_error", words.orgInternal);
    return fail("google_error", words.googleError);
  }
  const code = query.get("code");
  if (!code) return fail("google_error", words.googleError);
  if (entry.claim) return finishOwnerClaim(ctx, entry, code);
  const device = await ctx.db.select({ id: devices.id }).from(devices)
    .where(and(eq(devices.id, entry.deviceId), isNull(devices.revokedAt))).get();
  if (!device) return fail("cancelled", words.deviceRemoved);
  const client = await ctx.google?.client() ?? null;
  const redirectUri = ctx.google?.redirectUri() ?? null;
  if (!client || !redirectUri) return fail("google_error", words.notSetUp);

  let exchanged;
  try {
    exchanged = await exchangeCode(ctx.google?.fetch ?? ((input, init) => fetch(input, init)), client, { code, verifier: entry.verifier, redirectUri });
  } catch (error) {
    if (error instanceof GoogleExchangeError && error.code === "invalid_client") return fail("google_error", words.clientRefused);
    return fail("google_error", words.codeRefused);
  }
  if (!grantsGmail(exchanged.scope)) return fail("scope_missing", words.scopeMissing);
  if (!exchanged.refreshToken) return fail("no_refresh_token", words.noRefreshToken);

  // What Gmail says the mailbox is, with the token and the host's secret, through the Gmail provider.
  const factory = ctx.providers.get("gmail");
  if (!factory) return fail("google_error", words.googleError);
  const credentials = { clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: exchanged.refreshToken };
  let verified;
  try {
    verified = await verifyWith(factory(credentials, { since: new Date(ctx.now()).toISOString() }));
  } catch (error) {
    if (error instanceof Error && error.name === "GoogleTokenError" && (error as Error & { kind?: string }).kind === "client_refused") {
      return fail("google_error", words.clientRefused);
    }
    return fail("mailbox_error", words.mailboxError(errorMessage(error).slice(0, 300)));
  }
  const address = verified.address.toLowerCase();
  const sealed: SignedInCredentials = { signIn: "google", clientId: client.clientId, refreshToken: exchanged.refreshToken };
  const connection = signedInConnection(verified.connection);

  let target = entry.inboxId;
  if (target !== undefined) {
    const inbox = await getInbox(ctx, target);
    if (!inbox) return fail("cancelled", words.inboxRemoved, target);
    if (inbox.address !== address) return fail("wrong_account", words.wrongAccount(address, inbox.address), target);
  } else {
    target = (await ctx.db.select({ id: inboxes.id }).from(inboxes)
      .where(and(eq(inboxes.address, address), eq(inboxes.provider, "gmail"))).get())?.id;
  }
  if (target !== undefined) {
    try {
      await replaceCredentials(ctx, entry.caller, target, { credentials: sealed, connection });
    } catch (error) {
      if (error instanceof ServiceError && error.code === "not_found") return fail("cancelled", words.inboxRemoved, target);
      throw error;
    }
    return { state: "connected", inboxId: target, reconnected: true, message: words.reconnected(address) };
  }
  const inbox = await insertInbox(ctx, {
    name: entry.newInbox.name ?? address,
    color: entry.newInbox.color ?? DEFAULT_COLOR,
    ...(entry.newInbox.icon !== undefined && { icon: entry.newInbox.icon }),
    provider: "gmail",
    address,
    connection,
    credentials: sealed,
  }, ctx.now());
  return { state: "connected", inboxId: inbox.id, reconnected: false, message: words.connected(address) };
}

function fail(failure: GoogleSignInFailure, message: string, inboxId?: string): Outcome {
  return { state: "failed", failure, message, ...(inboxId !== undefined && { inboxId }) };
}

function end(entry: Entry, outcome: Outcome): void {
  entry.phase = "done";
  entry.outcome = outcome;
  // Nothing secret outlives the sign-in.
  entry.verifier = "";
}

function view(entry: Entry): GoogleSignIn {
  const outcome = entry.outcome;
  const inboxId = outcome?.inboxId ?? entry.inboxId;
  return {
    id: entry.id,
    state: entry.phase === "done" && outcome ? outcome.state : "waiting",
    ...(inboxId !== undefined && { inboxId }),
    ...(outcome?.reconnected !== undefined && { reconnected: outcome.reconnected }),
    ...(outcome?.failure !== undefined && { failure: outcome.failure }),
    ...(outcome?.message !== undefined && { message: outcome.message }),
    expiresAt: iso(entry.expiresAt),
  };
}

function page(entry: Entry): CallbackPage {
  if (entry.claim) return claimPage(entry);
  const outcome = entry.outcome!;
  const connected = outcome.state === "connected";
  return {
    status: connected ? 200 : 400,
    title: connected ? (outcome.reconnected ? "Gmail is reconnected" : headings.connected) : headings[outcome.failure ?? "google_error"],
    message: outcome.message ?? words.googleError,
  };
}
