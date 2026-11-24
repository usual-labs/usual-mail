// Proving the host's owner email with Google before the server is claimed (docs/contract.md, "The owner's password").
// When the host names the owner's email (`USUAL_MAIL_OWNER_EMAIL`), an unclaimed server can be claimed only by whoever
// signs in with Google as that address: the identity scope only (`openid email`), through the host's Google client and
// its usual redirect address, so nothing new is registered at Google. When Google's verified email is the owner's, the
// callback sends the browser on to the dashboard's claim page with a one-time proof (ten minutes), which claiming
// takes. A typed email is never proof.
//
// Like the Gmail sign-ins, these live in memory only: a restart ends one still waiting, and its proof with it.

import { DASHBOARD_PATHS, ServiceError, type OwnerClaimStart } from "@usualmail/core";
import type { Ctx } from "../service/context.ts";
import { ownerInfo } from "../service/owner.ts";
import { base64url, iso, sha256 } from "../util.ts";
import type { CallbackPage, Entry } from "./store.ts";
import { authorizationUrl, exchangeCode, GoogleExchangeError, pkce, verifiedEmail } from "./oauth.ts";
import { googleSignInInfo } from "./sign-in.ts";
import { notAvailable } from "./words.ts";

/** How long a person has to come back from Google, and then to claim with the proof. */
const LIFETIME_MS = 10 * 60_000;
/**
 * Sign-ins to prove the owner's email waiting at once, from one client address (an IPv6 address by its /64) and from
 * everyone: anyone may start one, so both are capped, and one address can't use up everyone's.
 */
export const MAX_WAITING_PER_ADDRESS = 3;
export const MAX_WAITING = 100;
/** The dashboard's page that takes the proof (the dashboard is mounted at the server's root). */
export const CLAIM_PAGE = DASHBOARD_PATHS.claim;

export const claimWords = {
  title: "Signed in with Google",
  proven: "That's the owner's address. Set the server's password to finish.",
  notOwner: "That Google account isn't the address this server's host named as its owner, so it can't claim the server.",
  noEmail: "Google didn't confirm an email address for that account, so it can't claim the server.",
  claimed: "This server already has an owner, so there is nothing to claim.",
  refused: "Google refused the sign-in. Try again.",
};

/**
 * Starts Sign in with Google to prove the owner's email. No caller: the server has no owner yet. `client` is the
 * caller's address key (service/client.ts). Under the lock.
 */
export async function startOwnerClaim(ctx: Ctx, client: string): Promise<OwnerClaimStart> {
  const info = await ownerInfo(ctx);
  if (!info.claimable) throw new ServiceError("conflict", claimWords.claimed);
  if (info.claim !== "google") {
    throw new ServiceError("conflict", "This server's host named no owner email, so it is claimed with a password alone");
  }
  const google = await ctx.google?.client() ?? null;
  const redirectUri = ctx.google?.redirectUri() ?? null;
  if (!google || !redirectUri) {
    const missing = (await googleSignInInfo(ctx)).missing ?? [];
    throw new ServiceError("conflict", `${notAvailable(missing)} Until then, pair with the owner's code instead.`);
  }
  const now = ctx.now();
  ctx.signIns.prune(now);
  const waiting = [...ctx.signIns.all()].filter((entry) => entry.claim && entry.phase === "waiting" && entry.expiresAt > now);
  const fromHere = waiting.filter((entry) => entry.claim!.client === client);
  if (fromHere.length >= MAX_WAITING_PER_ADDRESS || waiting.length >= MAX_WAITING) {
    const oldest = Math.min(...(fromHere.length >= MAX_WAITING_PER_ADDRESS ? fromHere : waiting).map((entry) => entry.expiresAt));
    const retryAfter = Math.max(1, Math.ceil((oldest - now) / 1000));
    const who = fromHere.length >= MAX_WAITING_PER_ADDRESS ? "from your address" : "on this server";
    throw new ServiceError("rate_limited", `Too many sign-ins with Google are waiting ${who}. Try again in ${retryAfter} seconds.`, { retryAfter });
  }
  const state = base64url(ctx.host.random.bytes(32));
  const { verifier, challenge } = await pkce((length) => ctx.host.random.bytes(length));
  const entry: Entry = {
    id: ctx.id("gsi"),
    stateHash: await sha256(state),
    verifier,
    caller: { actor: { kind: "system" } },
    deviceId: "",
    newInbox: {},
    startedAt: now,
    expiresAt: now + LIFETIME_MS,
    phase: "waiting",
    claim: { client },
  };
  ctx.signIns.add(entry);
  // No login hint: this answer goes to anyone who asks, and the owner's email must not travel in it.
  const url = authorizationUrl({
    ...(ctx.google?.authorizationUrl !== undefined && { base: ctx.google.authorizationUrl }),
    clientId: google.clientId,
    redirectUri,
    state,
    challenge,
    purpose: "identity",
  });
  return { url, expiresAt: iso(entry.expiresAt) };
}

type Outcome = NonNullable<Entry["outcome"]>;

/** Google came back with a code for a claim: is it the owner's verified email? On a match, the proof to claim with. */
export async function finishOwnerClaim(ctx: Ctx, entry: Entry, code: string): Promise<Outcome> {
  const failed = (message: string): Outcome => ({ state: "failed", failure: "google_error", message });
  if (!(await ownerInfo(ctx)).claimable) return failed(claimWords.claimed);
  const client = await ctx.google?.client() ?? null;
  const redirectUri = ctx.google?.redirectUri() ?? null;
  const ownerEmail = ctx.options.ownerEmail;
  if (!client || !redirectUri || !ownerEmail) return failed(claimWords.refused);
  let idToken: string | null;
  try {
    idToken = (await exchangeCode(ctx.google?.fetch ?? ((input, init) => fetch(input, init)), client, { code, verifier: entry.verifier, redirectUri })).idToken;
  } catch (error) {
    if (error instanceof GoogleExchangeError) return failed(claimWords.refused);
    throw error;
  }
  const email = idToken ? verifiedEmail(idToken, client.clientId, ctx.now()) : null;
  if (!email) return failed(claimWords.noEmail);
  if (email !== ownerEmail) {
    ctx.host.log.info("A sign-in with Google to claim this server was refused: it wasn't the owner email the host named.");
    return failed(claimWords.notOwner);
  }
  const proof = base64url(ctx.host.random.bytes(32));
  entry.claim = {
    proofHash: await sha256(proof),
    email,
    proofExpiresAt: ctx.now() + LIFETIME_MS,
    redirect: `${CLAIM_PAGE}?proof=${encodeURIComponent(proof)}`,
  };
  return { state: "connected", message: claimWords.proven };
}

/** The page for a finished claim sign-in: on to the dashboard with the proof, or what went wrong. */
export function claimPage(entry: Entry): CallbackPage {
  const outcome = entry.outcome!;
  if (outcome.state === "connected" && entry.claim?.redirect) {
    const redirect = entry.claim.redirect;
    // The proof is in the address once; the entry keeps only its hash.
    delete entry.claim.redirect;
    return { status: 303, title: claimWords.title, message: outcome.message ?? claimWords.proven, redirect };
  }
  return { status: 400, title: "Couldn't claim the server", message: outcome.message ?? claimWords.refused };
}

/**
 * The owner's email a proof stands for, once: unknown, used and expired proofs are null. The proof is used up only
 * when the claim goes ahead (`use`), so a too-short password doesn't spend it.
 */
export async function claimProof(ctx: Ctx, proof: string): Promise<{ email: string; use: () => void } | null> {
  if (!proof) return null;
  const hash = await sha256(proof);
  for (const entry of ctx.signIns.all()) {
    const claim = entry.claim;
    if (!claim?.proofHash || claim.proofHash !== hash || !claim.email) continue;
    if (!(claim.proofExpiresAt! > ctx.now())) return null;
    const email = claim.email;
    return { email, use: () => { delete claim.proofHash; } };
  }
  return null;
}
