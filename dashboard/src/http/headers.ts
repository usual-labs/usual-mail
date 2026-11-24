// Strict headers on every response, and the embedded assets served with long caching.
import type { Context, MiddlewareHandler } from "hono";
import { ASSETS } from "../generated/assets.ts";

/**
 * No scripts at all, nothing inline, nothing from elsewhere, no framing. `default-src 'self'` covers the icon
 * sprite, which `<use>` loads from this site.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * `same-origin`, not `no-referrer`: with no-referrer, browsers send `Origin: null` on this site's own form posts,
 * which would make them look cross-site.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
};

const decoded = new Map<string, Uint8Array<ArrayBuffer>>();

function bytesOf(path: string, body: string, base64: boolean): Uint8Array<ArrayBuffer> {
  let bytes = decoded.get(path);
  if (!bytes) {
    bytes = base64 ? Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(body);
    decoded.set(path, bytes);
  }
  return bytes;
}

/** An embedded asset by its content-hashed path, kept by browsers for a year; anything else is not found. */
export function serveAsset(c: Context, path: string): Response | null {
  const asset = ASSETS[path];
  if (!asset) return null;
  return c.body(bytesOf(path, asset.body, asset.base64), 200, {
    "Content-Type": asset.type,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}
