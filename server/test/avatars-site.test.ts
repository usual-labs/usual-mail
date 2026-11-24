// Fetching a site's own icon for sender pictures, against fake sites on 127.0.0.1 named by a fake resolver: the page
// (cut), its manifest and its icons, best first, then the conventional addresses; a picture the server keeps wins,
// with its fit; at most 6 requests and the time cap for a domain; every address rule of the picture fetcher still
// applies (a private address named by the page is never asked). Nothing reaches the real network.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { NodeSiteIcons, type SiteIconOptions } from "../src/node/avatars/site.ts";
import { dib, icoFile, pngFile, chunk } from "./avatar-pictures.ts";
import { fakeHost, fakeResolver, serve, v4, type FakeHost, type Handler } from "./picture-hosts.ts";

let handler: Handler = (_request, response) => response.writeHead(404).end();
let host: FakeHost;
let inside: FakeHost;

before(async () => {
  host = await fakeHost((request, response, self) => handler(request, response, self));
  inside = await fakeHost(serve(pngFile(64, 64)));
});
after(async () => {
  await host.close();
  await inside.close();
});

function icons(names: Record<string, string> = { "brand.example": "127.0.0.1", "www.brand.example": "127.0.0.1" }, extra: Partial<SiteIconOptions> = {}) {
  const { asked, resolve } = fakeResolver({ ...Object.fromEntries(Object.entries(names).map(([name, address]) => [name, [v4(address)]])), "inside.example": [v4("10.0.0.1")] });
  const source = new NodeSiteIcons({
    origin: (name) => `http://${name}:${host.port}`,
    fetchOptions: { resolve, allowAddress: (a) => a === "127.0.0.1", allowPort: (port) => port === host.port || port === inside.port },
    ...extra,
  });
  return { source, asked };
}

/** A site: its page and files by path; anything else 404. */
function site(files: Record<string, { body: Uint8Array | string; type: string }>): Handler {
  return (request, response) => {
    const file = files[(request.url ?? "/").split("?")[0]!];
    if (!file) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": file.type });
    response.end(file.body);
  };
}

const html = (head: string) => ({ body: `<!doctype html><html><head>${head}</head><body>Hi</body></html>`, type: "text/html" });
const png = (size: number) => ({ body: pngFile(size, size), type: "image/png" });
const paths = () => host.requests.map((r) => r.path);

describe("a site's own icon", () => {
  test("the best icon its page names: a touch icon fills the circle", async () => {
    handler = site({ "/": html(`<link rel="icon" href="/favicon-32.png" sizes="32x32"><link rel="apple-touch-icon" href="/touch.png" sizes="180x180">`), "/touch.png": png(180), "/favicon-32.png": png(32) });
    const seen = host.requests.length;
    const found = await icons().source.fetch("brand.example");
    assert.equal(found.found, true);
    assert.deepEqual(found.found && { type: found.mimeType, w: found.width, fit: found.fit }, { type: "image/png", w: 180, fit: "fill" });
    assert.deepEqual(paths().slice(seen), ["/", "/touch.png"]);
    assert.match(host.requests[seen]!.headers.accept ?? "", /^text\/html/);
  });

  test("a maskable icon from its manifest before anything else", async () => {
    handler = site({
      "/": html(`<link rel="manifest" href="/site.webmanifest"><link rel="apple-touch-icon" href="/touch.png">`),
      "/site.webmanifest": { body: JSON.stringify({ icons: [{ src: "/any-192.png", sizes: "192x192" }, { src: "/mask-512.png", sizes: "512x512", purpose: "maskable" }] }), type: "application/manifest+json" },
      "/mask-512.png": png(512),
    });
    const found = await icons().source.fetch("brand.example");
    assert.deepEqual(found.found && { w: found.width, fit: found.fit }, { w: 512, fit: "fill" });
  });

  test("a favicon.ico, as the PNG the server writes, sitting inside the circle", async () => {
    const ico = icoFile([{ data: dib({ width: 32, height: 32, bpp: 32, pixel: () => [200, 0, 0, 255] }), width: 32, height: 32 }]);
    handler = site({ "/": html(""), "/favicon.ico": { body: ico, type: "image/x-icon" } });
    const seen = host.requests.length;
    const found = await icons().source.fetch("brand.example");
    assert.deepEqual(found.found && { type: found.mimeType, w: found.width, fit: found.fit }, { type: "image/png", w: 32, fit: "inset" });
    assert.deepEqual(paths().slice(seen), ["/", "/apple-touch-icon.png", "/favicon.ico"]);
  });

  test("an inline picture in the page, without another request", async () => {
    const inline = `data:image/png;base64,${Buffer.from(pngFile(48, 48)).toString("base64")}`;
    handler = site({ "/": html(`<link rel="icon" href="${inline}" sizes="48x48">`) });
    const seen = host.requests.length;
    const found = await icons().source.fetch("brand.example");
    assert.deepEqual(found.found && found.width, 48);
    assert.deepEqual(paths().slice(seen), ["/"]);
  });

  test("the www site when the bare domain has no address", async () => {
    handler = site({ "/": html(`<link rel="apple-touch-icon" href="/touch.png">`), "/touch.png": png(180) });
    const { source, asked } = icons({ "www.brand.example": "127.0.0.1" });
    const found = await source.fetch("brand.example");
    assert.equal(found.found, true);
    assert.deepEqual(asked.slice(0, 2), ["brand.example", "www.brand.example"]);
  });
});

describe("what isn't taken", () => {
  test("SVG, a moving PNG, or a picture too small: the next candidate is tried", async () => {
    const actl = new Uint8Array(8);
    handler = site({
      "/": html(`<link rel="icon" href="/logo.svg"><link rel="icon" href="/moving.png" sizes="192x192"><link rel="icon" href="/tiny.png" sizes="128x128"><link rel="icon" href="/ok.png" sizes="96x96">`),
      "/logo.svg": { body: "<svg xmlns='http://www.w3.org/2000/svg'/>", type: "image/svg+xml" },
      "/moving.png": { body: pngFile(192, 192, { before: [chunk("acTL", actl)] }), type: "image/png" },
      "/tiny.png": png(8),
      "/ok.png": png(96),
    });
    const seen = host.requests.length;
    const found = await icons().source.fetch("brand.example");
    assert.deepEqual(found.found && found.width, 96);
    assert.deepEqual(paths().slice(seen), ["/", "/moving.png", "/tiny.png", "/ok.png"], "the SVG isn't even asked for");
  });

  test("an icon the page names at a private address is never asked; nothing else found is 'none'", async () => {
    handler = site({ "/": html(`<link rel="apple-touch-icon" href="http://inside.example:${inside.port}/touch.png"><link rel="icon" href="http://127.0.0.2:${host.port}/a.png">`) });
    const before = inside.requests.length;
    const found = await icons().source.fetch("brand.example");
    assert.equal(inside.requests.length, before, "the private host saw nothing");
    assert.deepEqual(found, { found: false, kind: "none", reason: "its site answered 404" });
  });

  test("at most 6 requests for one domain, however many icons the page names", async () => {
    const links = Array.from({ length: 20 }, (_, i) => `<link rel="icon" href="/i${i}.png">`).join("");
    handler = site({ "/": html(links) });
    const seen = host.requests.length;
    const found = await icons().source.fetch("brand.example");
    assert.equal(found.found, false);
    assert.equal(host.requests.length - seen, 6);
  });

  test("a site that can't be reached at all is 'failed', to be tried again later", async () => {
    const { source } = icons({});
    const found = await source.fetch("brand.example");
    assert.equal(found.found, false);
    assert.equal(!found.found && found.kind, "failed");
  });

  test("a site that answers nothing but 404s is 'none'", async () => {
    handler = (_request, response) => response.writeHead(404).end();
    const found = await icons().source.fetch("brand.example");
    assert.equal(!found.found && found.kind, "none");
  });

  test("a slow site is given up within the domain's time", async () => {
    handler = () => undefined; // never answers
    const started = Date.now();
    const found = await icons(undefined, { limits: { totalMs: 600 } }).source.fetch("brand.example");
    assert.ok(Date.now() - started < 3_000);
    assert.equal(!found.found && found.kind, "failed", "it may answer later");
  });

  test("only the first part of a huge page is read", async () => {
    const filler = "<meta name=x content=y>".repeat(30_000);
    handler = site({ "/": html(`${filler}<link rel="apple-touch-icon" href="/touch.png">`), "/touch.png": png(180) });
    const seen = host.requests.length;
    const found = await icons(undefined).source.fetch("brand.example");
    assert.ok(!paths().slice(seen).includes("/touch.png"), "a link past the cut isn't seen");
    assert.equal(found.found, false);
  });
});
