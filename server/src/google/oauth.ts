// Google's OAuth 2.0 for a web application client, as Google documents it (read 2026-11-17): the address that starts
// a sign-in, the code exchange with PKCE, and revocation. Nothing here logs or returns a secret.

import { GOOGLE_GMAIL_SCOPE } from "@usualmail/core";
import { base64url, fromBase64url } from "../util.ts";
import { GOOGLE_AUTH_URL, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, type GoogleClient, type GoogleFetch } from "./config.ts";

const TIMEOUT_MS = 30_000;

/** PKCE: a verifier of 43 characters from 32 random bytes, and its S256 challenge. */
export async function pkce(random: (length: number) => Uint8Array<ArrayBuffer>): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(random(32));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/**
 * The address the person's browser opens. Offline access with consent, so Google gives a refresh token every time;
 * the one scope; PKCE; the state. A reconnect names the inbox's address as `login_hint`; a new inbox asks Google to
 * show the account chooser too, for people with several accounts.
 */
export function authorizationUrl(input: {
  base?: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  loginHint?: string;
  /**
   * "identity": only who the person is (`openid email`), online, to prove the owner's email before claiming; no
   * mail. Default "gmail".
   */
  purpose?: "gmail" | "identity";
}): string {
  const identity = input.purpose === "identity";
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: identity ? IDENTITY_SCOPE : GOOGLE_GMAIL_SCOPE,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  if (identity) {
    params.set("prompt", "select_account");
  } else {
    params.set("access_type", "offline");
    params.set("prompt", input.loginHint ? "consent" : "consent select_account");
  }
  if (input.loginHint) params.set("login_hint", input.loginHint);
  return `${input.base ?? GOOGLE_AUTH_URL}?${params}`;
}

/** Who the person is, nothing of their mail: OpenID Connect's email, for the owner's email. Not sensitive at Google. */
export const IDENTITY_SCOPE = "openid email";

/** What the token endpoint answered for a code. Only what the server reads. */
export interface ExchangedCode {
  refreshToken: string | null;
  /** The scopes granted, space-separated as Google sends them, or null when Google sent none. */
  scope: string | null;
  /** The OpenID Connect ID token, with the `openid` scope. */
  idToken: string | null;
}

/** Google refused the exchange or couldn't be reached. `code` is Google's error code when it sent one. */
export class GoogleExchangeError extends Error {
  readonly code: string | null;
  constructor(code: string | null) {
    super(`Google refused to exchange the sign-in code${code ? ` (${code})` : ""}`);
    this.name = "GoogleExchangeError";
    this.code = code;
  }
}

/** Trades the code for tokens at the token endpoint, with the verifier and the same redirect address. */
export async function exchangeCode(
  fetch: GoogleFetch,
  client: GoogleClient,
  input: { code: string; verifier: string; redirectUri: string },
): Promise<ExchangedCode> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.verifier,
  });
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GoogleExchangeError(null);
  }
  const data = (await response.json().catch(() => ({}))) as { refresh_token?: unknown; scope?: unknown; id_token?: unknown; error?: unknown };
  if (!response.ok) throw new GoogleExchangeError(typeof data.error === "string" ? data.error.slice(0, 60) : null);
  return {
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : null,
    scope: typeof data.scope === "string" ? data.scope : null,
    idToken: typeof data.id_token === "string" && data.id_token ? data.id_token : null,
  };
}

/**
 * The verified email an ID token names, or null. The token came straight from Google's token endpoint over TLS, in
 * exchange for this server's own code, so its signature needn't be checked (OpenID Connect Core 1.0, 3.1.3.7, item 6);
 * its issuer, audience, expiry and `email_verified` are.
 */
export function verifiedEmail(idToken: string, clientId: string, now: number): string | null {
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  let claims: { iss?: unknown; aud?: unknown; exp?: unknown; email?: unknown; email_verified?: unknown };
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
  } catch {
    return null;
  }
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return null;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
  if (claims.email_verified !== true && claims.email_verified !== "true") return null;
  return typeof claims.email === "string" && claims.email ? claims.email.trim().toLowerCase() : null;
}

/** Whether the granted scopes, as Google lists them, include the one the server needs. */
export function grantsGmail(scope: string | null): boolean {
  return scope !== null && scope.split(" ").includes(GOOGLE_GMAIL_SCOPE);
}

/**
 * Revokes a token at Google. Google's documentation: revoking ends the whole grant of that Google account to this
 * client's project, every token of it. Answers whether Google said it worked; never throws.
 */
export async function revokeToken(fetch: GoogleFetch, token: string): Promise<{ ok: boolean; status: number | null }> {
  try {
    const response = await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: null };
  }
}
