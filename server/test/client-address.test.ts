// Client addresses (client-address.ts, node/client.ts): the keys an address counts under (an IPv6 address by its /64
// and its /48), USUAL_MAIL_TRUSTED_PROXIES (its words private and cloudflare, no /0), and who the client is behind a
// proxy: X-Forwarded-For believed only from a trusted proxy, and then only what the trusted proxies added.

import assert from "node:assert/strict";
import { test } from "node:test";
import { addressKey, clientKey, CLOUDFLARE_RANGES, forwardedClient, inRanges, parseAddress, parseRanges } from "../src/client-address.ts";
import { requestClient, withRequestClient } from "../src/node/client.ts";
import { readConfig } from "../src/node/config.ts";

test("an address counts as itself, an IPv6 address by its /64, a mapped IPv4 address as IPv4", () => {
  assert.equal(addressKey("203.0.113.5"), "203.0.113.5");
  assert.equal(addressKey("::ffff:203.0.113.5"), "203.0.113.5");
  assert.equal(addressKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(addressKey("2001:0DB8:0001:0002:ffff:0:0:9"), "2001:db8:1:2::/64");
  assert.equal(addressKey("[2001:db8:1:2::1]:443"), "2001:db8:1:2::/64");
  assert.equal(addressKey("203.0.113.5:5000"), "203.0.113.5");
  assert.equal(addressKey(null), "unknown");
  assert.equal(addressKey("  "), "unknown");
  assert.equal(addressKey("999.1.1.1"), "other:999.1.1.1");
  assert.equal(parseAddress("not an address"), null);
});

test("an IPv6 address counts by its /48 as well; IPv4 and unknown addresses have no wider key", () => {
  assert.deepEqual(clientKey("2001:db8:1:2::1"), { address: "2001:db8:1:2::/64", block: "2001:db8:1::/48" });
  assert.deepEqual(clientKey("2001:0DB8:0001:ffff:1:2:3:4"), { address: "2001:db8:1:ffff::/64", block: "2001:db8:1::/48" });
  assert.deepEqual(clientKey("[2001:db8::9]:443"), { address: "2001:db8:0:0::/64", block: "2001:db8:0::/48" });
  assert.deepEqual(clientKey("::ffff:203.0.113.5"), { address: "203.0.113.5", block: null });
  assert.deepEqual(clientKey("203.0.113.5"), { address: "203.0.113.5", block: null });
  assert.deepEqual(clientKey(null), { address: "unknown", block: null });
  assert.deepEqual(clientKey("garbage"), { address: "other:garbage", block: null });
});

test("USUAL_MAIL_TRUSTED_PROXIES: addresses, ranges and private; anything else is refused in words", () => {
  const ranges = parseRanges("192.0.2.10, 172.16.0.0/12,fd00::/8");
  assert.equal(ranges.length, 3);
  assert.ok(inRanges(parseAddress("172.18.0.3")!, ranges));
  assert.ok(inRanges(parseAddress("::ffff:172.31.255.1")!, ranges));
  assert.ok(!inRanges(parseAddress("172.32.0.1")!, ranges));
  assert.ok(inRanges(parseAddress("fd12:3456::1")!, ranges));
  assert.ok(!inRanges(parseAddress("192.0.2.11")!, ranges));
  const privateRanges = parseRanges("private");
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "100.64.0.9", "::1", "fd00::1", "fe80::1"]) {
    assert.ok(inRanges(parseAddress(address)!, privateRanges), address);
  }
  for (const address of ["203.0.113.5", "8.8.8.8", "2001:db8::1", "100.128.0.1"]) assert.ok(!inRanges(parseAddress(address)!, privateRanges), address);
  assert.deepEqual(parseRanges(""), []);
  assert.deepEqual(parseRanges(undefined), []);
  for (const bad of ["everyone", "10.0.0.0/33", "10.0.0.0/8/1", "[::1]", "fd00::/129"]) {
    assert.throws(() => parseRanges(bad), /USUAL_MAIL_TRUSTED_PROXIES takes addresses and ranges/, bad);
  }
  for (const bad of ["constructor", "__proto__", "cloudflare-ips"]) assert.throws(() => parseRanges(bad), /USUAL_MAIL_TRUSTED_PROXIES takes/, bad);
  assert.throws(() => readConfig([], { USUAL_MAIL_TRUSTED_PROXIES: "proxy.example" }), /USUAL_MAIL_TRUSTED_PROXIES/);
  assert.equal(readConfig([], { USUAL_MAIL_TRUSTED_PROXIES: "private" }).trustedProxies.length, 9);
  assert.deepEqual(readConfig([], {}).trustedProxies, []);
});

test("a /0 range, which is every address, is refused at start, alone or beside others", () => {
  for (const bad of ["0.0.0.0/0", "::/0", "10.0.0.0/0", "2001:db8::/0", "private, ::/0", "0.0.0.0/0,cloudflare"]) {
    assert.throws(() => parseRanges(bad), /a \/0 range is every address/, bad);
    assert.throws(() => readConfig([], { USUAL_MAIL_TRUSTED_PROXIES: bad }), /can't hold ".*\/0"/, bad);
  }
  // The narrowest ranges are still taken.
  assert.equal(parseRanges("0.0.0.0/1, 128.0.0.0/1, ::/1").length, 3);
});

test("cloudflare stands for Cloudflare's published ranges, so the server walks past its edge to the client", () => {
  const cloudflare = parseRanges("cloudflare");
  assert.equal(cloudflare.length, CLOUDFLARE_RANGES.length);
  assert.equal(CLOUDFLARE_RANGES.length, 22, "15 IPv4 and 7 IPv6 ranges, as published on 2026-11-24");
  for (const address of ["173.245.48.1", "104.16.0.1", "104.23.255.255", "104.27.1.1", "162.159.1.2", "172.64.0.1", "131.0.72.9", "2606:4700::6810:1", "2a06:98c0:3600::103", "2c0f:f248::1"]) {
    assert.ok(inRanges(parseAddress(address)!, cloudflare), address);
  }
  for (const address of ["104.28.0.1", "172.72.0.1", "10.0.0.1", "8.8.8.8", "2606:4701::1", "2001:db8::1"]) {
    assert.ok(!inRanges(parseAddress(address)!, cloudflare), address);
  }
  assert.equal(parseRanges("private,CLOUDFLARE").length, 9 + 22);
  assert.equal(readConfig([], { USUAL_MAIL_TRUSTED_PROXIES: "private, cloudflare" }).trustedProxies.length, 31);

  const trusted = parseRanges("private,cloudflare");
  // Render or Cloudflare in front of Caddy: the proxy (private) wrote the edge it was reached from, after the client.
  assert.equal(forwardedClient("10.201.3.4", "198.51.100.7, 162.158.90.1", trusted), "198.51.100.7");
  assert.equal(forwardedClient("172.18.0.3", "203.0.113.9, 2a06:98c0:3600::103", trusted), "203.0.113.9");
  // What a client wrote further left is still ignored; with private alone, the edge itself is the client.
  assert.equal(forwardedClient("10.201.3.4", "192.0.2.1, 198.51.100.7, 162.158.90.1", trusted), "198.51.100.7");
  assert.equal(forwardedClient("10.201.3.4", "198.51.100.7, 162.158.90.1", parseRanges("private")), "162.158.90.1");
  // A Cloudflare address connecting straight to the server isn't a peer anyone named unless cloudflare is set.
  assert.equal(forwardedClient("162.158.90.1", "192.0.2.1", parseRanges("private")), "162.158.90.1");
});

test("X-Forwarded-For is believed only from a trusted proxy, and only what the trusted proxies added", () => {
  const trusted = parseRanges("private");
  // No proxy named: the connection is the client, whatever the header says.
  assert.equal(forwardedClient("203.0.113.5", "198.51.100.1", []), "203.0.113.5");
  assert.equal(forwardedClient("172.18.0.3", "198.51.100.1", []), "172.18.0.3");
  // A connection that isn't a trusted proxy: its own header is ignored.
  assert.equal(forwardedClient("203.0.113.5", "198.51.100.1", trusted), "203.0.113.5");
  // From the proxy: the right-most address it didn't add itself; what the client wrote further left is ignored.
  assert.equal(forwardedClient("172.18.0.3", "198.51.100.1", trusted), "198.51.100.1");
  assert.equal(forwardedClient("::ffff:172.18.0.3", "192.0.2.66, 198.51.100.1", trusted), "198.51.100.1");
  assert.equal(forwardedClient("172.18.0.3", "198.51.100.1, 10.0.0.7", trusted), "198.51.100.1", "a second trusted hop is skipped");
  // Garbage stops the walk at the trusted hop that passed it on, so it can't mint new addresses.
  assert.equal(forwardedClient("172.18.0.3", "garbage-1", trusted), "172.18.0.3");
  assert.equal(forwardedClient("172.18.0.3", "garbage-2, 10.0.0.7", trusted), "10.0.0.7");
  // No header, or every hop trusted: the left-most known.
  assert.equal(forwardedClient("172.18.0.3", undefined, trusted), "172.18.0.3");
  assert.equal(forwardedClient("172.18.0.3", "10.0.0.8, 10.0.0.7", trusted), "10.0.0.8");
  assert.equal(forwardedClient(null, "198.51.100.1", trusted), null);
});

test("Node runs each request with its client known, from the connection or its trusted proxy", async () => {
  const seen: Array<string | null> = [];
  const handler = async () => {
    await Promise.resolve();
    seen.push(requestClient());
    return new Response("ok");
  };
  const env = (address: string) => ({ incoming: { socket: { remoteAddress: address } } }) as never;
  const request = new Request("http://127.0.0.1/", { headers: { "x-forwarded-for": "198.51.100.1" } });
  await withRequestClient([], handler)(request, env("203.0.113.5"));
  await withRequestClient(parseRanges("private"), handler)(request, env("172.18.0.3"));
  await withRequestClient(parseRanges("private"), handler)(request, env("203.0.113.9"));
  assert.deepEqual(seen, ["203.0.113.5", "198.51.100.1", "203.0.113.9"]);
  assert.equal(requestClient(), null, "outside a request there is none");
});
