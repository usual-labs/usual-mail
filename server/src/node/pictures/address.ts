// Which addresses the server may fetch a picture from: public unicast ones only. Never itself, the person's network,
// a link-local or cloud metadata address, a shared or reserved range, or an IPv6 form that wraps one of those.
// From IANA's IPv4 and IPv6 special-purpose address registries (the ranges in src/pictures/rules.ts, which the
// Cloudflare host's fetcher shares); an IPv6 address must be global unicast (2000::/3).
// Nor any address inside a network of the server's own interfaces, read each time: a home's IPv6 addresses and a
// rented server's public ones are global, yet they are the person's own network (the security review of
// 2026-11-18). What can't be seen from inside: the public IPv4 address of a router in front of the server.

import net from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { IPV4_SPECIAL, IPV6_SPECIAL } from "../../pictures/rules.ts";

const blockedV4 = new net.BlockList();
for (const [address, prefix] of IPV4_SPECIAL) blockedV4.addSubnet(address, prefix, "ipv4");
const blockedV6 = new net.BlockList();
for (const [address, prefix] of IPV6_SPECIAL) blockedV6.addSubnet(address, prefix, "ipv6");
const globalV6 = new net.BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

/** The eight 16-bit groups of an IPv6 address (without a zone), or null when it isn't one. */
function groups(address: string): number[] | null {
  if (net.isIPv6(address) === false) return null;
  let text = address;
  // A dotted IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1]!.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, -tail[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const fill = rest === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  const all = [...left, ...fill, ...right].map((group) => Number.parseInt(group, 16));
  return all.length === 8 && all.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? all : null;
}

/** The IPv4 address an IPv6 address wraps as IPv4-mapped (::ffff:0:0/96) or NAT64 (64:ff9b::/96), if it does. */
function wrappedIPv4(address: string): string | null {
  const g = groups(address);
  if (!g) return null;
  const mapped = g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((group) => group === 0);
  if (!mapped && !nat64) return null;
  return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join(".");
}

/** Why an address may or may not be fetched from: public, a special-purpose range, or one of the server's own networks. */
export type AddressVerdict = "public" | "special" | "own";

/**
 * Whether the server may fetch from this address: a public IPv4 address, a global unicast IPv6 address outside the
 * special ranges, or an IPv4-mapped or NAT64 address that wraps a public IPv4 address; and in no network of the
 * server's own interfaces. Zones (`%en0`) never are.
 */
export function isPublicAddress(address: string, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): boolean {
  return addressVerdict(address, interfaces) === "public";
}

/**
 * The verdict on an address. "special" is the same everywhere (the IANA ranges); "own" depends on where the server
 * runs, so a refusal for it is a passing one (the cache tries such a picture again later).
 */
export function addressVerdict(address: string, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): AddressVerdict {
  if (address.includes("%")) return "special";
  const kind = net.isIP(address);
  let v4: string | null = kind === 4 ? address : null;
  if (kind === 6) {
    v4 = wrappedIPv4(address);
    if (!v4 && !(globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6"))) return "special";
  } else if (kind !== 4) {
    return "special";
  }
  if (v4 && blockedV4.check(v4, "ipv4")) return "special";
  return ownNetworks(interfaces).check(v4 ?? address, v4 ? "ipv4" : "ipv6") ? "own" : "public";
}

/**
 * The shortest prefix taken as one of the server's networks: a /16 for IPv4 (a large office), a /32 for IPv6 (an
 * operator's whole block). A shorter one (a VPN's /0) would make the whole internet look local; then only the
 * address's own neighbourhood counts.
 */
export const SHORTEST_OWN_PREFIX = { ipv4: 16, ipv6: 32 };
/** The neighbourhood an address without a usable prefix stands for: its /24, or its /64. */
const NEIGHBOURHOOD = { ipv4: 24, ipv6: 64 };

/**
 * Every network the server's interfaces are on, by address and prefix. A global IPv6 address counts with its whole /64
 * (DHCPv6 gives /128, yet the LAN is the /64); an interface without a prefix (`cidr` null) with its neighbourhood.
 * Only public addresses count: loopback, link-local and private ones are refused anyway, and widening one (::1 to
 * ::/64) would take in every IPv4 address in its IPv4-mapped form.
 */
function ownNetworks(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): net.BlockList {
  const list = new net.BlockList();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const [fromCidr, prefixText] = (entry.cidr ?? "").split("/");
      const address = (fromCidr || entry.address || "").replace(/%.*$/, "");
      const kind = net.isIP(address);
      if (!kind) continue;
      const family = kind === 4 ? "ipv4" : "ipv6";
      if (family === "ipv4" ? blockedV4.check(address, "ipv4") : !globalV6.check(address, "ipv6") || blockedV6.check(address, "ipv6")) continue;
      const given = prefixText === undefined || prefixText === "" ? Number.NaN : Number(prefixText);
      let prefix = Number.isInteger(given) && given >= SHORTEST_OWN_PREFIX[family] ? given : NEIGHBOURHOOD[family];
      if (family === "ipv6") prefix = Math.min(prefix, NEIGHBOURHOOD.ipv6);
      list.addSubnet(address, prefix, family);
    }
  }
  return list;
}
