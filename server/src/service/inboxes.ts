// Connecting, changing and removing inboxes.

import {
  INBOX_ICONS,
  ServiceError,
  type Caller,
  type ConnectInboxInput,
  type Inbox,
  type InboxConnection,
  type InboxIcon,
  type InboxPatch,
  type MailProvider,
  type ProviderKind,
  type TrustLevel,
} from "@usualmail/core";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { claimsSignIn, providerCredentials, signedInToken } from "../google/credentials.ts";
import { revokeToken } from "../google/oauth.ts";
import {
  actions,
  attachments,
  sentMessageIds,
  devices,
  drafts,
  heldCopies,
  inboxes,
  messages,
  rules,
  senders,
  teachPrompts,
  threads,
  unsubscribes,
  type InboxRow,
} from "../db/index.ts";
import { errorMessage } from "../util.ts";
import { isPerson, mayRead, refreshAccess, requireInbox, requirePerson } from "./access.ts";
import type { Ctx } from "./context.ts";
import { forgetPictures } from "./pictures.ts";
import { toInbox } from "./rows.ts";
import { check, ConnectInboxSchema, InboxPatchSchema } from "./schemas.ts";
import { getInbox, runBatch } from "./store.ts";
import { loadState } from "../ai/state.ts";
import { cancelAgentRuns, openBrowserAgent } from "../unsubscribe/agent.ts";

/** In the inbox list's order, by `position`. */
export async function listInboxes(ctx: Ctx, caller: Caller): Promise<Inbox[]> {
  const rows = await ctx.db.select().from(inboxes).orderBy(asc(inboxes.position), asc(inboxes.id));
  return rows.filter((row) => mayRead(caller, row)).map(toInbox);
}

/**
 * Puts the inbox at `position` (clamped to the list) and renumbers the others, from 0 with no gaps. Each inbox whose
 * position changes gets a new version and `inbox.changed`, except `id` itself, whose caller saves and announces it.
 * Returns the position it took. Under the lock.
 */
async function placeInbox(ctx: Ctx, id: string, position: number): Promise<number> {
  const rows = await ctx.db.select().from(inboxes).orderBy(asc(inboxes.position), asc(inboxes.id));
  const others = rows.filter((row) => row.id !== id).map((row) => row.id);
  const at = Math.max(0, Math.min(position, others.length));
  await assign(ctx, rows, [...others.slice(0, at), id, ...others.slice(at)], id);
  return at;
}

/** Positions from 0 with no gaps, in the order they have. Under the lock. */
async function renumber(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.select().from(inboxes).orderBy(asc(inboxes.position), asc(inboxes.id));
  await assign(ctx, rows, rows.map((row) => row.id));
}

/** Each inbox takes its index in `order` as its position, announcing each that moved, except `skip`. */
async function assign(ctx: Ctx, rows: InboxRow[], order: string[], skip?: string): Promise<void> {
  for (const [index, rowId] of order.entries()) {
    const row = rows.find((r) => r.id === rowId);
    if (!row || rowId === skip || row.position === index) continue;
    const next = { ...row, position: index, version: row.version + 1 };
    await ctx.db.update(inboxes).set({ position: index, version: next.version }).where(eq(inboxes.id, row.id));
    ctx.emit({ type: "inbox.changed", inbox: toInbox(next) });
  }
}

/** The start of the first sync's window for an inbox created at `createdAt`, by the window as it is now. */
export function syncSince(ctx: Ctx, createdAt: number): string {
  return new Date(createdAt - ctx.firstSync.days * 24 * 60 * 60_000).toISOString();
}

/** Credentials given by hand may not say they come from a Google sign-in: only the server's own sign-in does. */
function refuseClaimedSignIn(provider: ProviderKind, credentials: unknown): void {
  if (provider === "gmail" && claimsSignIn(credentials)) {
    throw new ServiceError("invalid", "Credentials given by hand can't say they come from a Google sign-in. Sign in with Google instead (POST /v1/google/sign-ins)");
  }
}

/** Checks the credentials with the provider before anything is stored. Runs outside the lock. */
export async function connectInbox(ctx: Ctx, caller: Caller, input: ConnectInboxInput): Promise<Inbox> {
  requirePerson(caller, "connect an inbox");
  const data = check(ConnectInboxSchema, input, "Inbox");
  refuseClaimedSignIn(data.provider, data.credentials);
  const factory = ctx.providers.get(data.provider);
  if (!factory) throw new ServiceError("invalid", `This server has no ${data.provider} provider installed`);
  const createdAt = ctx.now();
  let address: string;
  let connection: InboxConnection;
  try {
    ({ address, connection } = await verifyWith(factory(data.credentials, { since: syncSince(ctx, createdAt) })));
  } catch (error) {
    throw new ServiceError("provider_error", `The mailbox didn't accept the connection: ${errorMessage(error)}`);
  }
  return insertInbox(ctx, {
    name: data.name,
    color: data.color,
    provider: data.provider,
    address,
    connection,
    credentials: data.credentials ?? null,
    ...(data.icon !== undefined && { icon: data.icon }),
    ...(data.trust !== undefined && { trust: data.trust }),
  }, createdAt);
}

/** A mailbox the provider has already checked, to store as a new inbox. */
export interface NewInbox {
  name: string;
  color: string;
  provider: ProviderKind;
  address: string;
  connection: InboxConnection;
  /** Sealed for this inbox before it is stored. */
  credentials: unknown;
  icon?: InboxIcon;
  trust?: TrustLevel;
}

/**
 * Stores a new inbox whose credentials the provider accepted: last in the list, `connecting`, and opens it. With an AI
 * key set, its mail goes to the AI like every inbox's. Another inbox of the same provider and address is a `conflict`.
 */
export async function insertInbox(ctx: Ctx, data: NewInbox, createdAt: number): Promise<Inbox> {
  const id = ctx.id("inb");
  const credentials = await ctx.host.secrets.seal(JSON.stringify(data.credentials ?? null), id);
  const row: InboxRow = {
    id,
    name: data.name,
    address: data.address.toLowerCase(),
    color: data.color,
    icon: data.icon ?? "person",
    position: 0,
    aiProcessing: false,
    provider: data.provider,
    connection: data.connection,
    trust: data.trust ?? "suggest",
    guide: "",
    agentAccess: false,
    status: "connecting",
    statusDetail: null,
    statusReason: null,
    lastAttemptAt: null,
    failingSince: null,
    failures: 0,
    paused: false,
    lastSyncedAt: null,
    createdAt,
    credentials,
    syncCursor: null,
    historyDone: false,
    firstSyncFetched: null,
    firstSyncTotal: null,
    resetListing: null,
    version: 1,
  };
  await ctx.lock.run(async () => {
    const same = await ctx.db.select({ id: inboxes.id }).from(inboxes)
      .where(and(eq(inboxes.address, row.address), eq(inboxes.provider, row.provider))).get();
    if (same) throw new ServiceError("conflict", `${row.address} is already connected`);
    // A new inbox comes last, and takes the next of person, building and briefcase in turn unless given an icon.
    const count = (await ctx.db.select({ count: sql<number>`count(*)` }).from(inboxes).get())?.count ?? 0;
    row.position = count;
    if (!data.icon) row.icon = INBOX_ICONS[count % 3]!;
    await ctx.db.insert(inboxes).values(row);
    await refreshAccess(ctx, id);
  });
  const inbox = toInbox(row);
  ctx.emit({ type: "inbox.changed", inbox });
  ctx.hooks.inboxOpened(id);
  return inbox;
}

/**
 * Changes an inbox. An agent may change only `guide`. New credentials (person only) are checked with the provider
 * before anything is stored: a refusal is `provider_error` with the provider's words, another address is
 * `invalid`, and either way nothing in the patch changes. A patch that changes nothing raises no version and
 * sends no event.
 */
export async function updateInbox(ctx: Ctx, caller: Caller, id: string, input: InboxPatch): Promise<Inbox> {
  const patch = check(InboxPatchSchema, input, "Inbox change");
  const loaded = await requireInbox(ctx, caller, id);
  if (!isPerson(caller)) {
    const others = Object.entries(patch).filter(([key, value]) => key !== "guide" && value !== undefined);
    if (others.length) throw new ServiceError("needs_person", `Only a person can change ${others.map(([key]) => key).join(", ")}`);
  }
  if (patch.credentials !== undefined) refuseClaimedSignIn(loaded.provider, patch.credentials);
  // Outside the lock: the provider may take a while to answer.
  const fresh = patch.credentials !== undefined ? await verifiedCredentials(ctx, loaded, patch.credentials) : null;
  return changeInbox(ctx, caller, id, patch, fresh);
}

/**
 * Gives an inbox credentials the provider has already checked for its address, replacing the stored ones whole: it
 * is `connecting` until its next good sync (a paused inbox stays paused), keeps everything else, and is opened again.
 * Google sign-in reconnects an inbox in place with it.
 */
export async function replaceCredentials(
  ctx: Ctx,
  caller: Caller,
  id: string,
  fresh: { credentials: unknown; connection: InboxConnection },
): Promise<Inbox> {
  const sealed = await ctx.host.secrets.seal(JSON.stringify(fresh.credentials ?? null), id);
  return changeInbox(ctx, caller, id, {}, { sealed, connection: fresh.connection });
}

/** Applies a checked patch, and checked credentials, under the lock; then announces and reopens. */
async function changeInbox(
  ctx: Ctx,
  caller: Caller,
  id: string,
  patch: Omit<InboxPatch, "credentials">,
  fresh: { sealed: string; connection: InboxConnection } | null,
): Promise<Inbox> {
  const { row, changed, reopen } = await ctx.lock.run(async () => {
    const current = await requireInbox(ctx, caller, id);
    const next: InboxRow = {
      ...current,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.color !== undefined && { color: patch.color }),
      ...(patch.icon !== undefined && { icon: patch.icon }),
      ...(patch.trust !== undefined && { trust: patch.trust }),
      ...(patch.guide !== undefined && { guide: patch.guide }),
      ...(patch.agentAccess !== undefined && { agentAccess: patch.agentAccess }),
      ...(patch.paused !== undefined && { paused: patch.paused }),
    };
    if (patch.position !== undefined && patch.position !== current.position) next.position = await placeInbox(ctx, id, patch.position);
    // Unpausing, or new credentials that work, reconnect it: it is "connecting" until its next good sync.
    const unpaused = current.paused && !next.paused;
    if (unpaused || fresh !== null) {
      next.status = "connecting";
      next.statusDetail = null;
      next.statusReason = null;
    }
    if (fresh !== null) {
      next.credentials = fresh.sealed;
      next.connection = fresh.connection;
    }
    const fields = [
      "name", "color", "icon", "position", "trust", "guide", "agentAccess", "paused", "status", "statusDetail", "statusReason",
      "credentials",
    ] as const;
    if (fields.every((key) => next[key] === current[key])) return { row: current, changed: false, reopen: false };
    next.version = current.version + 1;
    await ctx.db.update(inboxes).set({
      name: next.name,
      color: next.color,
      icon: next.icon,
      position: next.position,
      trust: next.trust,
      guide: next.guide,
      agentAccess: next.agentAccess,
      paused: next.paused,
      status: next.status,
      statusDetail: next.statusDetail,
      statusReason: next.statusReason,
      // A new run: failures before the reconnect or the pause don't count towards the grace (sync/health.ts).
      ...((unpaused || fresh !== null) && { failingSince: null, failures: 0 }),
      credentials: next.credentials,
      connection: next.connection,
      version: next.version,
    }).where(eq(inboxes.id, id));
    await refreshAccess(ctx, id);
    return { row: next, changed: true, reopen: next.paused !== current.paused || fresh !== null };
  });
  const inbox = toInbox(row);
  if (!changed) return inbox;
  ctx.emit({ type: "inbox.changed", inbox });
  // The open provider holds the old credentials (or the inbox was paused): it is closed, and opened again unless the
  // inbox is paused, which syncs at once. In the background: the answer doesn't wait for a running sync's batch in hand
  // (up to 200 messages on Node, minutes of Gmail), since the change is stored and announced already.
  if (reopen) ctx.hooks.inboxClosed(id, { reopen: !row.paused });
  return inbox;
}

/** Checks credentials with the provider: the address it names, and what of them isn't secret. Then closes it. */
export async function verifyWith(provider: MailProvider): Promise<{ address: string; connection: InboxConnection }> {
  try {
    const { address } = await provider.verify();
    return { address, connection: provider.connection() };
  } finally {
    await provider.close().catch(() => undefined);
  }
}

/**
 * New credentials, verified with the provider for this inbox's address, sealed for storing, with what of them
 * isn't secret. They replace the stored ones whole.
 */
async function verifiedCredentials(
  ctx: Ctx,
  inbox: InboxRow,
  credentials: unknown,
): Promise<{ sealed: string; connection: InboxConnection }> {
  const factory = ctx.providers.get(inbox.provider);
  if (!factory) throw new ServiceError("invalid", `This server has no ${inbox.provider} provider installed`);
  let address: string;
  let connection: InboxConnection;
  try {
    ({ address, connection } = await verifyWith(factory(credentials, { since: syncSince(ctx, inbox.createdAt) })));
  } catch (error) {
    throw new ServiceError("provider_error", `The mailbox didn't accept the new credentials: ${errorMessage(error)}`);
  }
  if (address.toLowerCase() !== inbox.address) {
    throw new ServiceError("invalid", `These credentials are for ${address.toLowerCase()}, not ${inbox.address}`);
  }
  return { sealed: await ctx.host.secrets.seal(JSON.stringify(credentials ?? null), inbox.id), connection };
}

/**
 * A store from before the fourth revision has no `connection` for its inboxes. The provider describes the stored
 * credentials once, at start, without the network. An inbox it can't describe (no provider for its kind) keeps
 * none and lists with empty fields until new credentials are given.
 */
export async function fillConnections(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.select().from(inboxes).where(isNull(inboxes.connection));
  for (const row of rows) {
    const factory = ctx.providers.get(row.provider);
    if (!factory) continue;
    try {
      const provider = factory(await providerCredentials(ctx, row), { since: syncSince(ctx, row.createdAt) });
      const connection = provider.connection();
      await provider.close().catch(() => undefined);
      await ctx.db.update(inboxes).set({ connection }).where(eq(inboxes.id, row.id));
    } catch (error) {
      ctx.host.log.error(`Couldn't describe how ${row.id} is connected: ${errorMessage(error)}`);
    }
  }
}

/**
 * Deletes the server's copy of the inbox: its mail, rules, history, drafts and guide, and agents' access to it.
 * Nothing changes at the provider. Briefs keep no section for it, since only existing inboxes are shown. Its rows go
 * at once, so it is gone from every list and event and its address can be added again (as a new inbox) straight away,
 * also if the server stops before its connection has closed. The connection closes in the background: a sync running
 * now stops once its batch in hand is fetched, which finds the inbox gone and stores nothing.
 */
export async function removeInbox(ctx: Ctx, caller: Caller, id: string): Promise<void> {
  requirePerson(caller, "remove an inbox");
  const inbox = await requireInbox(ctx, caller, id);
  // A token the server got by signing in with Google is revoked at Google once the inbox is gone (below).
  const token = await signedInToken(ctx, inbox);
  // A browser agent's runs for the inbox's senders are stopped first: nobody waits on them any more.
  const agent = await ctx.lock.run(async () => openBrowserAgent(ctx, await loadState(ctx)));
  if (agent) await cancelAgentRuns(ctx, agent, id);
  await ctx.lock.run(async () => {
    if (!await getInbox(ctx, id)) return;
    const agents = (await ctx.db.select({ id: devices.id, inboxIds: devices.inboxIds }).from(devices).where(eq(devices.kind, "agent")))
      .filter((device) => device.inboxIds?.includes(id));
    await runBatch(ctx, [
      // The inbox's messages are chosen inside the statement: one parameter, however much mail it holds.
      ctx.db.delete(attachments).where(inArray(attachments.messageId, ctx.db.select({ id: messages.id }).from(messages).where(eq(messages.inboxId, id)))),
      ctx.db.delete(heldCopies).where(eq(heldCopies.inboxId, id)),
      ctx.db.delete(messages).where(eq(messages.inboxId, id)),
      ctx.db.delete(threads).where(eq(threads.inboxId, id)),
      ctx.db.delete(actions).where(eq(actions.inboxId, id)),
      ctx.db.delete(rules).where(eq(rules.inboxId, id)),
      ctx.db.delete(teachPrompts).where(eq(teachPrompts.inboxId, id)),
      ctx.db.delete(drafts).where(eq(drafts.inboxId, id)),
      ctx.db.delete(senders).where(eq(senders.inboxId, id)),
      ctx.db.delete(unsubscribes).where(eq(unsubscribes.inboxId, id)),
      ctx.db.delete(sentMessageIds).where(eq(sentMessageIds.inboxId, id)),
      ...agents.map((device) => ctx.db.update(devices)
        .set({ inboxIds: (device.inboxIds ?? []).filter((inboxId) => inboxId !== id) }).where(eq(devices.id, device.id))),
      ctx.db.delete(inboxes).where(eq(inboxes.id, id)),
    ]);
    await refreshAccess(ctx, id);
    // The others close the gap, each that moved with a new version and `inbox.changed`.
    await renumber(ctx);
  });
  ctx.emit({ type: "inbox.removed", inboxId: id });
  ctx.hooks.inboxClosed(id);
  // At once, as before, not after the close: minutes later it could come after the same account was signed in again,
  // whose sign-in a revocation may end too (not verified).
  if (token) ctx.background(revokeRemoved(ctx, id, token));
  // The pictures from the web kept for its mail go with it.
  ctx.background(forgetPictures(ctx, id));
}

/**
 * Revokes a removed inbox's Google sign-in at Google, in the background. A refusal or no answer doesn't undo the
 * removal; it is only noted, without the token.
 */
async function revokeRemoved(ctx: Ctx, id: string, token: string): Promise<void> {
  const { ok, status } = await revokeToken(ctx.google?.fetch ?? ((input, init) => fetch(input, init)), token);
  if (ok) return;
  ctx.host.log.info(
    `Couldn't revoke the Google sign-in of removed inbox ${id} at Google (${status === null ? "no answer" : `status ${status}`}). ` +
      "It ends when the person removes Usual Mail's access in their Google Account, or after six months unused.",
  );
}

/** A paused inbox reads nothing from its provider and writes nothing to it. */
export function assertNotPaused(inbox: InboxRow, doing: string): void {
  if (inbox.paused) throw new ServiceError("conflict", `This inbox is paused, so it can't ${doing}. Resume it first.`);
}

export async function syncInbox(ctx: Ctx, caller: Caller, id: string): Promise<void> {
  const inbox = await requireInbox(ctx, caller, id);
  assertNotPaused(inbox, "sync");
  ctx.hooks.requestSync(id);
}
