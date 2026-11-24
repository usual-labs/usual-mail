// Client addresses, on both hosts. Wrong passwords, wrong pairing codes and Google claim sign-ins are counted per
// client address (service/attempts.ts): an IPv4 address as it is, an IPv6 address by its /64 (one household's or one
// server's whole range) and, for wrong passwords and codes, also by its /48 (one site's: up to 65,536 /64s). Cloudflare's
// edge says who the client is (CF-Connecting-IP). On Node it is the connection's own address, unless that is a reverse
// proxy the host named in USUAL_MAIL_TRUSTED_PROXIES: then it is the address the proxies wrote into X-Forwarded-For
// (`forwardedClient`).

/** Eight 16-bit groups of an IPv6 address, or null when it isn't one. */
function ipv6Groups(text: string): number[] | null {
  let address = text.toLowerCase().replace(/%.*$/, "");
  // An IPv4 tail (::ffff:192.0.2.1) as its two groups.
  const tail = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (tail) {
    const bytes = tail.slice(2).map(Number);
    if (bytes.some((byte) => byte > 255)) return null;
    address = `${tail[1]}${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const part = (half: string) => (half === "" ? [] : half.split(":"));
  const head = part(halves[0]!);
  const rest = halves.length === 2 ? part(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

function ipv4Bytes(text: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return null;
  const bytes = text.split(".").map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}

/**
 * An address as bytes: 4 for IPv4, 16 for IPv6, an IPv4-mapped IPv6 address (::ffff:192.0.2.1) as its IPv4 bytes. A
 * bracketed IPv6 address and a port, as some proxies write them ("[2001:db8::1]:443", "192.0.2.1:5000"), are read too.
 * Null for anything else.
 */
export function parseAddress(text: string): number[] | null {
  let value = text.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1]!;
  else if (/^[\d.]+:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));
  const v4 = ipv4Bytes(value);
  if (v4) return v4;
  const groups = ipv6Groups(value);
  if (!groups) return null;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255];
  }
  return groups.flatMap((group) => [group >> 8, group & 255]);
}

/** What one client's wrong passwords and codes count under (service/attempts.ts). */
export interface ClientKey {
  /** `addressKey`: an IPv4 address, an IPv6 address's /64, "unknown" or "other:…". */
  address: string;
  /** An IPv6 address's /48, counted too so a site's many /64s don't each get their own limit; null for the rest. */
  block: string | null;
}

/**
 * The keys an address is counted under: an IPv4 address as it is; an IPv6 address by its /64, and its /48 beside it; an
 * IPv4-mapped IPv6 address as its IPv4 address. No address at all shares one key ("unknown").
 */
export function clientKey(address: string | null): ClientKey {
  const text = address?.trim() ?? "";
  if (!text) return { address: "unknown", block: null };
  const bytes = parseAddress(text);
  if (!bytes) return { address: `other:${text.slice(0, 64).toLowerCase()}`, block: null };
  if (bytes.length === 4) return { address: bytes.join("."), block: null };
  const groups = [0, 2, 4, 6].map((at) => ((bytes[at]! << 8) | bytes[at + 1]!).toString(16));
  return { address: `${groups.join(":")}::/64`, block: `${groups.slice(0, 3).join(":")}::/48` };
}

/** The key an address is counted under on its own (`clientKey`'s `address`). */
export function addressKey(address: string | null): string {
  return clientKey(address).address;
}

/** A range of addresses: its first bytes and how many bits of them count. */
export interface AddressRange {
  bytes: number[];
  bits: number;
}

/**
 * What `private` stands for in USUAL_MAIL_TRUSTED_PROXIES: the addresses a proxy on the same machine or private network
 * connects from (loopback, RFC 1918, shared address space 100.64.0.0/10, link-local, IPv6 unique local).
 */
export const PRIVATE_RANGES = [
  "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16",
  "::1/128", "fc00::/7", "fe80::/10",
];

/**
 * What `cloudflare` stands for in USUAL_MAIL_TRUSTED_PROXIES: the addresses Cloudflare's proxy connects to an origin
 * from, as Cloudflare published them at https://www.cloudflare.com/ips/ (ips-v4 and ips-v6, the same as its API's
 * /client/v4/ips), copied on 2026-11-24. Written here, never fetched while the server runs, so a range Cloudflare adds
 * later is missing until this list is updated: a client reaching the server through it counts as that edge address.
 */
export const CLOUDFLARE_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29",
  "2c0f:f248::/32",
];

/** The words USUAL_MAIL_TRUSTED_PROXIES takes, and the ranges each stands for. */
const NAMED_RANGES = new Map<string, readonly string[]>([["private", PRIVATE_RANGES], ["cloudflare", CLOUDFLARE_RANGES]]);

function parseRange(text: string): AddressRange | null {
  const [address, bits, extra] = text.split("/");
  if (extra !== undefined) return null;
  const bytes = parseAddress(address!);
  if (!bytes || address!.includes("[")) return null;
  const max = bytes.length * 8;
  if (bits === undefined) return { bytes, bits: max };
  if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return null;
  return { bytes, bits: Number(bits) };
}

/**
 * USUAL_MAIL_TRUSTED_PROXIES: addresses and ranges (192.0.2.10, 172.16.0.0/12, fd00::/8) separated by commas, and the
 * words `private` (`PRIVATE_RANGES`) and `cloudflare` (`CLOUDFLARE_RANGES`). Empty: none. Throws, naming the first entry
 * it can't read, and refuses a /0 range (0.0.0.0/0, ::/0): that is every address, so anyone could write the
 * X-Forwarded-For their wrong passwords count under.
 */
export function parseRanges(text: string | undefined): AddressRange[] {
  const ranges: AddressRange[] = [];
  for (const entry of (text ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const named = NAMED_RANGES.get(entry.toLowerCase());
    if (named) {
      ranges.push(...named.map((range) => parseRange(range)!));
      continue;
    }
    const range = parseRange(entry);
    if (!range) {
      throw new Error(`USUAL_MAIL_TRUSTED_PROXIES takes addresses and ranges like 172.16.0.0/12 or fd00::/8, separated by commas, or the words private and cloudflare; "${entry.slice(0, 64)}" isn't one`);
    }
    if (range.bits === 0) {
      throw new Error(`USUAL_MAIL_TRUSTED_PROXIES can't hold "${entry.slice(0, 64)}": a /0 range is every address, so anyone could choose the address their wrong passwords count under. Name only your proxies' addresses or ranges, or private`);
    }
    ranges.push(range);
  }
  return ranges;
}

/** Whether the address `bytes` is in one of `ranges`. */
export function inRanges(bytes: number[], ranges: readonly AddressRange[]): boolean {
  return ranges.some((range) => {
    if (range.bytes.length !== bytes.length) return false;
    for (let bit = 0; bit < range.bits; bit += 8) {
      const left = Math.min(8, range.bits - bit);
      const mask = (0xff << (8 - left)) & 0xff;
      if ((range.bytes[bit / 8]! & mask) !== (bytes[bit / 8]! & mask)) return false;
    }
    return true;
  });
}

/**
 * The client behind a connection from `peer`. When `peer` isn't a trusted proxy (or none is named), the client is
 * `peer` itself, and X-Forwarded-For, which anyone can send, is ignored. When it is, the client is the right-most
 * address in X-Forwarded-For that isn't a trusted proxy too: each proxy adds the address it was reached from, so only
 * what the trusted proxies added is believed, and whatever a client wrote further left is not. An entry that isn't an
 * address stops the walk, and the trusted proxy that passed it on is taken as the client; with no header, the peer.
 */
export function forwardedClient(peer: string | null, forwardedFor: string | null | undefined, trusted: readonly AddressRange[]): string | null {
  const peerBytes = peer ? parseAddress(peer) : null;
  if (!peer || !peerBytes || trusted.length === 0 || !inRanges(peerBytes, trusted)) return peer;
  const hops = (forwardedFor ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  let client = peer;
  for (let at = hops.length - 1; at >= 0; at--) {
    const bytes = parseAddress(hops[at]!);
    if (!bytes) return client;
    client = hops[at]!;
    if (!inRanges(bytes, trusted)) return client;
  }
  return client;
}
