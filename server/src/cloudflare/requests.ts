// What the object does with each request before the server's handler sees it. The front Worker (worker.ts) has already
// refused plain http and put its own copies of the client's address and time zone into the headers below, dropping any
// the client sent, so these can be trusted here.
// - The server's public address, for this request only (address.ts).
// - Pairing attempts (`POST /v1/pair`, `/v1/owner/sign-in` and `/v1/owner/claim`, the dashboard's `POST /sign-in`
//   and `/claim`): the per-address count (pairing.ts), answered
//   429 without passing the request on; an owner's code that expired while the object was evicted, refused in plain
//   words before the service counts it as wrong (owner-code.ts); and the time zone of the request that pairs the first
//   person's device (settings.ts).

import { getPath } from "hono/utils/url";
import { PAIR_MAX_BYTES } from "../rest/app.ts";
import { ownOrigin, withRequest, type OwnHosts } from "./address.ts";
import { spentCodeWords, type SpentOwnerCodes } from "./owner-code.ts";
import { addressKey, type AddressCounter } from "./pairing.ts";
import type { ServerTimeZone } from "./settings.ts";

/** Headers only the front Worker sets: any the client sent with this prefix are dropped there. */
export const INTERNAL_HEADER_PREFIX = "x-usual-mail-";
/** The client's address, from the `CF-Connecting-IP` Cloudflare's edge sets. */
export const CLIENT_ADDRESS_HEADER = "x-usual-mail-client-address";
/** The client's time zone, from the request's `cf.timezone`. */
export const CLIENT_ZONE_HEADER = "x-usual-mail-time-zone";

/** The largest pairing body the host reads for its code: what `POST /v1/pair` itself reads; the dashboard's is smaller. */
const MAX_PAIRING_BODY = PAIR_MAX_BYTES;

type Handler = (request: Request) => Response | Promise<Response>;
type PairingKind = "rest" | "dashboard";

/**
 * The path a request is routed by, as Hono reads it for the REST routes: percent-escapes decoded (`/v1/%70air` is
 * `/v1/pair`), but for those of reserved characters such as `/` (`decodeURI`). The dashboard, mounted at the root, routes
 * by the path as written (`new URL(…).pathname`) and so takes `/%73ign-in` for no page of its own.
 */
export function routedPath(request: Pick<Request, "url">): string {
  return getPath(request as Request);
}

/** REST's routes that pair a device with a secret: a pairing code, the owner's password, or Google's claim proof. */
const REST_PAIRING = new Set(["/v1/pair", "/v1/owner/sign-in", "/v1/owner/claim"]);
/** The dashboard's forms that do the same: signing in (with the password or a code) and claiming. */
const DASHBOARD_PAIRING = new Set(["/sign-in", "/claim"]);

/** A pairing attempt's kind, by the path each part routes by: one of REST's or one of the dashboard's. */
export function pairingKind(request: Request): PairingKind | null {
  if (request.method !== "POST") return null;
  if (REST_PAIRING.has(routedPath(request))) return "rest";
  return DASHBOARD_PAIRING.has(new URL(request.url).pathname) ? "dashboard" : null;
}

export interface DoorOptions {
  /** USUAL_MAIL_PUBLIC_URL's origin, or null. */
  publicOrigin: string | null;
  counter: AddressCounter;
  spent: SpentOwnerCodes;
  timeZone: ServerTimeZone;
  /** Whether a person's device is paired now. */
  personPaired: () => boolean;
  /** The server's own hosts, for its fetcher: each origin a request is taken at is noted. */
  ownHosts: OwnHosts;
}

export class RequestDoor {
  readonly #options: DoorOptions;

  constructor(options: DoorOptions) {
    this.#options = options;
  }

  /** Answers one request with `handle`, the request's own address as the server's while it runs, when allowed. */
  serve(request: Request, handle: Handler): Promise<Response> {
    const origin = ownOrigin(request.url, this.#options.publicOrigin);
    this.#options.ownHosts.note(origin);
    return withRequest({ origin, host: new URL(request.url).hostname }, () => this.#serve(request, handle));
  }

  async #serve(request: Request, handle: Handler): Promise<Response> {
    const kind = pairingKind(request);
    if (!kind) return handle(request);
    const { counter, spent, timeZone, personPaired } = this.#options;
    const attempt = counter.begin(addressKey(request.headers.get(CLIENT_ADDRESS_HEADER)));
    if ("retryAfter" in attempt) return tooMany(kind, attempt.retryAfter);
    let failed = false;
    try {
      const expiredAt = await spent.expiredAt(await codeOf(request, kind));
      if (expiredAt !== null) return refusal(kind, 401, "unauthorized", spentCodeWords(expiredAt));
      const before = personPaired();
      const response = await handle(request);
      failed = response.status === 401;
      if (!before && personPaired()) timeZone.paired(request.headers.get(CLIENT_ZONE_HEADER));
      return response;
    } finally {
      attempt.done(failed);
    }
  }
}

/** True while a person's device is paired, read from the store (the service's `devices` table). */
export function personPairedIn(sql: SqlStorage): boolean {
  return sql.exec<{ found: number }>("SELECT EXISTS (SELECT 1 FROM devices WHERE kind = 'person' AND revoked_at IS NULL) AS found").one().found === 1;
}

/** The pairing code a request carries, read from a copy of its body (up to 16 KiB); "" when there is none. */
async function codeOf(request: Request, kind: PairingKind): Promise<string> {
  const text = await cappedText(request.clone(), MAX_PAIRING_BODY);
  if (text === null) return "";
  try {
    if (kind === "dashboard") return new URLSearchParams(text).get("code") ?? "";
    const body: unknown = JSON.parse(text);
    const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
    return typeof code === "string" ? code : "";
  } catch {
    return "";
  }
}

async function cappedText(request: Pick<Request, "headers" | "body">, max: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= max)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function minutes(seconds: number): string {
  const count = Math.max(1, Math.ceil(seconds / 60));
  return count === 1 ? "a minute" : `${count} minutes`;
}

/** Too many wrong codes from one address: core's error shape for REST, a plain page for the dashboard's form. */
function tooMany(kind: PairingKind, retryAfter: number): Response {
  const message = kind === "rest"
    ? `Too many wrong pairing codes or passwords from this address. Try again in ${retryAfter} seconds.`
    : `Too many wrong codes or passwords from this address. Wait ${minutes(retryAfter)}, then try again.`;
  return refusal(kind, 429, "rate_limited", message, retryAfter);
}

function refusal(kind: PairingKind, status: 401 | 429, code: "unauthorized" | "rate_limited", message: string, retryAfter?: number): Response {
  const headers: Record<string, string> = { "cache-control": "no-store", ...(retryAfter !== undefined && { "retry-after": String(retryAfter) }) };
  if (kind === "rest") return Response.json({ error: { code, message } }, { status, headers });
  return new Response(page(message), { status, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** A page with the host's own sentence and a way back; it loads and runs nothing. */
function page(message: string): string {
  const text = message.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<p>${text}</p>
<p><a href="/sign-in">Back to signing in</a></p>
</html>
`;
}
