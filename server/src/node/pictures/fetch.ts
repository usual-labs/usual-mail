// Fetching one picture from the web for the server, safely: http or https on their usual ports only; every address a
// name resolves to must be public, and the connection goes to exactly the addresses that were checked (the name is
// resolved once per hop and pinned, so it can't be rebound to a private address between the check and the
// connection); every redirect is checked again, at most three; no cookies, no referrer, a common browser's user agent
// and no compression; a cap on bytes and on time, resolving names included. Names are asked of DNS servers
// (`dns.Resolver`, with its own time limit and tries), not of the system's getaddrinfo: no hosts file, no local
// names, and no thread of libuv's small pool held by a slow lookup. What the bytes are is decided afterwards, by the
// caller.
//
// A sender's logo is found the same way and under the same rules (`fetchWebBytes`): the site's page, of which only the
// first part is read (`cutAt`), its web app manifest and its icons, each asked for with what it is (`accept`), and the
// address the answer finally came from, after redirects, so the page's own links resolve against it.

import { Resolver } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import net, { type LookupFunction } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { PictureRefused } from "../../pictures/refused.ts";
import { DNS_LIMITS, PICTURE_ACCEPT, PICTURE_LIMITS, PICTURE_USER_AGENT, REDIRECTS, usualPorts } from "../../pictures/rules.ts";
import { addressVerdict, type AddressVerdict } from "./address.ts";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface FetchOptions {
  /** Resolves a name to all its addresses. Default: `dnsResolver()`, the system's DNS servers. Tests give a fake one. */
  resolve?: (hostname: string, signal: AbortSignal) => Promise<ResolvedAddress[]>;
  /**
   * Whether an address may be connected to. Default: public addresses only (`isPublicAddress`). Only the tests of
   * fetching that works widen it, to their own fake host on 127.0.0.1; the tests of the dangers never do.
   */
  allowAddress?: (address: string) => boolean;
  /** The server's network interfaces, for the own-network rule. Default: this machine's. Only tests give made-up ones. */
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** Whether a port may be used. Default: 80 for http and 443 for https. */
  allowPort?: (port: number, protocol: "http:" | "https:") => boolean;
  /** Certificate authorities to trust instead of the system's: only tests give one, for their own host. */
  ca?: string;
  maxBytes?: number;
  /**
   * Read at most this many bytes and stop there, keeping them, instead of refusing a longer answer: for a page, of
   * which only the head is read. A declared length beyond it is no reason to refuse. Give it below `maxBytes`.
   */
  cutAt?: number;
  /** What the request asks for. Default: the picture types the server shows. */
  accept?: string;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRedirects?: number;
}

// The limits, headers and ports both hosts' fetchers share (src/pictures/rules.ts), under their names here too.
export { DNS_LIMITS, PICTURE_LIMITS, PICTURE_USER_AGENT };
const ACCEPT = PICTURE_ACCEPT;

export interface DnsOptions {
  /** DNS servers to ask instead of the system's (`host:port`): only tests give any. */
  servers?: string[];
  timeoutMs?: number;
  tries?: number;
}

/**
 * Resolves a name by asking DNS servers (the system's unless given) for its A and AAAA records, each query with a time
 * limit and a number of tries, and given up as soon as `signal` aborts.
 */
export function dnsResolver(options: DnsOptions = {}): (hostname: string, signal: AbortSignal) => Promise<ResolvedAddress[]> {
  return async (hostname, signal) => {
    const resolver = new Resolver({ timeout: options.timeoutMs ?? DNS_LIMITS.timeoutMs, tries: options.tries ?? DNS_LIMITS.tries });
    if (options.servers) resolver.setServers(options.servers);
    const cancel = () => resolver.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const [four, six] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
      const found = [
        ...(four.status === "fulfilled" ? four.value.map((address) => ({ address, family: 4 })) : []),
        ...(six.status === "fulfilled" ? six.value.map((address) => ({ address, family: 6 })) : []),
      ];
      if (found.length === 0) throw four.status === "rejected" ? four.reason : new Error(`${hostname} has no addresses`);
      return found;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };
}

const systemResolve = dnsResolver();

interface Target {
  url: URL;
  protocol: "http:" | "https:";
  /** The host as the request names it: a name, or an IP address without brackets. */
  host: string;
  port: number;
  /** The checked addresses the connection may use. */
  addresses: ResolvedAddress[];
}

/** The bytes at `url`, or a `PictureRefused` saying why not, in words for a person. */
export async function fetchPictureBytes(url: string, options: FetchOptions = {}): Promise<Uint8Array> {
  return (await fetchWebBytes(url, options)).bytes;
}

/** The bytes at `url` and the address they finally came from, after redirects, or a `PictureRefused` saying why not. */
export async function fetchWebBytes(url: string, options: FetchOptions = {}): Promise<{ bytes: Uint8Array; url: string }> {
  const limits = { ...PICTURE_LIMITS, ...options };
  const deadline = AbortSignal.timeout(limits.totalTimeoutMs);
  let current = url;
  for (let hop = 0; ; hop++) {
    const target = await check(current, options, deadline);
    const response = await request(target, options, limits.connectTimeoutMs, deadline);
    const status = response.statusCode ?? 0;
    if (REDIRECTS.has(status)) {
      response.destroy();
      const location = response.headers.location;
      if (!location) throw new PictureRefused(`its site redirected without saying where (${status})`);
      if (hop >= limits.maxRedirects) throw new PictureRefused(`its site redirected more than ${limits.maxRedirects} times`, "refused");
      current = new URL(location, target.url).href;
      continue;
    }
    if (status !== 200) {
      response.destroy();
      throw new PictureRefused(`its site answered ${status}`);
    }
    return { bytes: await read(response, limits.maxBytes, deadline, options.cutAt), url: target.url.href };
  }
}

/**
 * A sender's one-click unsubscribe (RFC 8058; docs/contract.md, "Unsubscribing"): "List-Unsubscribe=One-Click" POSTed
 * to `url` from their mail, under the same rules for where the server connects, https only and following no redirect
 * (the RFC asks that a one-click POST not be redirected). The answer's status, the body unread, or a `PictureRefused`
 * saying why it couldn't be sent.
 */
export async function postOneClick(url: string, options: FetchOptions = {}): Promise<number> {
  const limits = { ...PICTURE_LIMITS, ...options };
  const deadline = AbortSignal.timeout(limits.totalTimeoutMs);
  if (!/^https:/i.test(url)) throw new PictureRefused("one-click addresses are https only", "refused");
  const target = await check(url, options, deadline);
  const response = await request(target, options, limits.connectTimeoutMs, deadline, ONE_CLICK_BODY);
  response.destroy();
  return response.statusCode ?? 0;
}

/** What a one-click POST sends (RFC 8058, section 3.1). */
const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

/** The address to connect to for `value`, checked: protocol, port, no user name, and every address public. */
async function check(value: string, options: FetchOptions, deadline: AbortSignal): Promise<Target> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PictureRefused("its address isn't one", "refused");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PictureRefused(`pictures aren't fetched over ${url.protocol}`, "refused");
  if (url.username || url.password) throw new PictureRefused("its address carries a user name", "refused");
  const protocol = url.protocol;
  const port = url.port ? Number(url.port) : protocol === "https:" ? 443 : 80;
  if (!(options.allowPort ?? usualPorts)(port, protocol)) throw new PictureRefused(`pictures aren't fetched from port ${port}`, "refused");
  // Tests admit their own fake host by `allowAddress`; the server judges by `addressVerdict`.
  const verdict = (address: string): AddressVerdict =>
    options.allowAddress ? (options.allowAddress(address) ? "public" : "special") : addressVerdict(address, options.interfaces);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(host)) {
    // An address the mail names in a special range is refused for good; one in the server's own networks depends on
    // where the server runs, so it is a failure that may pass.
    const found = verdict(host);
    if (found === "special") throw new PictureRefused("its address is a private one", "refused");
    if (found === "own") throw new PictureRefused("its address is on this server's own network");
    return { url, protocol, host, port, addresses: [{ address: host, family: net.isIP(host) }] };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await within((options.resolve ?? systemResolve)(host, deadline), deadline);
  } catch (error) {
    if (error instanceof PictureRefused) throw error;
    throw new PictureRefused("its site's name doesn't resolve");
  }
  if (addresses.length === 0) throw new PictureRefused("its site's name doesn't resolve");
  // One private address among public ones is enough to refuse: the name could be handed to either. What a name
  // answers depends on the DNS servers asked (one that blocks trackers answers 0.0.0.0), not only on the sender, so
  // it is a failure that may pass, not a refusal for good.
  if (addresses.some((found) => verdict(found.address) !== "public")) throw new PictureRefused("its site's name points at a private address");
  return { url, protocol, host, port, addresses };
}

/** `work`, or a refusal as soon as the deadline passes, whichever comes first. */
function within<T>(work: Promise<T>, deadline: AbortSignal): Promise<T> {
  const late = () => new PictureRefused("its site took too long to send it");
  if (deadline.aborted) return Promise.reject(late());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(late());
    deadline.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => (deadline.removeEventListener("abort", abort), resolve(value)),
      (error: unknown) => (deadline.removeEventListener("abort", abort), reject(error)),
    );
  });
}

/** A lookup that answers only with the addresses already checked, whatever it is asked. */
function pinned(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    const usable = family ? addresses.filter((found) => found.family === family) : addresses;
    const first = usable[0];
    if (!first) {
      callback(Object.assign(new Error("No checked address of that family"), { code: "ENOTFOUND" }), "", 0);
    } else if (options.all) {
      (callback as unknown as (error: null, addresses: ResolvedAddress[]) => void)(null, usable);
    } else {
      callback(null, first.address, first.family);
    }
  };
}

/** One request: a GET, or with `form` a POST of that form body. */
function request(target: Target, options: FetchOptions, connectTimeoutMs: number, deadline: AbortSignal, form?: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = target.protocol === "https:" ? https.request : http.request;
    const headers: Record<string, string> = { "user-agent": PICTURE_USER_AGENT, accept: options.accept ?? ACCEPT, "accept-encoding": "identity" };
    if (form !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers["content-length"] = String(Buffer.byteLength(form));
    }
    const req = send({
      protocol: target.protocol,
      host: target.host,
      port: target.port,
      path: `${target.url.pathname}${target.url.search}`,
      method: form === undefined ? "GET" : "POST",
      headers,
      // A new connection for every hop, so it can only reach this hop's checked addresses.
      agent: false,
      lookup: pinned(target.addresses),
      signal: deadline,
      ...(options.ca !== undefined && { ca: options.ca }),
    }, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    const timer = setTimeout(() => req.destroy(new PictureRefused("its site didn't answer in time")), connectTimeoutMs);
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(refusal(error, deadline));
    });
    req.end(form);
  });
}

/**
 * The body, uncompressed: at most `maxBytes`, or, with `cutAt`, its first `cutAt` bytes however long it is (the rest
 * is never read: the connection is closed).
 */
async function read(response: IncomingMessage, maxBytes: number, deadline: AbortSignal, cutAt?: number): Promise<Uint8Array> {
  const encoding = response.headers["content-encoding"];
  if (encoding && encoding.trim().toLowerCase() !== "identity") {
    response.destroy();
    throw new PictureRefused("its site sent it compressed, which was not asked for", "refused");
  }
  const tooBig = `it is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`;
  const declared = Number(response.headers["content-length"]);
  if (cutAt === undefined && Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new PictureRefused(tooBig, "refused");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response as AsyncIterable<Uint8Array>) {
      if (cutAt !== undefined && total + chunk.byteLength >= cutAt) {
        chunks.push(chunk.subarray(0, cutAt - total));
        total = cutAt;
        response.destroy();
        break;
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        response.destroy();
        throw new PictureRefused(tooBig, "refused");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    throw refusal(error, deadline);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Any failure as a refusal in a person's words, without the address. */
function refusal(error: unknown, deadline: AbortSignal): PictureRefused {
  if (error instanceof PictureRefused) return error;
  if (deadline.aborted) return new PictureRefused("its site took too long to send it");
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /CERT|SSL|TLS|ERR_TLS/.test(code)) return new PictureRefused("its site's certificate isn't valid");
  return new PictureRefused(`its site couldn't be reached${typeof code === "string" ? ` (${code})` : ""}`);
}
