// The Worker in front of the server (wrangler.jsonc's `main`): it hands every request to the one Durable Object named
// "server", which holds the whole server.
// - It refuses plain http first, before anything reads the request's Authorization header.
// - It drops X-Forwarded-Host, which the dashboard's own-site check would otherwise accept, and every header named like
//   its own (`x-usual-mail-…`), then sets its own: the client's address from `CF-Connecting-IP` (set by Cloudflare's
//   edge, which replaces any copy a client sends; docs) and the time zone from `request.cf.timezone` (Cloudflare's, not
//   the client's). The object counts wrong pairing codes per address and takes the first pairing's zone from them.
// - An object that fails to answer (reset by a deploy, overloaded, or throwing) gets core's JSON error shape with no
//   internals, 503 when trying again may work and 500 otherwise.
// - It refuses, before waking the object, what would make the object hold a body or work for anyone: a body without
//   Content-Length on REST (`/v1/*`) or in a dashboard form's POST (411), since both read a body whole; and a REST
//   request without a `Bearer umt_…` token, but for the routes that take none by design (core's ROUTES with auth
//   "none" under /v1: GET /v1/info, POST /v1/pair, GET /v1/google/callback, and HEAD for the GETs). The path is the one
//   Hono routes by (requests.ts), so `/v1/%70air` is the pairing route here too. The object still checks every token.
// - Every answer gets the security headers below where the server hasn't set its own: the dashboard, the Google page
//   and the file routes keep theirs, and an event stream passes through untouched but for added headers.
// Not here (left to the object, which answers it as on Node): /healthz.

import { ROUTES } from "@usualmail/core";
import { TOKEN_PREFIX } from "../util.ts";
import type { Env } from "./env.ts";
import { CLIENT_ADDRESS_HEADER, CLIENT_ZONE_HEADER, INTERNAL_HEADER_PREFIX, routedPath } from "./requests.ts";

export { UsualMailServer } from "./object.ts";

/** The server's only object: one server per deployed Worker. Not exported: a Worker's main module exports only handlers. */
const OBJECT_NAME = "server";

/**
 * Set on every answer that hasn't its own. HSTS without includeSubDomains, so a custom domain's other hosts are left
 * alone; a JSON or event-stream answer has nothing to frame, sniff or refer, and `no-store` keeps mail out of caches.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
};

/** REST requests that need no token, as `METHOD /path`: the routes that take none by design (core's ROUTES). */
const TOKENLESS: ReadonlySet<string> = new Set(
  Object.values(ROUTES)
    .filter((route) => route.auth === "none" && route.path.startsWith("/v1/"))
    .flatMap((route) => (route.method === "GET" ? [`GET ${route.path}`, `HEAD ${route.path}`] : [`${route.method} ${route.path}`])),
);

function errorAnswer(status: number, code: "forbidden" | "internal" | "unauthorized" | "invalid", message: string, retryAfter?: number): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store", ...(retryAfter !== undefined && { "retry-after": String(retryAfter) }) } },
  );
}

function refuseHttp(): Response {
  return errorAnswer(403, "forbidden", "This server answers only over HTTPS. Use https:// in its address.");
}

/**
 * Why the Worker refuses a request without passing it on, or null. A body without Content-Length would be read whole
 * by REST and by the dashboard's forms; a REST request without a token would wake the object for nothing it may have.
 */
function refusal(request: Request): Response | null {
  const path = routedPath(request);
  const rest = path === "/v1" || path.startsWith("/v1/");
  const connector = path === "/mcp" || path.startsWith("/mcp/");
  if (request.body !== null && !request.headers.has("content-length") && (rest || (!connector && request.method === "POST"))) {
    if (rest) return errorAnswer(411, "invalid", "Send the request's body with its length (Content-Length).");
    return new Response("Send the form again from the page: its length was missing.", { status: 411, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  if (rest && !TOKENLESS.has(`${request.method} ${path}`)) {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token.startsWith(TOKEN_PREFIX)) return errorAnswer(401, "unauthorized", "Sign in with Authorization: Bearer <token> (from POST /v1/pair)");
  }
  return null;
}

/** What a failed `stub.fetch` becomes: Durable Objects mark errors worth retrying (`retryable`, `overloaded`; docs). */
function objectFailed(error: unknown, request: Request): Response {
  const marked = (error ?? {}) as { retryable?: unknown; overloaded?: unknown; name?: unknown; message?: unknown };
  // The method and path only: a query can hold Google's code or search words.
  console.error(`The server's Durable Object didn't answer ${request.method} ${new URL(request.url).pathname}: ${String(marked.name ?? "Error")}: ${String(marked.message ?? "")}`);
  if (marked.overloaded === true) return errorAnswer(503, "internal", "The server is busy. Try again in a moment.", 5);
  if (marked.retryable === true) return errorAnswer(503, "internal", "The server is restarting. Try again in a moment.", 1);
  return errorAnswer(500, "internal", "Something went wrong on the server");
}

/** The answer with `SECURITY_HEADERS` added where it has none of its own. */
function withSecurityHeaders(response: Response): Response {
  const missing = Object.entries(SECURITY_HEADERS).filter(([name]) => !response.headers.has(name));
  if (missing.length === 0) return response;
  // A fetched answer's headers can't be changed; the copy keeps its body as a stream (an event stream stays one).
  const copy = new Response(response.body, response);
  for (const [name, value] of missing) copy.headers.set(name, value);
  return copy;
}

/** The request as the object gets it: the client's own copies of the headers the Worker vouches for, gone. */
function forwarded(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("x-forwarded-host");
  for (const name of [...headers.keys()]) if (name.startsWith(INTERNAL_HEADER_PREFIX)) headers.delete(name);
  const address = request.headers.get("cf-connecting-ip")?.trim();
  if (address) headers.set(CLIENT_ADDRESS_HEADER, address);
  const zone = (request.cf as { timezone?: unknown } | undefined)?.timezone;
  if (typeof zone === "string" && zone.trim()) headers.set(CLIENT_ZONE_HEADER, zone.trim());
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).protocol !== "https:") return withSecurityHeaders(refuseHttp());
    const refused = refusal(request);
    if (refused) return withSecurityHeaders(refused);
    let response: Response;
    try {
      response = await env.SERVER.getByName(OBJECT_NAME).fetch(forwarded(request));
    } catch (error) {
      response = objectFailed(error, request);
    }
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;
