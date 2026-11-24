// Sender pictures' site icons on Cloudflare (src/cloudflare/web/sources.ts: the shared discovery, src/avatars/site-icons.ts,
// over the Worker's fetcher) in workerd, against fake sites and DNS behind Miniflare's outbound service (web-hosts.ts):
// the cases of Node's avatars-site test (docs/contract-avatars.md, "Where a picture comes from, and how it is fetched"):
// the page (only its first 512 KB), its manifest and its icons, best first, then the conventional addresses; a picture
// the server keeps wins, with its fit; at most 6 requests and the time cap for a domain; every address rule of the
// picture fetcher still applies.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Response as MiniflareResponse } from "miniflare";
import { chunk, dib, icoFile, pngFile } from "../avatar-pictures.ts";
import { startServer, type TestServer } from "./harness.ts";
import { FakeWeb, serve, slow, webOp, type HostHandler } from "./web-hosts.ts";

let server: TestServer;
const web = new FakeWeb().host("inside.example", serve(pngFile(64, 64)), ["10.0.0.1"]);

before(async () => {
  server = await startServer({ web: web.handle });
});
after(async () => {
  await server?.stop();
});

type File = { body: Uint8Array | string; type: string };

/** A site: its page and files by path; anything else 404. */
function site(files: Record<string, File>): HostHandler {
  return (_request, url) => {
    const file = files[url.pathname];
    if (!file) return new MiniflareResponse("Not found", { status: 404 });
    return new MiniflareResponse(typeof file.body === "string" ? file.body : file.body.slice(), { status: 200, headers: { "content-type": file.type } });
  };
}

const html = (head: string): File => ({ body: `<!doctype html><html><head>${head}</head><body>Hi</body></html>`, type: "text/html" });
const png = (size: number): File => ({ body: pngFile(size, size), type: "image/png" });

/** Serves the brand's site at brand.example and www.brand.example, unless only `www` is given. */
function brand(handler: HostHandler, hosts: string[] = ["brand.example", "www.brand.example"]): void {
  for (const host of hosts) web.host(host, handler);
}

const paths = (from: number) => web.requests.slice(from).map((request) => `${request.host}${request.path}`);
const icon = (domain: string, extra: Record<string, unknown> = {}) => webOp(server, { op: "site", domain, ...extra });

describe("a site's own icon", () => {
  test("the best icon its page names: a touch icon fills the circle", async () => {
    brand(site({ "/": html(`<link rel="icon" href="/favicon-32.png" sizes="32x32"><link rel="apple-touch-icon" href="/touch.png" sizes="180x180">`), "/touch.png": png(180), "/favicon-32.png": png(32) }));
    const seen = web.requests.length;
    const found = await icon("brand.example");
    assert.deepEqual({ found: found.found, type: found.mimeType, fit: found.fit }, { found: true, type: "image/png", fit: "fill" });
    assert.deepEqual(paths(seen), ["brand.example/", "brand.example/touch.png"]);
    assert.match(web.requests[seen]!.headers.accept ?? "", /^text\/html/);
  });

  test("a maskable icon from its manifest before anything else", async () => {
    brand(site({
      "/": html(`<link rel="manifest" href="/site.webmanifest"><link rel="apple-touch-icon" href="/touch.png">`),
      "/site.webmanifest": { body: JSON.stringify({ icons: [{ src: "/any-192.png", sizes: "192x192" }, { src: "/mask-512.png", sizes: "512x512", purpose: "maskable" }] }), type: "application/manifest+json" },
      "/mask-512.png": png(512),
    }));
    const seen = web.requests.length;
    const found = await icon("brand.example");
    assert.deepEqual({ found: found.found, fit: found.fit }, { found: true, fit: "fill" });
    assert.deepEqual(paths(seen), ["brand.example/", "brand.example/site.webmanifest", "brand.example/mask-512.png"]);
  });

  test("a favicon.ico, as the PNG the server writes, sitting inside the circle", async () => {
    const ico = icoFile([{ data: dib({ width: 32, height: 32, bpp: 32, pixel: () => [200, 0, 0, 255] }), width: 32, height: 32 }]);
    brand(site({ "/": html(""), "/favicon.ico": { body: ico, type: "image/x-icon" } }));
    const seen = web.requests.length;
    const found = await icon("brand.example");
    assert.deepEqual({ found: found.found, type: found.mimeType, fit: found.fit }, { found: true, type: "image/png", fit: "inset" });
    assert.deepEqual(paths(seen), ["brand.example/", "brand.example/apple-touch-icon.png", "brand.example/favicon.ico"]);
  });

  test("an inline picture in the page, without another request", async () => {
    const inline = `data:image/png;base64,${Buffer.from(pngFile(48, 48)).toString("base64")}`;
    brand(site({ "/": html(`<link rel="icon" href="${inline}" sizes="48x48">`) }));
    const seen = web.requests.length;
    assert.equal((await icon("brand.example")).found, true);
    assert.deepEqual(paths(seen), ["brand.example/"]);
  });

  test("the www site when the bare domain has no address", async () => {
    brand(site({ "/": html(`<link rel="apple-touch-icon" href="/touch.png">`), "/touch.png": png(180) }), ["www.only.example"]);
    const questions = web.questions.length;
    assert.equal((await icon("only.example")).found, true);
    assert.deepEqual([...new Set(web.questions.slice(questions).map((q) => q.name))].slice(0, 2), ["only.example", "www.only.example"]);
  });
});

describe("what isn't taken", () => {
  test("SVG, a moving PNG, or a picture too small: the next candidate is tried", async () => {
    brand(site({
      "/": html(`<link rel="icon" href="/logo.svg"><link rel="icon" href="/moving.png" sizes="192x192"><link rel="icon" href="/tiny.png" sizes="128x128"><link rel="icon" href="/ok.png" sizes="96x96">`),
      "/logo.svg": { body: "<svg xmlns='http://www.w3.org/2000/svg'/>", type: "image/svg+xml" },
      "/moving.png": { body: pngFile(192, 192, { before: [chunk("acTL", new Uint8Array(8))] }), type: "image/png" },
      "/tiny.png": png(8),
      "/ok.png": png(96),
    }));
    const seen = web.requests.length;
    assert.equal((await icon("brand.example")).found, true);
    assert.deepEqual(paths(seen), ["brand.example/", "brand.example/moving.png", "brand.example/tiny.png", "brand.example/ok.png"], "the SVG isn't even asked for");
  });

  test("an icon the page names at a private name or address is never asked; nothing else found is 'none'", async () => {
    brand(site({ "/": html(`<link rel="apple-touch-icon" href="https://inside.example/touch.png"><link rel="icon" href="http://127.0.0.2/a.png"><link rel="icon" href="http://169.254.169.254/a.png">`) }));
    const found = await icon("brand.example");
    assert.equal(web.seen("inside.example").length, 0, "the private host saw nothing");
    assert.deepEqual({ found: found.found, kind: found.kind, reason: found.reason }, { found: false, kind: "none", reason: "its site answered 404" });
  });

  test("at most 6 requests for one domain, however many icons the page names", async () => {
    brand(site({ "/": html(Array.from({ length: 20 }, (_, i) => `<link rel="icon" href="/i${i}.png">`).join("")) }));
    const seen = web.requests.length;
    assert.equal((await icon("brand.example")).found, false);
    assert.equal(web.requests.length - seen, 6);
  });

  test("a site that can't be reached at all is 'failed', to be tried again later; one that answers nothing but 404s is 'none'", async () => {
    const unreachable = await icon("unknown.example");
    assert.deepEqual({ found: unreachable.found, kind: unreachable.kind }, { found: false, kind: "failed" });
    brand(() => new MiniflareResponse("Not found", { status: 404 }), ["missing.example", "www.missing.example"]);
    const missing = await icon("missing.example");
    assert.deepEqual({ found: missing.found, kind: missing.kind }, { found: false, kind: "none" });
  });

  test("a slow site is given up within the domain's time", async () => {
    brand(slow(8_000, site({ "/": html("") })), ["slow.example", "www.slow.example"]);
    const started = Date.now();
    const found = await icon("slow.example", { limits: { totalMs: 600 } });
    assert.ok(Date.now() - started < 3_000, `${Date.now() - started} ms`);
    assert.deepEqual({ found: found.found, kind: found.kind }, { found: false, kind: "failed" }, "it may answer later");
  });

  test("only the first part of a huge page is read", async () => {
    const filler = "<meta name=x content=y>".repeat(30_000);
    brand(site({ "/": html(`${filler}<link rel="apple-touch-icon" href="/touch.png">`), "/touch.png": png(180) }));
    const seen = web.requests.length;
    const found = await icon("brand.example");
    assert.ok(!paths(seen).includes("brand.example/touch.png"), "a link past the cut isn't seen");
    assert.equal(found.found, false);
  });
});
