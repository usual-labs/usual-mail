// How an inbox connected by signing in with Google keeps its access: sealed, only the client's id and the refresh
// token; the host's client secret is added each time the provider is opened, so the host can change the secret
// without anyone signing in again, and the secret never sits in an inbox's credentials.

import type { InboxConnection } from "@usualmail/core";
import type { InboxRow } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { errorMessage } from "../util.ts";
import { attention } from "./words.ts";

/** What is sealed for an inbox connected by signing in with Google. */
export interface SignedInCredentials {
  signIn: "google";
  clientId: string;
  refreshToken: string;
}

export function isSignedIn(value: unknown): value is SignedInCredentials {
  const v = value as Partial<SignedInCredentials> & { clientSecret?: unknown } | null;
  return typeof v === "object" && v !== null && v.signIn === "google" && typeof v.clientId === "string" &&
    typeof v.refreshToken === "string" && v.clientSecret === undefined;
}

/** Credentials given by hand may not claim to come from a sign-in. */
export function claimsSignIn(credentials: unknown): boolean {
  return typeof credentials === "object" && credentials !== null && "signIn" in credentials;
}

/**
 * Why the provider of an inbox connected by signing in with Google can't be opened: the host's setup (`host_setup`, no
 * Google client) or the inbox's own sign-in (`needs_sign_in`, made with another client). sync/health.ts reads `reason`.
 */
export class InboxAccessError extends Error {
  readonly reason: "needs_sign_in" | "host_setup";

  constructor(reason: "needs_sign_in" | "host_setup", message: string) {
    super(message);
    this.name = "InboxAccessError";
    this.reason = reason;
  }
}

/** The credentials to open the inbox's provider with: the stored ones, with the host's secret for a sign-in. */
export async function providerCredentials(ctx: Ctx, inbox: InboxRow): Promise<unknown> {
  const stored: unknown = JSON.parse(await ctx.host.secrets.open(inbox.credentials, inbox.id));
  if (!isSignedIn(stored)) return stored;
  const client = await ctx.google?.client() ?? null;
  if (!client) throw new InboxAccessError("host_setup", attention.clientMissing(ctx.google?.clientFix));
  if (client.clientId !== stored.clientId) throw new InboxAccessError("needs_sign_in", attention.otherClient);
  return { clientId: stored.clientId, clientSecret: client.clientSecret, refreshToken: stored.refreshToken };
}

/** The refresh token of an inbox connected by signing in with Google, or null. */
export async function signedInToken(ctx: Ctx, inbox: InboxRow): Promise<string | null> {
  try {
    const stored: unknown = JSON.parse(await ctx.host.secrets.open(inbox.credentials, inbox.id));
    return isSignedIn(stored) ? stored.refreshToken : null;
  } catch {
    return null;
  }
}

/** The connection a sign-in stores: the provider's description, marked as signed in. */
export function signedInConnection(connection: InboxConnection): InboxConnection {
  return connection.kind === "gmail" ? { ...connection, signIn: "google" } : connection;
}


/**
 * Why an inbox's provider failed, in words a person can act on. An inbox connected by signing in with Google whose
 * token or client Google refused is told to sign in again, or that the host must fix the client (`clientFix`: how
 * this host gives it, `GoogleOptions.clientFix`). How a sync sorts a failure is sync/health.ts's.
 */
export function attentionWords(inbox: InboxRow, error: unknown, clientFix?: string): string {
  const signedIn = inbox.connection?.kind === "gmail" && inbox.connection.signIn === "google";
  if (signedIn && error instanceof Error && error.name === "GoogleTokenError") {
    const kind = (error as Error & { kind?: string }).kind;
    return kind === "client_refused" ? attention.clientRefused(clientFix) : attention.tokenRefused;
  }
  return errorMessage(error);
}
