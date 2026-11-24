// Devices, agents and pairing: the whole sign-in. A person creates a short code; a device trades it for a
// token, shown once and stored only as a hash.

import {
  RECOVERY_CODE_TTL_MS,
  ServiceError,
  type Caller,
  type Device,
  type PairingCode,
  type PairingCodeInput,
  type PairInput,
  type PairResult,
  type RecoveryCodeAnswer,
} from "@usualmail/core";
import { and, eq, gt, isNull } from "drizzle-orm";
import { devices, inboxes, pairingCodes, type DeviceRow } from "../db/index.ts";
import { iso, makePairingCode, makeToken, normalizePairingCode, sha256, TOKEN_PREFIX, unique } from "../util.ts";
import { requirePerson } from "./access.ts";
import type { Counted } from "./attempts.ts";
import type { Ctx } from "./context.ts";
import { toDevice } from "./rows.ts";
import { check, PairingCodeInputSchema, PairInputSchema } from "./schemas.ts";

/** The id of the device the caller's token belongs to, or null for the system. */
function deviceIdOf(caller: Caller): string | null {
  return caller.actor.kind === "person" ? caller.actor.deviceId : caller.actor.kind === "agent" ? caller.actor.agentId : null;
}

/** The device the caller's token belongs to, a person's or an agent's. */
export async function me(ctx: Ctx, caller: Caller): Promise<Device> {
  const id = deviceIdOf(caller);
  const row = id ? await ctx.db.select().from(devices).where(and(eq(devices.id, id), isNull(devices.revokedAt))).get() : undefined;
  if (!row) throw new ServiceError("not_found", "No device belongs to this token");
  return toDevice(row);
}

export async function listDevices(ctx: Ctx, caller: Caller): Promise<Device[]> {
  requirePerson(caller, "see devices");
  const rows = await ctx.db.select().from(devices).where(isNull(devices.revokedAt)).orderBy(devices.createdAt);
  return rows.map(toDevice);
}

async function issueCode(ctx: Ctx, kind: "person" | "agent", inboxIds: string[] | null, ttlMs: number): Promise<PairingCode> {
  const code = makePairingCode(ctx.host.random);
  const expiresAt = ctx.now() + ttlMs;
  await ctx.db.insert(pairingCodes).values({
    codeHash: await sha256(code),
    kind,
    inboxIds,
    createdAt: ctx.now(),
    expiresAt,
    usedAt: null,
  });
  return { code, expiresAt: iso(expiresAt) };
}

export async function createPairingCode(ctx: Ctx, caller: Caller, input: PairingCodeInput): Promise<PairingCode> {
  requirePerson(caller, "add a device or an agent");
  const data = check(PairingCodeInputSchema, input, "Pairing code");
  if (data.kind === "person") {
    if (data.inboxIds !== undefined) throw new ServiceError("invalid", "inboxIds is for agents only");
    return issueCode(ctx, "person", null, ctx.options.pairingCodeTtlMs);
  }
  const ids = unique(data.inboxIds ?? []);
  if (ids.length === 0) throw new ServiceError("invalid", "An agent needs at least one inbox in inboxIds");
  const known = new Set((await ctx.db.select({ id: inboxes.id }).from(inboxes)).map((row) => row.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new ServiceError("invalid", `No such inbox: ${unknown.join(", ")}`);
  return issueCode(ctx, "agent", ids, ctx.options.pairingCodeTtlMs);
}

/**
 * `rate_limited` while ten wrong pairing codes or owner's passwords (`owner.ts`) came from the caller's address in the
 * last ten minutes, thirty from its IPv6 /48, or a thousand from everyone (attempts.ts): they count together, so neither
 * can be guessed, and a few addresses can't lock the owner out. `client` is what the caller counts under
 * (client-address.ts's `clientKey`).
 */
export function checkPairingLimit(ctx: Ctx, client: Counted, what = "pairing codes"): void {
  const wait = ctx.pairingFailures.wait(client, ctx.now());
  if (!wait) return;
  const who = { address: "from your address", network: "from your network", everyone: "from everyone together" }[wait.scope];
  throw new ServiceError("rate_limited", `Too many wrong ${what} ${who}. Try again in ${wait.retryAfter} seconds.`, { retryAfter: wait.retryAfter });
}

/** Counts one wrong pairing code or password from `client`. */
export function countPairingFailure(ctx: Ctx, client: Counted): void {
  ctx.pairingFailures.count(client, ctx.now());
}

/** A new device and its token, shown once; only the token's hash is kept. `extra` is written in the same batch. */
export async function addDevice(
  ctx: Ctx,
  device: { name: string; kind: Device["kind"]; inboxIds: string[] | null },
  extra: Parameters<Ctx["db"]["batch"]>[0][number][] = [],
): Promise<PairResult> {
  const token = makeToken(ctx.host.random);
  const row: DeviceRow = {
    id: ctx.id("dev"),
    name: device.name,
    kind: device.kind,
    inboxIds: device.kind === "agent" ? device.inboxIds ?? [] : null,
    tokenHash: await sha256(token),
    createdAt: ctx.now(),
    lastSeenAt: null,
    revokedAt: null,
  };
  await ctx.db.batch([ctx.db.insert(devices).values(row), ...extra]);
  return { token, device: toDevice(row) };
}

/**
 * Needs no caller: the code is the credential. Under the lock, so a code can't be used twice. A wrong, used
 * or expired code is `unauthorized`; after too many of those, every try is `rate_limited` for a while, even
 * with a good code, so codes can't be guessed.
 */
export async function pair(ctx: Ctx, input: PairInput, client: Counted): Promise<PairResult> {
  checkPairingLimit(ctx, client);
  const data = check(PairInputSchema, input, "Pairing");
  const codeHash = await sha256(normalizePairingCode(data.code));
  const code = await ctx.db.select().from(pairingCodes).where(and(
    eq(pairingCodes.codeHash, codeHash),
    isNull(pairingCodes.usedAt),
    gt(pairingCodes.expiresAt, ctx.now()),
  )).get();
  if (!code) {
    countPairingFailure(ctx, client);
    throw new ServiceError("unauthorized", "That pairing code is wrong, used or expired");
  }
  const paired = await addDevice(ctx, { name: data.name, kind: code.kind, inboxIds: code.inboxIds }, [
    ctx.db.update(pairingCodes).set({ usedAt: ctx.now() }).where(eq(pairingCodes.codeHash, codeHash)),
  ]);
  // A person's device: the owner's code, if one was waiting, is done with, and so is a recovery code if this was it.
  if (code.kind === "person") await keepOwnerCodeCurrent(ctx, codeHash);
  return paired;
}

/**
 * A person may revoke any device. Any caller may revoke itself, which ends its own token. When the last person's
 * device goes, a new owner's code is made at once, so the owner is never locked out.
 */
export async function revokeDevice(ctx: Ctx, caller: Caller, id: string): Promise<void> {
  if (id !== deviceIdOf(caller)) requirePerson(caller, "remove another device");
  const row = await ctx.db.select().from(devices).where(and(eq(devices.id, id), isNull(devices.revokedAt))).get();
  if (!row) throw new ServiceError("not_found", "No such device");
  await ctx.db.update(devices).set({ revokedAt: ctx.now() }).where(eq(devices.id, id));
  if (row.kind === "person") await keepOwnerCodeCurrent(ctx);
}

/** The caller behind a token, or null when it is unknown or revoked. */
export async function authenticate(ctx: Ctx, token: string): Promise<Caller | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = await ctx.db.select().from(devices)
    .where(and(eq(devices.tokenHash, await sha256(token)), isNull(devices.revokedAt))).get();
  if (!row) return null;
  // Note use at most once a minute, to keep writes down.
  if (row.lastSeenAt === null || ctx.now() - row.lastSeenAt > 60_000) {
    await ctx.db.update(devices).set({ lastSeenAt: ctx.now() }).where(eq(devices.id, row.id));
  }
  return row.kind === "person"
    ? { actor: { kind: "person", deviceId: row.id } }
    : { actor: { kind: "agent", agentId: row.id, name: row.name }, inboxIds: row.inboxIds ?? [] };
}

export async function personPaired(ctx: Ctx): Promise<boolean> {
  const person = await ctx.db.select({ id: devices.id }).from(devices)
    .where(and(eq(devices.kind, "person"), isNull(devices.revokedAt))).limit(1).get();
  return person !== undefined;
}

/**
 * Whether any device was ever paired here, revoked ones included: a server someone has used, which can never be claimed
 * again (owner.ts). Device rows are never deleted, only revoked, and this relies on that.
 */
export async function everPaired(ctx: Ctx): Promise<boolean> {
  return (await ctx.db.select({ id: devices.id }).from(devices).limit(1).get()) !== undefined;
}

/**
 * Ends every unused person code at once, for the batch that pairs the first person's device: while none is paired, the
 * only person codes are owner's codes, which must not outlive the server's being claimed or signed into.
 */
export function expirePersonCodes(ctx: Ctx) {
  return ctx.db.update(pairingCodes).set({ expiresAt: ctx.now() })
    .where(and(eq(pairingCodes.kind, "person"), isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, ctx.now())));
}

/**
 * A new pairing code for the owner, while no person's device is paired. Until then the only person codes are
 * earlier owner codes, and those stop working, so only the newest code printed works.
 */
export async function ownerPairingCode(ctx: Ctx): Promise<PairingCode | null> {
  if (await personPaired(ctx)) return null;
  await expirePersonCodes(ctx);
  return issueCode(ctx, "person", null, ctx.options.ownerCodeTtlMs);
}

/**
 * What a waiting code is: the owner's code, made whenever no person's device is paired, or a recovery code, made when
 * someone asks for one (`requestRecoveryCode`) while one is. The host keeps both in the same place.
 */
export type OwnerCodeKind = "owner" | "recovery";

/**
 * Hears the owner's code: each code as it is made (`made` true: the host prints it and writes its file), a code kept
 * from an earlier start (`made` false: the host says one waits, without printing it again), and null once a person's
 * device is paired. A recovery code comes the same way, with `kind` "recovery", and null once it is used or expires.
 */
export type OwnerCodeListener = (code: PairingCode | null, made: boolean, kind: OwnerCodeKind) => void;

/** What the host gave `keepOwnerCode`: who hears each new owner's code, and the one waiting now. */
export interface OwnerCodeKeeper {
  listener: OwnerCodeListener;
  /** The waiting code's hash, or null when none waits. */
  waiting: string | null;
  /** What the waiting code is, and until when it works. */
  kind: OwnerCodeKind;
  expiresAt: string | null;
  cancelExpiry: (() => void) | null;
}

/**
 * Starts keeping an owner's code: tells the listener the current one at once (null when a person's device is
 * paired), then each new one, and null once a person pairs. `kept` is the code the host still holds from an earlier
 * start (its file): while it is still a valid, unused owner's code it is kept, and the listener hears it as not made
 * now, so the host doesn't print it again; otherwise a new one is made. Under the lock.
 */
export async function keepOwnerCode(ctx: Ctx, listener: OwnerCodeListener, options: { kept?: string } = {}): Promise<void> {
  ctx.ownerCode?.cancelExpiry?.();
  ctx.ownerCode = { listener, waiting: null, kind: "owner", expiresAt: null, cancelExpiry: null };
  if (await personPaired(ctx)) {
    tell(ctx, null);
    return;
  }
  const kept = options.kept ? await stillWaiting(ctx, options.kept) : null;
  if (kept) await watchExpiry(ctx, ctx.ownerCode, kept, false, "owner");
  else await keepOwnerCodeCurrent(ctx);
}

/**
 * The owner's code the host holds, while it is one this server made for the owner and it is unused and unexpired:
 * while no person's device is paired, every unused person code is an owner's code.
 */
async function stillWaiting(ctx: Ctx, code: string): Promise<PairingCode | null> {
  const row = await ctx.db.select().from(pairingCodes).where(and(
    eq(pairingCodes.codeHash, await sha256(normalizePairingCode(code))),
    eq(pairingCodes.kind, "person"),
    isNull(pairingCodes.usedAt),
    gt(pairingCodes.expiresAt, ctx.now()),
  )).get();
  return row ? { code: normalizePairingCode(code), expiresAt: iso(row.expiresAt) } : null;
}

/**
 * Whenever no person's device is paired, an owner's code waits: made at once, again when it expires unused, and
 * again after the last person's device is removed. Once a person's device is paired, the waiting owner's code is
 * dropped and the listener hears null; a waiting recovery code stays until it is the code used (`used`, its hash) or
 * it expires. Does nothing until a host calls `keepOwnerCode`. Under the lock.
 */
export async function keepOwnerCodeCurrent(ctx: Ctx, used?: string): Promise<void> {
  const keeper = ctx.ownerCode;
  if (!keeper) return;
  if (await personPaired(ctx)) {
    if (keeper.waiting === null) return;
    if (keeper.kind === "recovery" && keeper.waiting !== used) return;
    drop(ctx, keeper);
    return;
  }
  if (keeper.waiting !== null) return;
  await watchExpiry(ctx, keeper, (await ownerPairingCode(ctx))!, true, "owner");
}

/**
 * A recovery code (docs/contract.md, "The owner's password"): made where the host keeps the owner's code, never
 * answered. While no person's device is paired the owner's code is the way in and no other is made; while a code
 * already waits, it is the one. Under the lock.
 */
export async function requestRecoveryCode(ctx: Ctx): Promise<RecoveryCodeAnswer> {
  const keeper = ctx.ownerCode;
  if (!keeper) throw new ServiceError("conflict", "This server keeps no owner's code, so it has nowhere to put a recovery code");
  if (keeper.waiting === null) {
    if (await personPaired(ctx)) {
      await watchExpiry(ctx, keeper, await issueCode(ctx, "person", null, RECOVERY_CODE_TTL_MS), true, "recovery");
    } else {
      await keepOwnerCodeCurrent(ctx);
    }
  }
  return { kind: keeper.kind, expiresAt: keeper.expiresAt ?? iso(ctx.now()) };
}

/** No code waits any more: the listener hears null. */
function drop(ctx: Ctx, keeper: OwnerCodeKeeper): void {
  keeper.cancelExpiry?.();
  keeper.cancelExpiry = null;
  keeper.waiting = null;
  keeper.expiresAt = null;
  tell(ctx, null, false, keeper.kind);
}

/** Makes `code` the one waiting, tells the listener, and when it expires unused, drops it or makes the next owner's code. */
async function watchExpiry(ctx: Ctx, keeper: OwnerCodeKeeper, code: PairingCode, made: boolean, kind: OwnerCodeKind): Promise<void> {
  const hash = await sha256(code.code);
  keeper.waiting = hash;
  keeper.kind = kind;
  keeper.expiresAt = code.expiresAt;
  keeper.cancelExpiry = ctx.host.scheduler.setTimer(Date.parse(code.expiresAt) - ctx.now(), () => {
    void ctx.lock.run(async () => {
      if (ctx.ownerCode !== keeper || keeper.waiting !== hash) return;
      // An owner's code is replaced by the next; a recovery code, or an owner's code once a person paired, just goes.
      if (kind === "recovery" || (await personPaired(ctx))) {
        drop(ctx, keeper);
        return;
      }
      keeper.waiting = null;
      keeper.cancelExpiry = null;
      await keepOwnerCodeCurrent(ctx);
    }).catch((error) => ctx.host.log.error("Couldn't make a new owner's pairing code", error));
  });
  tell(ctx, code, made, kind);
}

function tell(ctx: Ctx, code: PairingCode | null, made = false, kind: OwnerCodeKind = "owner"): void {
  try {
    ctx.ownerCode?.listener(code, made, kind);
  } catch (error) {
    ctx.host.log.error("A listener for the owner's pairing code failed", error);
  }
}
