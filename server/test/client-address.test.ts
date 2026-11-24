// Client addresses (client-address.ts, node/client.ts): the key an address counts under (an IPv6 address by its /64),
// USUAL_MAIL_TRUSTED_PROXIES, and who the client is behind a proxy: X-Forwarded-For believed only from a trusted proxy,
// and then only what the trusted proxies added.

import assert from "node:assert/strict";
import { test } from "node:test";
import { addressKey, forwardedClient, inRanges, parseAddress, parseRanges } from "../src/client-address.ts";
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
  assert.throws(() => readConfig([], { USUAL_MAIL_TRUSTED_PROXIES: "proxy.example" }), /USUAL_MAIL_TRUSTED_PROXIES/);
  assert.equal(readConfig([], { USUAL_MAIL_TRUSTED_PROXIES: "private" }).trustedProxies.length, 9);
  assert.deepEqual(readConfig([], {}).trustedProxies, []);
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
