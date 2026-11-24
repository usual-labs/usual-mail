/**
 * A fake of Google's OAuth 2.0 for a web application client, as a `fetch` function, in front of one `FakeGmail` per
 * Google account. Built from Google's documentation (OAuth 2.0 for web server applications and for installed
 * applications, Using OAuth 2.0, the OpenID Connect discovery document; read 2026-11-17):
 *
 * - The authorization endpoint (`GET https://accounts.google.com/o/oauth2/v2/auth`) checks the client and that
 *   `redirect_uri` exactly matches a registered one (otherwise Google's own error page, never a redirect), then does
 *   what `consent` says the person did and answers with the redirect a browser would follow: `code`, `state` and the
 *   granted `scope`, or `error=access_denied`.
 * - The token endpoint (`POST https://oauth2.googleapis.com/token`): `authorization_code` checks the client, the code
 *   (once, for ten minutes), the same `redirect_uri` and the PKCE verifier (S256 or plain), and gives a refresh token
 *   only with `access_type=offline`, on an account's first grant or with `prompt=consent`; `refresh_token` goes to
 *   the account the token belongs to.
 * - Revocation (`POST https://oauth2.googleapis.com/revoke`, `token=`): ends the account's whole grant, every refresh
 *   and access token of it; an unknown token is `400`.
 * - Gmail's API goes to the account the access token belongs to.
 */
import { createHash, randomBytes } from "node:crypto";
import { FakeGmail } from "./fake-gmail/index.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_API = "https://gmail.googleapis.com/";
const CODE_LIFETIME_MS = 10 * 60_000;

/** What the person does on Google's screens, for every sign-in until it is changed. */
export interface Consent {
  /** Which account signs in. Default: the first one added. */
  account?: string;
  /** Default `allow`; `decline` sends `error=access_denied` back. */
  answer?: "allow" | "decline";
  /** The scopes left ticked. Default: every scope asked for. */
  scopes?: string[];
  /** Force a refresh token (true) or none (false). Default: as Google decides (offline, first grant or consent). */
  refreshToken?: boolean;
}

export interface FakeGoogleOptions {
  clientId?: string;
  clientSecret?: string;
  /** The client's authorized redirect URIs, matched exactly. */
  redirectUris: string[];
  now?: () => number;
}

interface PendingCode {
  account: string;
  scopes: string[];
  redirectUri: string;
  challenge: string | null;
  method: string;
  refreshToken: boolean;
  expiresAt: number;
  used: boolean;
}

export class FakeGoogle {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUris: string[];
  /** The accounts, by address, each with its own mailbox. */
  readonly accounts = new Map<string, FakeGmail>();
  consent: Consent = {};
  /** Every query the authorization endpoint was opened with. */
  readonly authorizations: URLSearchParams[] = [];
  /** Every form the token endpoint was sent (they carry secrets; tests only). */
  readonly tokenForms: URLSearchParams[] = [];
  /** Tokens revoked, in order. */
  readonly revoked: string[] = [];
  #codes = new Map<string, PendingCode>();
  #revokeFaults: number[] = [];
  #now: () => number;

  constructor(options: FakeGoogleOptions) {
    this.clientId = options.clientId ?? "fake-client.apps.googleusercontent.example";
    this.clientSecret = options.clientSecret ?? "fake-client-secret";
    this.redirectUris = [...options.redirectUris];
    this.#now = options.now ?? (() => Date.now());
  }

  /** Adds a Google account with an empty mailbox. */
  addAccount(address: string): FakeGmail {
    const gmail = new FakeGmail({ address, clientId: this.clientId, clientSecret: this.clientSecret, now: this.#now, refreshToken: `unused-${token()}` });
    this.accounts.set(address, gmail);
    return gmail;
  }

  /** An account's mailbox and tokens. */
  account(address: string): FakeGmail {
    const found = this.accounts.get(address);
    if (!found) throw new Error(`No fake Google account ${address}`);
    return found;
  }

  /** The next `times` revocations answer with this status. */
  failNextRevoke(times: number, status = 503): void {
    for (let i = 0; i < times; i++) this.#revokeFaults.push(status);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const base = url.origin + url.pathname;
    if (base === GOOGLE_AUTH_URL) return this.#authorize(url.searchParams);
    if (base === GOOGLE_TOKEN_URL) return this.#token(method, input, init);
    if (base === GOOGLE_REVOKE_URL) return this.#revoke(method, url, init);
    if (url.href.startsWith(GMAIL_API)) return this.#gmail(input, init);
    return json(404, { error: "not_found" });
  };

  #authorize(query: URLSearchParams): Response {
    this.authorizations.push(query);
    if (query.get("client_id") !== this.clientId) return page(401, "Error 401: invalid_client. The OAuth client was not found.");
    const redirectUri = query.get("redirect_uri") ?? "";
    if (!this.redirectUris.includes(redirectUri)) return page(400, "Error 400: redirect_uri_mismatch. You can't sign in to this app because it doesn't comply with Google's OAuth 2.0 policy.");
    if (query.get("response_type") !== "code") return page(400, "Error 400: invalid_request. response_type must be code.");
    const asked = (query.get("scope") ?? "").split(" ").filter(Boolean);
    if (asked.length === 0) return page(400, "Error 400: invalid_request. Missing required parameter: scope");
    const challenge = query.get("code_challenge");
    const method = query.get("code_challenge_method") ?? "plain";
    if (challenge !== null && method !== "S256" && method !== "plain") return page(400, "Error 400: invalid_request. Invalid code_challenge_method.");
    const back = new URL(redirectUri);
    const state = query.get("state");
    if (this.consent.answer === "decline") {
      back.searchParams.set("error", "access_denied");
      if (state !== null) back.searchParams.set("state", state);
      return redirect(back);
    }
    const address = this.consent.account ?? [...this.accounts.keys()][0];
    const account = address ? this.accounts.get(address) : undefined;
    if (!address || !account) return page(400, "Error 400: no such account in the fake");
    const scopes = this.consent.scopes ?? asked;
    const offline = query.get("access_type") === "offline";
    // Google gives a refresh token on the first grant, and again only when consent is asked for.
    const firstGrant = account.grantedRefreshTokens.size === 0;
    const consent = (query.get("prompt") ?? "").split(" ").includes("consent");
    const refreshToken = this.consent.refreshToken ?? (offline && (firstGrant || consent));
    const code = `4/fake-${token()}`;
    this.#codes.set(code, { account: address, scopes, redirectUri, challenge, method, refreshToken, expiresAt: this.#now() + CODE_LIFETIME_MS, used: false });
    if (state !== null) back.searchParams.set("state", state);
    back.searchParams.set("code", code);
    back.searchParams.set("scope", scopes.join(" "));
    back.searchParams.set("authuser", "0");
    back.searchParams.set("prompt", "consent");
    return redirect(back);
  }

  async #token(method: string, input: string | URL | Request, init: RequestInit): Promise<Response> {
    const form = new URLSearchParams(String(init.body ?? ""));
    this.tokenForms.push(form);
    if (method !== "POST") return json(405, { error: "invalid_request" });
    const grant = form.get("grant_type");
    if (grant === "refresh_token") {
      const refresh = form.get("refresh_token") ?? "";
      const owner = [...this.accounts.values()].find((account) => account.acceptsRefreshToken(refresh));
      // An unknown refresh token: let any account answer, which says invalid_grant as Google does.
      return (owner ?? [...this.accounts.values()][0])?.fetch(input, init) ?? json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    }
    if (grant !== "authorization_code") return json(400, { error: "unsupported_grant_type", error_description: "Invalid grant_type" });
    if (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret) {
      return json(401, { error: "invalid_client", error_description: "Unauthorized" });
    }
    const pending = this.#codes.get(form.get("code") ?? "");
    if (!pending || pending.used || pending.expiresAt <= this.#now()) return json(400, { error: "invalid_grant", error_description: "Bad Request" });
    pending.used = true;
    if (form.get("redirect_uri") !== pending.redirectUri) return json(400, { error: "redirect_uri_mismatch", error_description: "Bad Request" });
    if (pending.challenge !== null) {
      const verifier = form.get("code_verifier") ?? "";
      const made = pending.method === "S256" ? createHash("sha256").update(verifier).digest("base64url") : verifier;
      if (!verifier || made !== pending.challenge) return json(400, { error: "invalid_grant", error_description: "Invalid code verifier." });
    }
    const account = this.account(pending.account);
    const body: Record<string, unknown> = {
      access_token: account.issueAccessToken(),
      expires_in: 3599,
      scope: pending.scopes.join(" "),
      token_type: "Bearer",
    };
    if (pending.refreshToken) {
      const refresh = `1//fake-${token()}`;
      account.grantedRefreshTokens.add(refresh);
      body.refresh_token = refresh;
    }
    return json(200, body);
  }

  #revoke(method: string, url: URL, init: RequestInit): Response {
    if (method !== "POST") return json(405, { error: "invalid_request" });
    const fault = this.#revokeFaults.shift();
    if (fault !== undefined) return json(fault, { error: "backend_error" });
    const given = new URLSearchParams(String(init.body ?? "")).get("token") ?? url.searchParams.get("token") ?? "";
    const owner = [...this.accounts.values()].find((account) => account.acceptsRefreshToken(given) || account.holdsAccessToken(given));
    if (!given || !owner) return json(400, { error: "invalid_token", error_description: "Token expired or revoked" });
    this.revoked.push(given);
    owner.revokeGrant();
    return json(200, {});
  }

  #gmail(input: string | URL | Request, init: RequestInit): Promise<Response> {
    const auth = new Headers(init.headers).get("authorization") ?? "";
    const accessToken = auth.replace(/^Bearer\s+/i, "");
    const owner = [...this.accounts.values()].find((account) => account.holdsAccessToken(accessToken));
    // An unknown token: any account answers 401, as Gmail does.
    return (owner ?? [...this.accounts.values()][0]!).fetch(input, init);
  }
}

function token(): string {
  return randomBytes(18).toString("base64url");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function page(status: number, text: string): Response {
  return new Response(`<!doctype html><title>Error</title><p>${text}</p>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirect(to: URL): Response {
  return new Response(null, { status: 302, headers: { location: to.href } });
}
