// The server's public address on Cloudflare, as the owner decided (server-cloudflare.md, "The server's public address"):
// each request's own host, for that request only, and only when it is a host Cloudflare routes to this Worker on
// purpose: the Worker's own workers.dev address, or the host of USUAL_MAIL_PUBLIC_URL (a custom domain). Never stored:
// the object's request wrapper keeps the origin in an AsyncLocalStorage while the request runs, so Google's redirect
// address is built from it then; at start-up, in an alarm or for any other host there is none, and `ServerInfo` reports
// the missing `address`. Always https: the front Worker refuses http, and nothing here builds an http address.
//
// How the Worker knows its workers.dev host: it doesn't learn the name, it relies on Cloudflare's routing (docs). A
// request reaches this Worker only through hostnames routed to it; on workers.dev, with version addresses off
// (wrangler.jsonc's `preview_urls: false`), that is `<worker name>.<account subdomain>.workers.dev` alone, so any host
// of that shape that reaches the Worker is its own. A renamed Worker or a new subdomain needs no step. That a request
// naming another host never reaches the Worker is unverified until a real deploy.

import { AsyncLocalStorage } from "node:async_hooks";
import { CALLBACK_PATH } from "../google/config.ts";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** `<worker name>.<account subdomain>.workers.dev`, as a URL writes a host (lowercase). */
const WORKERS_DEV = new RegExp(`^${LABEL}\\.${LABEL}\\.workers\\.dev$`);

/** True for a workers.dev host of the one shape Cloudflare routes to a Worker whose version addresses are off. */
export function isWorkersDevHost(hostname: string): boolean {
  return WORKERS_DEV.test(hostname);
}

/** USUAL_MAIL_PUBLIC_URL as the server uses it: an https origin, or null with the log's words for why not. */
export interface PublicUrl {
  origin: string | null;
  /** Why a value that was set isn't used, for the log. */
  problem?: string;
}

/**
 * Reads USUAL_MAIL_PUBLIC_URL: an origin only ("https://mail.example.org"), https, without a path, a query or a login.
 * Anything else is left out, with words for the log: the server still starts, on its workers.dev address alone.
 */
export function readPublicUrl(text: string | undefined): PublicUrl {
  const value = text?.trim() ?? "";
  if (!value) return { origin: null };
  const problem =
    "USUAL_MAIL_PUBLIC_URL isn't used: it must be the HTTPS address people reach the server at, an origin like " +
    "https://mail.example.org, without a path, a query or a login.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { origin: null, problem };
  }
  const bare = !url.username && !url.password && !url.search && !url.hash && (url.pathname === "/" || url.pathname === "");
  if (url.protocol !== "https:" || !bare) return { origin: null, problem };
  return { origin: url.origin };
}

/**
 * The origin a request may name as the server's own: its own, when that is USUAL_MAIL_PUBLIC_URL's origin or a
 * workers.dev host on the default port; otherwise null. Never http.
 */
export function ownOrigin(requestUrl: string, configured: string | null): string | null {
  const url = new URL(requestUrl);
  if (url.protocol !== "https:") return null;
  if (configured !== null && url.origin === configured) return configured;
  if (url.port === "" && isWorkersDevHost(url.hostname)) return `https://${url.hostname}`;
  return null;
}

/** The request being answered: the origin the server takes as its own for it (or none), and the host it came to. */
export interface RequestPlace {
  origin: string | null;
  /** The request's own host name, lower case, whatever it is: for the fetcher, which never fetches from the server itself. */
  host: string;
  /** The client's address, CF-Connecting-IP as the front Worker passed it on (`Host.clientAddress`); null without one. */
  client: string | null;
}

const current = new AsyncLocalStorage<RequestPlace>();

/** Runs `handle` with this request's place for as long as it (and what it starts) runs. */
export function withRequest<T>(place: RequestPlace, handle: () => T): T {
  return current.run(place, handle);
}

/** `GoogleOptions.redirectUri` on Cloudflare: under the address of the request being answered, or null. */
export function requestRedirectUri(): string | null {
  const origin = current.getStore()?.origin ?? null;
  return origin === null ? null : `${origin}${CALLBACK_PATH}`;
}

/** The client address of the request being answered, or null outside a request: `Host.clientAddress` on Cloudflare. */
export function requestClient(): string | null {
  return current.getStore()?.client ?? null;
}

/** The host name the request being answered came to, or null outside a request (start-up, an alarm). */
export function requestHost(): string | null {
  return current.getStore()?.host ?? null;
}

/** A host name as compared: lower case, without a final dot. */
const bareHost = (host: string): string => host.toLowerCase().replace(/\.$/, "");

/**
 * The server's own host names, which its fetcher never fetches a picture or a site's icon from (a picture at the server's
 * own address would make it ask itself): USUAL_MAIL_PUBLIC_URL's, each host whose address the server took as its own in
 * this instance (its workers.dev address), and the host the request being answered came to, whatever it is.
 */
export class OwnHosts {
  readonly #known = new Set<string>();

  constructor(publicOrigin: string | null) {
    this.note(publicOrigin);
  }

  /** Notes an origin the server takes as its own. */
  note(origin: string | null): void {
    if (origin) this.#known.add(bareHost(new URL(origin).hostname));
  }

  /** Whether `host` is one of the server's own. */
  has(host: string): boolean {
    const bare = bareHost(host);
    const asked = requestHost();
    return this.#known.has(bare) || (asked !== null && bareHost(asked) === bare);
  }
}

/**
 * What the host does when the server doesn't take a request's address as its own (after core's `noAddress`; the
 * route's words, `GoogleOptions.addressFix`).
 */
export const ADDRESS_FIX =
  "It takes as its own only its workers.dev address and the address in its Worker variable USUAL_MAIL_PUBLIC_URL. " +
  "Connect to it at its workers.dev address, or its host sets USUAL_MAIL_PUBLIC_URL to the HTTPS address people reach " +
  "it at in the Worker's settings; no app can set it.";
