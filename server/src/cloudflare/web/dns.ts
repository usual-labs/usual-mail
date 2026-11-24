// Names asked over DNS-over-HTTPS, for the Cloudflare host's check that a picture's site is at public addresses only.
// A Worker has no resolver of its own to ask, so it asks Cloudflare's public resolver's JSON API (RFC 8484's JSON form,
// `application/dns-json`) for the name's A and AAAA records, each question within a time limit and a number of tries, as
// Node asks its DNS servers (DNS_LIMITS). The answer checks the name; the fetch itself is resolved by Cloudflare's own
// network, so the connection can't be pinned to the addresses checked (docs/contract-pictures.md, the host notes).

import { DNS_LIMITS } from "../../pictures/rules.ts";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a name to all its addresses, given up as soon as `signal` aborts. Throws when it has none. */
export type Resolve = (hostname: string, signal: AbortSignal) => Promise<ResolvedAddress[]>;

/** Cloudflare's public resolver over HTTPS (1.1.1.1). */
export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

export interface DohOptions {
  endpoint?: string;
  timeoutMs?: number;
  tries?: number;
}

interface DohAnswer {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

const NXDOMAIN = 3;
const TYPES = { A: 1, AAAA: 28 } as const;

/** Asks the resolver for one record type; an empty list when the name has none of that type or doesn't exist. */
async function ask(endpoint: string, hostname: string, type: keyof typeof TYPES, timeoutMs: number, signal: AbortSignal): Promise<ResolvedAddress[]> {
  const url = new URL(endpoint);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type);
  const response = await fetch(url, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The resolver answered ${response.status}`);
  }
  const answer = await response.json() as DohAnswer;
  if (answer.Status === NXDOMAIN) return [];
  if (answer.Status !== 0) throw new Error(`The resolver couldn't answer (status ${String(answer.Status)})`);
  const family = type === "A" ? 4 : 6;
  // Only the records of the type asked: a CNAME on the way names no address. Anything else in their place (an address
  // of the other family, text that is no address) is kept as given, so the check refuses it rather than skipping it.
  return (answer.Answer ?? []).filter((record) => record.type === TYPES[type]).map((record) => ({ address: String(record.data ?? "").trim(), family }));
}

/** Each question tried up to `tries` times; the last failure thrown. */
async function askTried(endpoint: string, hostname: string, type: keyof typeof TYPES, options: Required<Omit<DohOptions, "endpoint">>, signal: AbortSignal): Promise<ResolvedAddress[]> {
  let failure: unknown = new Error("The resolver wasn't asked");
  for (let attempt = 0; attempt < options.tries && !signal.aborted; attempt++) {
    try {
      return await ask(endpoint, hostname, type, options.timeoutMs, signal);
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

/** A resolver asking DNS-over-HTTPS for A and AAAA at once. */
export function dohResolver(options: DohOptions = {}): Resolve {
  const endpoint = options.endpoint ?? DOH_ENDPOINT;
  const limits = { timeoutMs: options.timeoutMs ?? DNS_LIMITS.timeoutMs, tries: options.tries ?? DNS_LIMITS.tries };
  return async (hostname, signal) => {
    const [four, six] = await Promise.allSettled([askTried(endpoint, hostname, "A", limits, signal), askTried(endpoint, hostname, "AAAA", limits, signal)]);
    const found = [...(four.status === "fulfilled" ? four.value : []), ...(six.status === "fulfilled" ? six.value : [])];
    if (found.length === 0) throw four.status === "rejected" ? four.reason : six.status === "rejected" ? six.reason : new Error(`${hostname} has no addresses`);
    return found;
  };
}
