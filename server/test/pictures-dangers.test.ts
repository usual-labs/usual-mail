// The dangers of a server that fetches addresses taken from mail, each against the PRODUCTION address rule
// (`isPublicAddress`, the fetcher's default): the fake host a danger would reach must receive nothing, not even a
// connection. Where a test needs one hop that works first (a redirect), that hop is a host on ::1 that the rule
// admits by name in that test alone; whatever the danger then reaches is judged by the production rule. Nothing
// reaches the real network: names come from a fake resolver, and every address refused is refused before connecting.

import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { after, before, describe, test } from "node:test";
import { isPublicAddress } from "../src/node/pictures/address.ts";
import { dnsResolver, fetchPictureBytes, type FetchOptions } from "../src/node/pictures/fetch.ts";
import { PictureRefused } from "../src/pictures/refused.ts";
import { fakeHost, fakeResolver, png, serve, v4, v6, type FakeHost } from "./picture-hosts.ts";

let evil: FakeHost;

before(async () => {
  // The host a danger would reach: anything it serves would be accepted, so only the rules keep it out.
  evil = await fakeHost(serve(png(10, 10)));
});
after(() => evil.close());

/** The production address rule, with the fake host's port allowed so the address rule alone decides. */
function production(extra: Omit<FetchOptions, "allowAddress"> = {}): FetchOptions {
  return { allowPort: (port) => port === evil.port, ...extra };
}

async function refused(url: string, options: FetchOptions, words?: RegExp): Promise<void> {
  const before = { requests: evil.requests.length, connections: evil.connections };
  await assert.rejects(fetchPictureBytes(url, options), (error: unknown) => {
    assert.ok(error instanceof PictureRefused, `${url}: ${String(error)}`);
    if (words) assert.match(error.message, words);
    return true;
  });
  assert.equal(evil.requests.length, before.requests, `${url} reached the fake host`);
  assert.equal(evil.connections, before.connections, `${url} connected to the fake host`);
}

describe("addresses the server never fetches from", () => {
  test("loopback written every way a URL parser accepts", async () => {
    for (const host of ["127.0.0.1", "2130706433", "0x7f.1", "0177.0.0.1", "127.1", "0.0.0.0", "[::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[64:ff9b::7f00:1]", "[::127.0.0.1]"]) {
      await refused(`http://${host}:${evil.port}/a.png`, production(), /private/);
    }
  });

  test("localhost, as a hosts file or a DNS server would answer it", async () => {
    const { resolve } = fakeResolver({ localhost: [v4("127.0.0.1"), v6("::1")] });
    await refused(`http://localhost:${evil.port}/a.png`, production({ resolve }), /private/);
  });

  test("the IETF's own ranges: Teredo, benchmarking and protocol assignments", async () => {
    for (const address of ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:2::1", "2001:10::1"]) {
      await refused(`http://[${address}]:${evil.port}/a.png`, production(), /private/);
    }
    for (const address of ["192.0.0.8", "192.0.0.170", "198.19.255.1"]) {
      await refused(`http://${address}:${evil.port}/a.png`, production(), /private/);
    }
  });

  test("private, shared, link-local and cloud metadata addresses, as literals and behind names", async () => {
    const targets = [
      v4("10.0.0.5"), v4("172.16.4.4"), v4("192.168.1.1"), v4("169.254.169.254"), v4("100.100.100.200"),
      v4("100.64.0.1"), v4("198.18.0.1"), v4("224.0.0.1"), v4("255.255.255.255"),
      v6("fd00:ec2::254"), v6("fe80::1"), v6("fc00::1"), v6("::"), v6("2001:db8::1"), v6("2002:7f00:1::1"),
    ];
    for (const target of targets) {
      const literal = target.family === 6 ? `[${target.address}]` : target.address;
      await refused(`http://${literal}:${evil.port}/a.png`, production(), /private/);
      const { resolve } = fakeResolver({ "inside.example": [target] });
      await refused(`http://inside.example:${evil.port}/a.png`, production({ resolve }), /private/);
    }
  });

  test("a name with one private address among public ones", async () => {
    const { resolve } = fakeResolver({ "mixed.example": [v4("8.8.8.8"), v4("127.0.0.1")] });
    await refused(`http://mixed.example:${evil.port}/a.png`, production({ resolve }), /private/);
    const { resolve: sixFirst } = fakeResolver({ "mixed.example": [v6("2606:4700::1111"), v6("::1")] });
    await refused(`http://mixed.example:${evil.port}/a.png`, production({ resolve: sixFirst }), /private/);
  });

  test("a name that doesn't resolve", async () => {
    const { resolve } = fakeResolver({});
    await refused(`http://nowhere.example:${evil.port}/a.png`, production({ resolve }), /resolve/);
  });

  test("other ports, other schemes and addresses with a user name", async () => {
    // The production port rule: only 80 for http and 443 for https.
    const { resolve } = fakeResolver({ "pictures.example": [v4("127.0.0.1")] });
    await refused(`http://pictures.example:${evil.port}/a.png`, { resolve, allowAddress: (a) => a === "127.0.0.1" }, /port/);
    await refused(`https://pictures.example:80/a.png`, { resolve, allowAddress: (a) => a === "127.0.0.1" }, /port/);
    for (const url of ["file:///etc/passwd", "ftp://pictures.example/a.png", "gopher://pictures.example/", "data:image/png;base64,AA==", `http://u:p@127.0.0.1:${evil.port}/`]) {
      await refused(url, production());
    }
  });
});

describe("the server's own networks", () => {
  const entry = (cidr: string, family: "IPv4" | "IPv6"): NetworkInterfaceInfo => ({
    address: cidr.split("/")[0]!, cidr, family, netmask: "", mac: "00:00:00:00:00:00", internal: false, scopeid: 0,
  } as NetworkInterfaceInfo);
  const home = { en0: [entry("2a01:4f8:c0c:1234::5/64", "IPv6"), entry("93.184.215.14/24", "IPv4")] };

  test("an address inside a network of one of the server's interfaces, public or not, is never fetched from", () => {
    for (const address of ["2a01:4f8:c0c:1234::5", "2a01:4f8:c0c:1234::99", "93.184.215.14", "93.184.215.200"]) {
      assert.equal(isPublicAddress(address, home), false, address);
    }
    for (const address of ["2a01:4f8:c0c:1235::1", "93.184.216.1"]) assert.equal(isPublicAddress(address, home), true, address);
  });

  test("a global IPv6 address's whole /64 is the server's own, whatever its prefix says (DHCPv6 gives /128)", () => {
    const dhcp = { en0: [entry("2a02:1234:5678:9a00::abcd/128", "IPv6")] };
    assert.equal(isPublicAddress("2a02:1234:5678:9a00::1", dhcp), false);
    assert.equal(isPublicAddress("2a02:1234:5678:9a01::1", dhcp), true);
  });

  test("an interface without a prefix still counts, with its address's /24 or /64", () => {
    const bare = { en0: [{ ...entry("2a02:1234:5678:9a00::abcd/64", "IPv6"), cidr: null }, { ...entry("198.51.99.10/24", "IPv4"), cidr: null }] } as unknown as typeof home;
    for (const address of ["2a02:1234:5678:9a00::abcd", "2a02:1234:5678:9a00::1", "198.51.99.10", "198.51.99.200"]) {
      assert.equal(isPublicAddress(address, bare), false, address);
    }
    assert.equal(isPublicAddress("198.51.100.200", bare), false, "documentation range anyway");
    assert.equal(isPublicAddress("93.184.216.1", bare), true);
  });

  test("a prefix too short to be a network (a VPN's /0) doesn't make the whole internet the server's own", () => {
    // IPv4: /16 is the shortest taken whole; shorter falls back to the address's /24. IPv6: /32, else its /64.
    const v4 = (prefix: number) => ({ tun0: [entry(`93.184.215.14/${prefix}`, "IPv4")] });
    assert.equal(isPublicAddress("93.184.1.1", v4(16)), false, "a /16 is taken whole");
    assert.equal(isPublicAddress("93.185.1.1", v4(15)), true, "a /15 is too short");
    assert.equal(isPublicAddress("93.184.215.99", v4(15)), false, "its /24 still counts");
    assert.equal(isPublicAddress("8.8.8.8", v4(0)), true);
    const v6 = (prefix: number) => ({ tun0: [entry(`2a01:4f8:c0c:1234::5/${prefix}`, "IPv6")] });
    assert.equal(isPublicAddress("2a01:4f8:ffff::1", v6(32)), false, "a /32 is taken whole");
    assert.equal(isPublicAddress("2a01:4f9::1", v6(31)), true, "a /31 is too short");
    assert.equal(isPublicAddress("2a01:4f8:c0c:1234::99", v6(31)), false, "its /64 still counts");
    assert.equal(isPublicAddress("2606:4700::1111", v6(0)), true);
  });

  test("an IPv4 address of the server's own network is refused in IPv6 forms too", () => {
    for (const address of ["::ffff:93.184.215.200", "64:ff9b::5db8:d7c8"]) assert.equal(isPublicAddress(address, home), false, address);
  });

  test("an internal interface isn't the server's network, whatever its address", () => {
    const internal = { lo1: [{ ...entry("93.184.215.14/24", "IPv4"), internal: true }] };
    assert.equal(isPublicAddress("93.184.215.99", internal), true);
  });

  test("loopback and link-local interfaces don't widen into the rest of the internet", () => {
    // ::1/128 taken as ::/64 would hold every IPv4 address in its IPv4-mapped form.
    const loop = { lo0: [entry("::1/128", "IPv6"), { ...entry("127.0.0.1/8", "IPv4"), internal: true }, entry("fe80::1/64", "IPv6")] };
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) assert.equal(isPublicAddress(address, loop), true, address);
  });

  test("public addresses stay public on this machine", () => {
    for (const address of ["8.8.8.8", "1.1.1.1"]) assert.equal(isPublicAddress(address), true, address);
  });

  test("none of this machine's own addresses", () => {
    for (const entries of Object.values(networkInterfaces())) {
      for (const own of entries ?? []) assert.equal(isPublicAddress(own.address), false, "one of this machine's addresses");
    }
  });
});

describe("names", () => {
  test("resolving a name counts against the time limit", async () => {
    const started = Date.now();
    const hung = fetchPictureBytes("http://slow-dns.example/a.png", { resolve: () => new Promise(() => undefined), totalTimeoutMs: 300 });
    const outcome = await Promise.race([
      hung.then(() => "fetched", (error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 3_000)),
    ]);
    assert.match(outcome, /took too long/);
    assert.ok(Date.now() - started < 2_000);
  });

  test("both A and AAAA are asked, and the lookup is called off the moment the deadline passes", async () => {
    const silent = createSocket("udp4");
    const types: number[] = [];
    silent.on("message", (query) => void types.push(query.readUInt16BE(query.length - 4)));
    await new Promise<void>((resolve) => silent.bind(0, "127.0.0.1", resolve));
    try {
      const resolve = dnsResolver({ servers: [`127.0.0.1:${silent.address().port}`], timeoutMs: 600, tries: 4 });
      await assert.rejects(fetchPictureBytes("http://slow-dns.example/a.png", { resolve, totalTimeoutMs: 200 }), /took too long/);
      assert.deepEqual([...new Set(types)].sort(), [1, 28], "A and AAAA");
      const asked = types.length;
      await new Promise((r) => setTimeout(r, 1_500));
      assert.equal(types.length, asked, "no query is tried again after the deadline");
    } finally {
      silent.close();
    }
  });

  test("names are asked of DNS servers with a time limit, never of the hosts file", async () => {
    // A DNS server on this machine that never answers: the resolver must ask it, and give up in time.
    const silent = createSocket("udp4");
    let queries = 0;
    silent.on("message", () => void queries++);
    await new Promise<void>((resolve) => silent.bind(0, "127.0.0.1", resolve));
    try {
      const resolve = dnsResolver({ servers: [`127.0.0.1:${silent.address().port}`], timeoutMs: 100, tries: 1 });
      const started = Date.now();
      await assert.rejects(resolve("localhost", AbortSignal.timeout(5_000)));
      assert.ok(queries > 0, "the DNS server was asked, even for localhost");
      assert.ok(Date.now() - started < 2_000);
    } finally {
      silent.close();
    }
  });
});

describe("rebinding and redirects", () => {
  let first: FakeHost | null = null;
  const redirects: string[] = [];

  before(async () => {
    try {
      first = await fakeHost((request, response) => {
        const n = Number(new URL(request.url ?? "/", "http://x").searchParams.get("n") ?? "0");
        const location = redirects[n];
        if (location) response.writeHead(302, { location }).end();
        else serve(png(10, 10))(request, response, first!);
      }, { address: "::1" });
    } catch {
      first = null; // no IPv6 loopback here
    }
  });
  after(() => first?.close());

  /** The production rule plus the one first hop on ::1, for this test only. */
  function withFirstHop(resolveNames: Record<string, Array<{ address: string; family: number }>> = {}): FetchOptions & { asked: string[] } {
    const { asked, resolve } = fakeResolver({ "first.example": [v6("::1")], ...resolveNames });
    return { asked, resolve, allowAddress: (a) => a === "::1" || isPublicAddress(a), allowPort: (port) => port === first!.port || port === evil.port };
  }

  test("a name is resolved once per hop and the connection goes to the address checked", async (t) => {
    if (!first) return t.skip("no IPv6 loopback");
    // The evil host listens on 127.0.0.1 at the first host's port, ready for a second, rebound answer.
    let rebound: FakeHost;
    try {
      rebound = await fakeHost(serve(png(10, 10)), { port: first.port });
    } catch {
      return t.skip("the port is taken on 127.0.0.1");
    }
    try {
      let calls = 0;
      const { asked, resolve } = fakeResolver({ "rebind.example": () => (++calls === 1 ? [v6("::1")] : [v4("127.0.0.1")]) });
      const bytes = await fetchPictureBytes(`http://rebind.example:${first.port}/a.png`, {
        resolve,
        allowAddress: (a) => a === "::1" || isPublicAddress(a),
        allowPort: (port) => port === first!.port,
      });
      assert.equal(bytes.length, png(10, 10).length);
      assert.deepEqual(asked, ["rebind.example"]);
      assert.equal(rebound.connections, 0);
    } finally {
      await rebound.close();
    }
  });

  test("every redirect is checked again: loopback, localhost, private names, other schemes and ports", async (t) => {
    if (!first) return t.skip("no IPv6 loopback");
    const targets = [
      `http://127.0.0.1:${evil.port}/a.png`,
      `http://localhost:${evil.port}/a.png`,
      `http://inside.example:${evil.port}/a.png`,
      `http://[::ffff:127.0.0.1]:${evil.port}/a.png`,
      "file:///etc/passwd",
      "data:image/png;base64,AA==",
      `http://first.example:8080/a.png`,
    ];
    for (const target of targets) {
      redirects.length = 0;
      redirects.push(target);
      const options = withFirstHop({ "inside.example": [v4("10.0.0.5")], localhost: [v4("127.0.0.1")] });
      const seen: number = first.requests.length;
      await refused(`http://first.example:${first.port}/?n=0`, options);
      assert.equal(first.requests.length, seen + 1, "only the first hop was asked");
    }
  });

  test("at most three redirects", async (t) => {
    if (!first) return t.skip("no IPv6 loopback");
    redirects.length = 0;
    for (let n = 1; n <= 4; n++) redirects.push(`http://first.example:${first.port}/?n=${n}`);
    const seen: number = first.requests.length;
    await assert.rejects(fetchPictureBytes(`http://first.example:${first.port}/?n=0`, withFirstHop()), /more than 3 times/);
    assert.equal(first.requests.length, seen + 4);
    // Three are followed.
    redirects.length = 3;
    const bytes = await fetchPictureBytes(`http://first.example:${first.port}/?n=0`, withFirstHop());
    assert.equal(bytes.length, png(10, 10).length);
  });
});
