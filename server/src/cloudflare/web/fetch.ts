// Fetching one picture, or a site's page, manifest or icon, from a Worker, under Node's rules wherever Workers let them
// be kept (src/node/pictures/fetch.ts; docs/contract-pictures.md): http or https on ports 80 and 443 only; no user name
// in the address; an IP address in the address refused (a special-range one for good; a Worker can't fetch a bare IP
// address at all); every address the name has, asked over DNS-over-HTTPS, public, else refused as a failure that may
// pass; every redirect checked again before it is followed (`redirect: "manual"`), at most three; no cookies (a Worker
// keeps none), no referrer, a common browser's user agent; gzip or br asked for and taken (a Worker's fetch decodes
// them itself, so what is counted and kept is the decoded bytes; any other encoding is refused); at most 10 MB and 15 seconds, the
// lookups included, and five seconds to an answer; never the server's own host names (`ownHost`), which a fetch would
// reach through the front door like anyone's.
//
// What a Worker can't keep: the connection isn't pinned to the address checked (Cloudflare's network resolves the name
// again, so a name rebound between the check and the fetch isn't caught here), and Cloudflare adds a `CF-Worker`
// header naming the Worker's zone to every request. What it doesn't need: the server's own networks, since a Worker
// has no home network behind it; `global_fetch_strictly_public` sends its fetches out as to the public internet.

import { PictureRefused } from "../../pictures/refused.ts";
import { PICTURE_ACCEPT, PICTURE_LIMITS, PICTURE_USER_AGENT, REDIRECTS, usualPorts } from "../../pictures/rules.ts";
import { ipKind, isPublicAddress } from "./addresses.ts";
import { dohResolver, type Resolve } from "./dns.ts";

export interface WorkerFetchOptions {
  /** Resolves a name to its addresses. Default: DNS-over-HTTPS at Cloudflare's public resolver. */
  resolve?: Resolve;
  /** Whether a host name is the server's own (`OwnHosts`): never fetched from. Default: none is. */
  ownHost?: (host: string) => boolean;
  /** Whether a port may be used. Default: 80 for http and 443 for https. */
  allowPort?: (port: number, protocol: "http:" | "https:") => boolean;
  maxBytes?: number;
  /** Read at most this many bytes and keep them, instead of refusing a longer answer: for a page's head. */
  cutAt?: number;
  /** What the request asks for. Default: the picture types the server shows. */
  accept?: string;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRedirects?: number;
}

const defaultResolve = dohResolver();

/** What a fetch asks for and takes: the encodings a Worker's fetch decodes itself (gzip and br; local workerd checked). */
const ACCEPT_ENCODING = "gzip, br";
const DECODED = new Set(["", "identity", "gzip", "br"]);

/** The bytes at `url` and the address they finally came from, after redirects, or a `PictureRefused` saying why not. */
export async function fetchWebBytes(url: string, options: WorkerFetchOptions = {}): Promise<{ bytes: Uint8Array; url: string }> {
  const limits = { ...PICTURE_LIMITS, ...options };
  const deadline = AbortSignal.timeout(limits.totalTimeoutMs);
  let current = url;
  for (let hop = 0; ; hop++) {
    const target = await check(current, options, deadline);
    const response = await request(target, options.accept ?? PICTURE_ACCEPT, limits.connectTimeoutMs, deadline);
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) throw new PictureRefused(`its site redirected without saying where (${response.status})`);
      if (hop >= limits.maxRedirects) throw new PictureRefused(`its site redirected more than ${limits.maxRedirects} times`, "refused");
      current = new URL(location, target).href;
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new PictureRefused(`its site answered ${response.status}`);
    }
    return { bytes: await read(response, limits.maxBytes, deadline, options.cutAt), url: target.href };
  }
}

/** `value` checked: protocol, port, no user name, no IP address, and every address its name has public. */
async function check(value: string, options: WorkerFetchOptions, deadline: AbortSignal): Promise<URL> {
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
  // The URL parser has already written any form of an IP address (0x7f.1, 2130706433, [::ffff:7f00:1]) canonically.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (ipKind(host)) {
    if (!isPublicAddress(host)) throw new PictureRefused("its address is a private one", "refused");
    throw new PictureRefused("its address is a bare IP address, which this server can't fetch from", "refused");
  }
  // The server itself, by any of its own names: a failure that may pass, as Node's own networks are (the address the
  // server is reached at can change).
  if (options.ownHost?.(host)) throw new PictureRefused("its address is this server's own");
  let addresses;
  try {
    addresses = await within((options.resolve ?? defaultResolve)(host, deadline), deadline);
  } catch (error) {
    if (error instanceof PictureRefused) throw error;
    throw new PictureRefused("its site's name doesn't resolve");
  }
  if (addresses.length === 0) throw new PictureRefused("its site's name doesn't resolve");
  // One private address among public ones is enough to refuse. What a name answers depends on the resolver asked, not
  // only on the sender, so it is a failure that may pass, as on Node.
  if (addresses.some((found) => !isPublicAddress(found.address))) throw new PictureRefused("its site's name points at a private address");
  return url;
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

/** One request, without following a redirect, given up when no answer comes within `connectTimeoutMs`. */
async function request(url: URL, accept: string, connectTimeoutMs: number, deadline: AbortSignal): Promise<Response> {
  const answer = new AbortController();
  const timer = setTimeout(() => answer.abort(new PictureRefused("its site didn't answer in time")), connectTimeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": PICTURE_USER_AGENT, accept, "accept-encoding": ACCEPT_ENCODING },
      signal: AbortSignal.any([deadline, answer.signal]),
    });
  } catch (error) {
    if (answer.signal.aborted && !deadline.aborted) throw new PictureRefused("its site didn't answer in time");
    throw refusal(error, deadline);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The body, decoded: at most `maxBytes`, or, with `cutAt`, its first `cutAt` bytes however long it is (the rest never
 * read). A gzip or br body arrives decoded, so a small body that decodes to more than the limit (a decompression bomb)
 * is stopped there; Content-Length counts the encoded bytes, so a declared length over the limit is refused at once.
 */
async function read(response: Response, maxBytes: number, deadline: AbortSignal, cutAt?: number): Promise<Uint8Array> {
  const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (!DECODED.has(encoding)) {
    await response.body?.cancel().catch(() => undefined);
    throw new PictureRefused("its site sent it compressed in a way the server doesn't read", "refused");
  }
  const tooBig = `it is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`;
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (cutAt === undefined && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new PictureRefused(tooBig, "refused");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  try {
    while (reader) {
      const { done, value } = await within(reader.read(), deadline);
      if (done) break;
      if (cutAt !== undefined && total + value.byteLength >= cutAt) {
        chunks.push(value.subarray(0, cutAt - total));
        total = cutAt;
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) throw new PictureRefused(tooBig, "refused");
      chunks.push(value);
    }
  } catch (error) {
    throw refusal(error, deadline);
  } finally {
    await reader?.cancel().catch(() => undefined);
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
  return new PictureRefused("its site couldn't be reached");
}
