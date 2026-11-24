// Which addresses the Cloudflare host fetches pictures from: public unicast ones only, judged by the same IANA ranges as
// Node (src/pictures/rules.ts): no private, shared, loopback, link-local or metadata range, no reserved or documentation
// one, an IPv6 address only in global unicast (2000::/3), and no IPv6 form that wraps a refused IPv4 address
// (IPv4-mapped, NAT64). Plain JavaScript: `node:net`'s BlockList isn't relied on in workerd. Node's other rule, an
// address in a network of the server's own interfaces, has nothing to hold on to here: a Worker has no home network.

import { IPV4_SPECIAL, IPV6_SPECIAL } from "../../pictures/rules.ts";

/** An IPv4 address in the dotted form URLs and DNS answers write, as a 32-bit number; null when it isn't one. */
function ipv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

/** The eight 16-bit groups of an IPv6 address (no zone), or null when it isn't one. */
function ipv6(address: string): number[] | null {
  if (!address.includes(":") || address.includes("%")) return null;
  let text = address.toLowerCase();
  // A dotted IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const four = ipv4(tail[1]!);
    if (four === null) return null;
    text = `${text.slice(0, -tail[1]!.length)}${(four >>> 16).toString(16)}:${(four & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  if (all.length !== 8 || !all.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return all.map((group) => Number.parseInt(group, 16));
}

function inV4(value: number, [base, prefix]: readonly [string, number]): boolean {
  const start = ipv4(base)!;
  const size = 2 ** (32 - prefix);
  return value >= start && value < start + size;
}

function inV6(groups: number[], [base, prefix]: readonly [string, number]): boolean {
  const start = ipv6(base)!;
  for (let bit = 0; bit < prefix; bit += 16) {
    const take = Math.min(16, prefix - bit);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((groups[bit / 16]! & mask) !== (start[bit / 16]! & mask)) return false;
  }
  return true;
}

/** Whether a URL's host (without brackets) or a DNS answer is an IP address: 4, 6, or 0 for a name. */
export function ipKind(host: string): 0 | 4 | 6 {
  if (ipv4(host) !== null) return 4;
  return ipv6(host) !== null ? 6 : 0;
}

/**
 * Whether a picture may be fetched from this address: a public IPv4 address, a global unicast IPv6 address outside the
 * special ranges, or an IPv4-mapped or NAT64 address wrapping a public IPv4 address. Anything unreadable is not.
 */
export function isPublicAddress(address: string): boolean {
  const four = ipv4(address);
  if (four !== null) return !IPV4_SPECIAL.some((range) => inV4(four, range));
  const groups = ipv6(address);
  if (!groups) return false;
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
  if (mapped || nat64) return isPublicAddress([groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join("."));
  if ((groups[0]! & 0xe000) !== 0x2000) return false;
  return !IPV6_SPECIAL.some((range) => inV6(groups, range));
}
