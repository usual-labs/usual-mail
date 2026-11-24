// The Worker's fetcher of pictures and sites' pages (src/cloudflare/web/fetch.ts, addresses.ts, dns.ts) in workerd,
// against fake hosts and a fake DNS-over-HTTPS resolver behind Miniflare's outbound service (web-hosts.ts): the cases of
// Node's dangers suite that still apply on Cloudflare (docs/contract-pictures.md, "What is fetched, and how"). A Worker
// can't pin its connection to the address it checked, has no network of its own to protect and can't fetch a bare IP
// address at all; everything else holds: http or https on 80 and 443 only, no user name, public addresses only (every
// address a name has, asked for A and AAAA), never the server's own host names, every redirect checked again and at most
// three, the same headers, gzip or br decoded within the limit, at most 10 MB and 15 seconds with the lookup included,
// five seconds to an answer.

import assert from "node:assert/strict";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import { Response as MiniflareResponse } from "miniflare";
import { PICTURE_ACCEPT, PICTURE_USER_AGENT } from "../../src/pictures/rules.ts";
import { png } from "../picture-hosts.ts";
import { startServer, type TestServer } from "./harness.ts";
import { FakeWeb, redirect, serve, slow, trickle, webOp, type HostHandler } from "./web-hosts.ts";

const PICTURE = png(10, 10);

let server: TestServer;
const web = new FakeWeb()
  .host("pictures.example", serve(PICTURE))
  .host("inside.example", serve(PICTURE), ["10.0.0.1"])
  .host("loop.example", serve(PICTURE), ["127.0.0.1"])
  .host("metadata.example", serve(PICTURE), ["169.254.169.254"])
  .host("private6.example", serve(PICTURE), ["fd00::1"])
  .host("mapped.example", serve(PICTURE), ["93.184.215.14", "::ffff:10.0.0.1"])
  .host("nat64.example", serve(PICTURE), ["64:ff9b::a9fe:a9fe"])
  .host("mixed.example", serve(PICTURE), ["93.184.215.14", "10.0.0.2"])
  .host("localhost", serve(PICTURE), ["127.0.0.1", "::1"]);

before(async () => {
  server = await startServer({ web: web.handle });
});
after(async () => {
  await server?.stop();
});

const fetchOf = (url: string, options: Record<string, unknown> = {}) => webOp(server, { op: "fetch", url, options });

/** Asserts each address is refused with these words and kind, and that no host and no resolver was asked. */
async function refusedUnasked(urls: string[], words: RegExp, kind: "refused" | "failed") {
  const requests = web.requests.length;
  const questions = web.questions.length;
  for (const url of urls) {
    const answer = await fetchOf(url);
    assert.equal(answer.ok, false, `${url} was fetched`);
    assert.match(answer.message ?? "", words, url);
    assert.equal(answer.kind, kind, url);
  }
  assert.equal(web.requests.length, requests, "no host was asked");
  return { questions: web.questions.length - questions };
}

describe("a picture that may be fetched", () => {
  test("its name asked for A and AAAA over DNS-over-HTTPS, then fetched with a common user agent, gzip or br, no cookie, referrer or language", async () => {
    const answer = await fetchOf("https://pictures.example/a.png");
    assert.deepEqual({ ok: answer.ok, size: answer.size, url: answer.url }, { ok: true, size: PICTURE.length, url: "https://pictures.example/a.png" });
    const asked = web.questions.filter((q) => q.name === "pictures.example").map((q) => q.type).sort();
    assert.deepEqual(asked, ["A", "AAAA"]);
    const [request] = web.seen("pictures.example");
    assert.equal(request!.path, "/a.png");
    assert.equal(request!.headers["user-agent"], PICTURE_USER_AGENT);
    assert.equal(request!.headers.accept, PICTURE_ACCEPT);
    assert.equal(request!.headers["accept-encoding"], "gzip, br");
    for (const header of ["cookie", "referer", "accept-language", "authorization"]) assert.equal(request!.headers[header], undefined, header);
  });

  test("a redirect to another public site is followed, and the address the bytes came from is given", async () => {
    web.host("moved.example", redirect("https://pictures.example/b.png", 301));
    const answer = await fetchOf("https://moved.example/a.png");
    assert.deepEqual({ ok: answer.ok, url: answer.url }, { ok: true, url: "https://pictures.example/b.png" });
  });
});

describe("addresses never fetched from", () => {
  test("special-range IP addresses, written every way a URL parser accepts: refused for good, nothing asked", async () => {
    const { questions } = await refusedUnasked([
      "http://127.0.0.1/a.png", "http://0x7f.1/a.png", "http://2130706433/a.png", "http://127.1/a.png", "http://[::1]/a.png",
      "http://[::ffff:127.0.0.1]/a.png", "http://[::ffff:7f00:1]/a.png", "http://0.0.0.0/a.png", "http://[::]/a.png",
      "http://10.0.0.1/a.png", "http://172.16.5.4/a.png", "http://192.168.1.1/a.png", "http://100.100.100.200/a.png",
      "http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/a.png", "http://[fd00::1]/a.png", "http://[2001:db8::1]/a.png",
      "http://[2001::1]/a.png", "http://198.18.0.1/a.png", "http://[64:ff9b::a9fe:a9fe]/a.png", "http://[2002:7f00:1::]/a.png",
      "http://224.0.0.1/a.png", "http://255.255.255.255/a.png",
    ], /its address is a private one/, "refused");
    assert.equal(questions, 0, "no name was asked");
  });

  test("the server's own host names, however written: a failure that may pass, nothing asked", async () => {
    web.host("server.example", serve(PICTURE));
    const requests = web.requests.length;
    const questions = web.questions.length;
    for (const url of ["https://server.example/a.png", "https://SERVER.example/a.png", "https://server.example./a.png", "http://server.example/v1/info"]) {
      const answer = await webOp(server, { op: "fetch", url, ownHosts: ["server.example"] });
      assert.deepEqual({ ok: answer.ok, message: answer.message, kind: answer.kind }, { ok: false, message: "its address is this server's own", kind: "failed" }, url);
    }
    assert.equal(web.requests.length, requests, "the server's host was never asked");
    assert.equal(web.questions.length, questions, "nor its name looked up");
    assert.equal((await fetchOf("https://server.example/a.png")).ok, true, "for another server it is a site like any");
  });

  test("a public IP address too: a Worker can't fetch a bare address", async () => {
    await refusedUnasked(["http://93.184.215.14/a.png", "https://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/a.png"], /bare IP address/, "refused");
  });

  test("names that answer with a private address, or one among public ones: a failure that may pass, the site never asked", async () => {
    await refusedUnasked(
      ["https://inside.example/a.png", "https://loop.example/a.png", "https://metadata.example/a.png", "https://private6.example/a.png",
        "https://mapped.example/a.png", "https://nat64.example/a.png", "https://mixed.example/a.png", "http://localhost/a.png"],
      /points at a private address/,
      "failed",
    );
  });

  test("a name that doesn't resolve, and a resolver that fails: a failure that may pass", async () => {
    await refusedUnasked(["https://nowhere.example/a.png"], /doesn't resolve/, "failed");
    web.resolver = () => new MiniflareResponse("broken", { status: 500 });
    try {
      await refusedUnasked(["https://pictures.example/c.png"], /doesn't resolve/, "failed");
    } finally {
      web.resolver = null;
    }
  });

  test("other ports, other schemes and addresses with a user name: refused for good, nothing asked", async () => {
    const { questions } = await refusedUnasked(
      ["https://pictures.example:8443/a.png", "http://pictures.example:443/a.png", "https://pictures.example:80/a.png", "http://pictures.example:22/a.png"],
      /port/,
      "refused",
    );
    assert.equal(questions, 0);
    await refusedUnasked(["ftp://pictures.example/a.png", "file:///etc/passwd", "javascript:alert(1)", "gopher://pictures.example/"], /aren't fetched over/, "refused");
    await refusedUnasked(["https://user:secret@pictures.example/a.png", "https://user@pictures.example/a.png"], /user name/, "refused");
    await refusedUnasked(["not an address"], /isn't one/, "refused");
  });
});

describe("redirects", () => {
  const hops: HostHandler = (request, url) => {
    const to: Record<string, string> = {
      "/to-inside": "https://inside.example/x.png",
      "/to-loopback": "http://127.0.0.1/x.png",
      "/to-metadata": "http://169.254.169.254/latest/meta-data/",
      "/to-ftp": "ftp://pictures.example/x.png",
      "/to-port": "https://pictures.example:8443/x.png",
      "/to-user": "https://user@pictures.example/x.png",
    };
    const chain = /^\/chain\/(\d+)$/.exec(url.pathname);
    if (chain) return redirect(`/chain/${Number(chain[1]) + 1}`)(request, url);
    if (url.pathname === "/nowhere") return new MiniflareResponse(null, { status: 302 });
    return redirect(to[url.pathname] ?? "/missing")(request, url);
  };
  before(() => void web.host("hops.example", hops));

  test("every redirect is checked again before it is followed: private names, IP addresses, other schemes, ports and user names", async () => {
    const inside = web.seen("inside.example").length;
    const cases: Array<[string, RegExp, "refused" | "failed"]> = [
      ["/to-inside", /points at a private address/, "failed"],
      ["/to-loopback", /private one/, "refused"],
      ["/to-metadata", /private one/, "refused"],
      ["/to-ftp", /aren't fetched over/, "refused"],
      ["/to-port", /port 8443/, "refused"],
      ["/to-user", /user name/, "refused"],
    ];
    for (const [path, words, kind] of cases) {
      const answer = await fetchOf(`https://hops.example${path}`);
      assert.equal(answer.ok, false, path);
      assert.match(answer.message ?? "", words, path);
      assert.equal(answer.kind, kind, path);
    }
    assert.equal(web.seen("inside.example").length, inside, "the private site was never asked");
  });

  test("at most three, and one that doesn't say where is a failure", async () => {
    const seen = web.seen("hops.example").length;
    const answer = await fetchOf("https://hops.example/chain/0");
    assert.match(answer.message ?? "", /redirected more than 3 times/);
    assert.equal(answer.kind, "refused");
    assert.deepEqual(web.seen("hops.example").slice(seen).map((r) => r.path), ["/chain/0", "/chain/1", "/chain/2", "/chain/3"]);
    const nowhere = await fetchOf("https://hops.example/nowhere");
    assert.match(nowhere.message ?? "", /without saying where/);
    assert.equal(nowhere.kind, "failed");
  });
});

describe("answers that are refused", () => {
  const stream = (chunks: number, size: number): HostHandler => () => new MiniflareResponse(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < chunks; i++) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "image/png" } });
  before(() => {
    web.host("missing.example", () => new MiniflareResponse("Not here", { status: 404 }));
    web.host("gzip.example", serve(gzipSync(PICTURE), "image/png", { "content-encoding": "gzip" }));
    web.host("br.example", serve(brotliCompressSync(PICTURE), "image/png", { "content-encoding": "br" }));
    web.host("deflate.example", serve(new Uint8Array(64), "image/png", { "content-encoding": "deflate" }));
    web.host("zstd.example", serve(new Uint8Array(64), "image/png", { "content-encoding": "zstd" }));
    // Small compressed, 50 MB once decoded.
    web.host("bomb.example", serve(gzipSync(new Uint8Array(50 * 1024 * 1024)), "image/png", { "content-encoding": "gzip" }));
    web.host("brbomb.example", serve(brotliCompressSync(new Uint8Array(50 * 1024 * 1024)), "image/png", { "content-encoding": "br" }));
    web.host("huge.example", serve(new Uint8Array(11 * 1024 * 1024)));
    web.host("grows.example", stream(4, 600));
  });

  test("a status other than 200: a failure that may pass, in its words", async () => {
    const answer = await fetchOf("https://missing.example/a.png");
    assert.deepEqual({ ok: answer.ok, message: answer.message, kind: answer.kind }, { ok: false, message: "its site answered 404", kind: "failed" });
  });

  test("gzip and br are read decoded; any other encoding is refused", async () => {
    for (const host of ["gzip", "br"]) {
      const answer = await fetchOf(`https://${host}.example/a.png`);
      assert.deepEqual({ ok: answer.ok, size: answer.size }, { ok: true, size: PICTURE.length }, `${host}: its decoded bytes`);
    }
    for (const host of ["deflate", "zstd"]) {
      const answer = await fetchOf(`https://${host}.example/a.png`);
      assert.match(answer.message ?? "", /compressed in a way the server doesn't read/, host);
      assert.equal(answer.kind, "refused");
    }
  });

  test("a decompression bomb stops at the limit, counted on its decoded bytes", async () => {
    for (const host of ["bomb", "brbomb"]) {
      const started = Date.now();
      const answer = await fetchOf(`https://${host}.example/a.png`);
      assert.match(answer.message ?? "", /larger than 10 MB/, host);
      assert.equal(answer.kind, "refused");
      assert.ok(Date.now() - started < 5_000, `${host}: ${Date.now() - started} ms`);
    }
  });

  test("a declared length over 10 MB, before reading it; a body that grows past the cap without saying so", async () => {
    const huge = await fetchOf("https://huge.example/a.png");
    assert.match(huge.message ?? "", /larger than 10 MB/);
    assert.equal(huge.kind, "refused");
    const grows = await fetchOf("https://grows.example/a.png", { maxBytes: 1_000 });
    assert.match(grows.message ?? "", /larger than/);
    assert.equal(grows.kind, "refused");
    assert.equal((await fetchOf("https://grows.example/a.png", { maxBytes: 2_400 })).size, 2_400, "the same body under the cap is read whole");
  });

  test("a page cut: its first bytes, however long it is, and a declared length beyond the cut is no reason to refuse", async () => {
    web.host("page.example", serve(`<html><head>${"<meta name=x>".repeat(50_000)}</head></html>`, "text/html"));
    const answer = await fetchOf("https://page.example/", { cutAt: 1_000, accept: "text/html" });
    assert.deepEqual({ ok: answer.ok, size: answer.size }, { ok: true, size: 1_000 });
    assert.match(answer.text ?? "", /^<html><head><meta name=x>/);
    assert.equal(web.seen("page.example").at(-1)!.headers.accept, "text/html");
  });
});

describe("time", () => {
  before(() => {
    web.host("silent.example", slow(8_000, serve(PICTURE)));
    web.host("trickle.example", trickle(8_000));
  });

  test("a site that doesn't answer in time", async () => {
    const started = Date.now();
    const answer = await fetchOf("https://silent.example/a.png", { connectTimeoutMs: 400 });
    assert.match(answer.message ?? "", /didn't answer in time/);
    assert.equal(answer.kind, "failed");
    assert.ok(Date.now() - started < 3_000, `${Date.now() - started} ms`);
  });

  test("a site that answers and then trickles is cut off at the total time", async () => {
    const started = Date.now();
    const answer = await fetchOf("https://trickle.example/a.png", { totalTimeoutMs: 800 });
    assert.match(answer.message ?? "", /took too long/);
    assert.ok(Date.now() - started < 3_000, `${Date.now() - started} ms`);
  });

  test("resolving the name counts against the total time; the site is never asked", async () => {
    web.resolver = () => null; // never answers in time
    const started = Date.now();
    try {
      const answer = await fetchOf("https://pictures.example/late.png", { totalTimeoutMs: 600 });
      assert.match(answer.message ?? "", /took too long/);
      assert.equal(answer.kind, "failed");
      assert.ok(Date.now() - started < 3_000, `${Date.now() - started} ms`);
      assert.ok(!web.seen("pictures.example").some((r) => r.path === "/late.png"));
    } finally {
      web.resolver = null;
    }
  });
});
