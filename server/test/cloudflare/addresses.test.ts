// The Cloudflare host's address rule (src/cloudflare/web/addresses.ts, plain JavaScript, since workerd's `node:net`
// BlockList isn't relied on) against Node's (src/node/pictures/address.ts, BlockList over the same IANA ranges in
// src/pictures/rules.ts): both must refuse and allow the same addresses. Every special range's first and last address
// and its neighbours on either side, in IPv4, IPv4-mapped and NAT64 forms, the edges of global unicast IPv6, and text
// that is no address. Node's own-network rule is left out (no interfaces given): a Worker has no network of its own.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ipKind, isPublicAddress as cloudflarePublic } from "../../src/cloudflare/web/addresses.ts";
import { addressVerdict } from "../../src/node/pictures/address.ts";
import { IPV4_SPECIAL, IPV6_SPECIAL } from "../../src/pictures/rules.ts";

const nodePublic = (address: string) => addressVerdict(address, {}) === "public";

const v4 = (value: number) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
const v4Value = (address: string) => address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);

/** An IPv6 address as eight groups, from a base address and a 128-bit offset. */
function v6(base: string, offset: bigint): string {
  const [head, tail] = base.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right].map((group) => BigInt(`0x${group}`));
  let value = groups.reduce((sum, group) => (sum << 16n) | group, 0n) + offset;
  value &= (1n << 128n) - 1n;
  const out: string[] = [];
  for (let i = 0; i < 8; i++) out.unshift((value & 0xffffn).toString(16)), (value >>= 16n);
  return out.join(":");
}

test("the Cloudflare host refuses and allows exactly the addresses Node does", () => {
  const cases = new Set<string>();
  for (const [base, prefix] of IPV4_SPECIAL) {
    const first = v4Value(base);
    const last = first + 2 ** (32 - prefix) - 1;
    for (const value of [first - 1, first, first + 1, last - 1, last, last + 1]) {
      if (value < 0 || value > 0xffffffff) continue;
      const address = v4(value);
      cases.add(address);
      cases.add(`::ffff:${address}`);
      const [a, b, c, d] = address.split(".").map(Number) as [number, number, number, number];
      cases.add(`64:ff9b::${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`);
      cases.add(`::ffff:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`);
    }
  }
  for (const [base, prefix] of [...IPV6_SPECIAL, ["2000::", 3] as const]) {
    const size = 1n << BigInt(128 - prefix);
    for (const offset of [-1n, 0n, 1n, size - 2n, size - 1n, size]) cases.add(v6(base, offset));
  }
  for (const address of ["8.8.8.8", "93.184.215.14", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:81a::200e", "::1", "::", "fe80::1",
    "fc00::1", "fd12:3456::1", "ff02::1", "64:ff9b:1::1", "::a00:1", "2001:4860:4860::8888", "100::1"]) cases.add(address);
  assert.ok(cases.size > 300, `${cases.size} addresses`);
  const differ = [...cases].filter((address) => cloudflarePublic(address) !== nodePublic(address));
  assert.deepEqual(differ, [], "addresses the two hosts judge differently");
  // Both directions are exercised: some of these are public, most are not.
  const allowed = [...cases].filter((address) => nodePublic(address)).length;
  assert.ok(allowed > 50 && allowed < cases.size - 100, `${allowed} public of ${cases.size}`);
});

test("text that is no address is never public, and a name is no IP address", () => {
  for (const text of ["", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.-4", ":::", "1::2::3", "12345::", "::g", "fe80::1%en0", "1.2.3.4%en0", "[::1]"]) {
    assert.equal(cloudflarePublic(text), false, text);
    assert.equal(nodePublic(text), false, text);
  }
  assert.equal(ipKind("pictures.example"), 0);
  assert.equal(ipKind("93.184.215.14"), 4);
  assert.equal(ipKind("2606:2800:21f:cb07:6820:80da:af6b:8b2c"), 6);
});
