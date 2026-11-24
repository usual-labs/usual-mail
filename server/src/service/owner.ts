// The server's owner and their password (docs/contract.md, "The owner's password"; the owner's decisions of
// 2026-11-24). One owner per server, one row. A server nobody has used yet (no password, no device ever paired, no
// inbox) can be claimed: by whoever comes first, or, when the host names the owner's email, by whoever Google proves has
// it (google/owner-claim.ts). Once used it never can be again, even after every device is revoked. A claim, and every sign-in with the password, pairs the caller's device as a person's, so
// a browser or an app signed in that way is listed, kept and removed like any paired device. Wrong passwords count
// with wrong pairing codes (devices.ts). Forgetting it: a signed-in device sets a new one; otherwise a recovery code,
// made where the host keeps the owner's code (devices.ts, `requestRecoveryCode`).

import {
  ServiceError,
  type Caller,
  type Owner,
  type OwnerClaimInput,
  type OwnerInfo,
  type OwnerPasswordInput,
  type OwnerSignInInput,
  type PairResult,
} from "@usualmail/core";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import { inboxes, owner, type OwnerRow } from "../db/index.ts";
import { claimProof } from "../google/owner-claim.ts";
import { iso } from "../util.ts";
import { requirePerson } from "./access.ts";
import type { Counted } from "./attempts.ts";
import type { Ctx } from "./context.ts";
import { addDevice, checkPairingLimit, countPairingFailure, everPaired, expirePersonCodes, keepOwnerCodeCurrent, personPaired } from "./devices.ts";
import { checkedPassword, hashPassword, passwordMatches } from "./password.ts";
import { check, line } from "./schemas.ts";

/** Long enough for any password the server takes once normalised; anything longer is refused before hashing. */
const PASSWORD_FIELD = v.pipe(v.string(), v.maxLength(1024));
const EMAIL = v.pipe(v.string(), v.trim(), v.maxLength(254), v.toLowerCase(), v.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "That doesn't look like an email address"));

const ClaimSchema = v.strictObject({
  password: PASSWORD_FIELD,
  name: line(100),
  email: v.optional(v.union([v.literal(""), EMAIL])),
  proof: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
const SignInSchema = v.strictObject({ password: PASSWORD_FIELD, name: line(100) });
const PasswordSchema = v.strictObject({ password: PASSWORD_FIELD });

const words = {
  claimed: "This server already has an owner. Sign in with the owner's password, or with a pairing code.",
  needsGoogle: "This server's host named its owner's email, so it is claimed by signing in with Google as that address first.",
  proofGone: "That sign-in with Google is used, expired or unknown. Sign in with Google again.",
  noPassword: "This server has no password yet. Sign in with a pairing code, then set one.",
  wrong: "That password is wrong.",
};

/**
 * The host's owner email (`USUAL_MAIL_OWNER_EMAIL`) in lower case, null when unset or blank, and `invalid: true` when
 * it isn't an email address: then no Google account can match it, so claiming stays closed (the owner's code still
 * works) rather than open to the first visitor.
 */
export function ownerEmailSetting(text: string | undefined): { email: string | null; invalid: boolean } {
  const trimmed = text?.trim().toLowerCase() ?? "";
  if (!trimmed) return { email: null, invalid: false };
  return { email: trimmed, invalid: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.length > 254 };
}

async function ownerRow(ctx: Ctx): Promise<OwnerRow | undefined> {
  return ctx.db.select().from(owner).where(eq(owner.id, 1)).get();
}

/**
 * Whether nobody has used this server yet: no device was ever paired (revoked ones count: device rows are never
 * deleted) and it holds no inbox. Claimable only then, so it is one-way: revoking every device of a server in use (a
 * browser's "Sign out", an app's "Disconnect", or a v0.1.0 server upgraded with no password) leaves the owner's code as
 * the way back in, never a claim open to anyone. No migration is needed: the rows that decide it are already there on
 * every server, on both hosts.
 */
async function unused(ctx: Ctx): Promise<boolean> {
  if (await everPaired(ctx)) return false;
  return (await ctx.db.select({ id: inboxes.id }).from(inboxes).limit(1).get()) === undefined;
}

/** `ServerInfo.owner`: whether there is a password, and whether and how the server can be claimed. */
export async function ownerInfo(ctx: Ctx): Promise<OwnerInfo> {
  const password = Boolean((await ownerRow(ctx))?.passwordHash);
  const claimable = !password && (await unused(ctx));
  return { password, claimable, ...(claimable && { claim: ctx.options.ownerEmail ? "google" : "password" }) };
}

/** Makes the caller the owner of an unclaimed server and pairs its device. Under the lock. */
export async function claimOwner(ctx: Ctx, input: OwnerClaimInput): Promise<PairResult> {
  const data = check(ClaimSchema, input, "Claiming the server");
  if (!(await ownerInfo(ctx)).claimable) throw new ServiceError("conflict", words.claimed);
  const password = checkedPassword(data.password);
  let email = data.email || null;
  if (ctx.options.ownerEmail) {
    if (!data.proof) throw new ServiceError("forbidden", words.needsGoogle);
    const proven = await claimProof(ctx, data.proof);
    if (!proven) throw new ServiceError("unauthorized", words.proofGone);
    proven.use();
    email = proven.email;
  }
  const now = ctx.now();
  // The owner's code that waited (every unused person code, while none is paired) stops working in the same batch, so
  // whoever could read it can't pair once the server is claimed.
  const paired = await addDevice(ctx, { name: data.name, kind: "person", inboxIds: null }, [
    expirePersonCodes(ctx),
    ctx.db.insert(owner).values({ id: 1, email, passwordHash: await hashPassword(password, ctx.host.random), passwordSetAt: now, createdAt: now }),
  ]);
  await keepOwnerCodeCurrent(ctx);
  ctx.host.log.info(`This server now has an owner, claimed from the device ${JSON.stringify(paired.device.name)}.`);
  return paired;
}

/** Pairs the caller's device with the owner's password. `client` is what the caller counts under (attempts.ts). Under the lock. */
export async function signInOwner(ctx: Ctx, input: OwnerSignInInput, client: Counted): Promise<PairResult> {
  checkPairingLimit(ctx, client, "passwords or pairing codes");
  const data = check(SignInSchema, input, "Signing in");
  const stored = (await ownerRow(ctx))?.passwordHash;
  if (!stored) throw new ServiceError("conflict", words.noPassword);
  if (!(await passwordMatches(data.password, stored))) {
    countPairingFailure(ctx, client);
    throw new ServiceError("unauthorized", words.wrong);
  }
  // The first person's device since none was paired: the owner's code that waited stops working with it.
  const first = !(await personPaired(ctx));
  const paired = await addDevice(ctx, { name: data.name, kind: "person", inboxIds: null }, first ? [expirePersonCodes(ctx)] : []);
  // Whatever code waited then (the owner's, or a recovery code from before the last device went) is ended: drop it.
  await keepOwnerCodeCurrent(ctx, first ? ctx.ownerCode?.waiting ?? undefined : undefined);
  return paired;
}

export async function getOwner(ctx: Ctx, caller: Caller): Promise<Owner> {
  requirePerson(caller, "see the owner's account");
  const row = await ownerRow(ctx);
  return {
    email: row?.email ?? null,
    password: Boolean(row?.passwordHash),
    ...(row?.passwordSetAt != null && row.passwordHash && { passwordSetAt: iso(row.passwordSetAt) }),
  };
}

/**
 * Sets the owner's password from a person's device, a first one or a new one. The old one isn't asked for: a
 * person's paired device already has the owner's whole access, and this is how a forgotten one is replaced.
 */
export async function setOwnerPassword(ctx: Ctx, caller: Caller, input: OwnerPasswordInput): Promise<Owner> {
  requirePerson(caller, "set the owner's password");
  const data = check(PasswordSchema, input, "The password");
  const hash = await hashPassword(checkedPassword(data.password), ctx.host.random);
  const now = ctx.now();
  await ctx.db.insert(owner).values({ id: 1, email: null, passwordHash: hash, passwordSetAt: now, createdAt: now })
    .onConflictDoUpdate({ target: owner.id, set: { passwordHash: hash, passwordSetAt: now } });
  ctx.host.log.info("The owner's password was set from a signed-in device.");
  return getOwner(ctx, caller);
}
