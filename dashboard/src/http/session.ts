// The sign-in cookie and the form tokens that protect every form against cross-site requests.
//
// - The session cookie holds a person's device token. It is HttpOnly (scripts can't read it), SameSite=Strict and
//   host-only (sent only to this site, under the dashboard's path), and Secure everywhere except plain HTTP on
//   localhost. Over HTTPS at the root it takes the `__Host-` prefix, so no other subdomain can set it.
// - Signed-in forms carry a token derived from the session token (SHA-256), so a page on another site can't know it.
// - The sign-in form, before any session exists, uses a random value kept in a second cookie (double submit).
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const SESSION = "usual-mail-session";
const SIGN_IN = "usual-mail-sign-in";
/** Thirty days. Signing out revokes the device; the Devices page lists browsers that never signed out. */
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SIGN_IN_SECONDS = 60 * 60;

/** True for plain HTTP on this machine, where browsers keep a cookie without Secure. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export interface CookieScope {
  secure: boolean;
  path: string;
  /** The `__Host-` prefix needs Secure and Path=/. */
  prefix: "" | "__Host-";
}

export function cookieScope(request: Request, base: string): CookieScope {
  const url = new URL(request.url);
  const secure = url.protocol === "https:" || !isLocalHost(url.hostname);
  return { secure, path: base || "/", prefix: secure && !base ? "__Host-" : "" };
}

function write(c: Context, scope: CookieScope, name: string, value: string, maxAge: number): void {
  setCookie(c, scope.prefix + name, value, {
    path: scope.path,
    httpOnly: true,
    secure: scope.secure,
    sameSite: "Strict",
    maxAge,
  });
}

export function readSession(c: Context, scope: CookieScope): string | undefined {
  return getCookie(c, scope.prefix + SESSION) || undefined;
}

export function writeSession(c: Context, scope: CookieScope, token: string): void {
  write(c, scope, SESSION, token, SESSION_SECONDS);
}

export function clearSession(c: Context, scope: CookieScope): void {
  deleteCookie(c, scope.prefix + SESSION, { path: scope.path, secure: scope.secure, httpOnly: true, sameSite: "Strict" });
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The form token for a session: not the token itself, and not something another site can work out. */
export async function formToken(sessionToken: string): Promise<string> {
  const data = new TextEncoder().encode(`usual-mail-dashboard/form/${sessionToken}`);
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

/** Compares without stopping at the first difference. */
export function sameToken(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The sign-in form's token: the one in its cookie, or a new one, which is set. */
export function signInToken(c: Context, scope: CookieScope): string {
  const current = getCookie(c, scope.prefix + SIGN_IN);
  if (current && /^[A-Za-z0-9_-]{32}$/.test(current)) return current;
  const fresh = base64url(crypto.getRandomValues(new Uint8Array(24)));
  write(c, scope, SIGN_IN, fresh, SIGN_IN_SECONDS);
  return fresh;
}

export function readSignInToken(c: Context, scope: CookieScope): string | undefined {
  return getCookie(c, scope.prefix + SIGN_IN) || undefined;
}

export function clearSignInToken(c: Context, scope: CookieScope): void {
  deleteCookie(c, scope.prefix + SIGN_IN, { path: scope.path, secure: scope.secure, httpOnly: true, sameSite: "Strict" });
}

/**
 * A browser's own check that a form came from this site. `Sec-Fetch-Site` decides when the browser sends it; else
 * `Origin` must name this host. A request with neither (an old browser) is left to the form token.
 */
export function cameFromThisSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  if (origin === "null") return false;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const hosts = [new URL(request.url).host, request.headers.get("host"), request.headers.get("x-forwarded-host")];
  return hosts.some((candidate) => candidate?.toLowerCase() === host);
}
