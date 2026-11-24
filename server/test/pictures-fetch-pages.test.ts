// Fetching what a sender's logo is found from, under the picture fetcher's own rules: a page of which only the first
// part is read (the rest never is: the connection is closed), what each request asks for, and the address an answer
// finally came from after redirects. The address rules are the pictures' and are tested in pictures-dangers.test.ts;
// here once more that a cut page is no way around them. The fake host is on 127.0.0.1, which these tests alone admit.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fetchPictureBytes, fetchWebBytes, type FetchOptions } from "../src/node/pictures/fetch.ts";
import { fakeHost, fakeResolver, png, serve, v4, type FakeHost, type Handler } from "./picture-hosts.ts";

let handler: Handler = serve(png(10, 10));
let host: FakeHost;

before(async () => {
  host = await fakeHost((request, response, self) => handler(request, response, self));
});
after(() => host.close());

function toHost(extra: FetchOptions = {}): FetchOptions {
  const { resolve } = fakeResolver({ "brand.example": [v4("127.0.0.1")], "www.brand.example": [v4("127.0.0.1")], "inside.example": [v4("10.0.0.1")] });
  return { resolve, allowAddress: (a) => a === "127.0.0.1", allowPort: (port) => port === host.port, ...extra };
}

const url = (path: string, name = "brand.example") => `http://${name}:${host?.port}${path}`;
const PAGE_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";

describe("a page, cut", () => {
  test("gives its first bytes, however long it is, and stops reading", async () => {
    let written = 0;
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      const chunk = new Uint8Array(16 * 1024).fill(0x61);
      const more = () => {
        while (written < 2_000 && !response.destroyed && response.write(chunk)) written++;
        if (written < 2_000 && !response.destroyed) response.once("drain", more);
      };
      more();
    };
    const { bytes } = await fetchWebBytes(url("/"), toHost({ cutAt: 100_000, accept: PAGE_ACCEPT }));
    assert.equal(bytes.length, 100_000);
    assert.ok(bytes.every((byte) => byte === 0x61));
    assert.ok(written < 2_000, "the rest of 32 MB wasn't read");
  });

  test("isn't refused for a declared length beyond the cut", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/html", "content-length": String(50 * 1024 * 1024) });
      response.write("<html><head><link rel=icon href=/a.png></head>");
    };
    const { bytes } = await fetchWebBytes(url("/"), toHost({ cutAt: 20, accept: PAGE_ACCEPT }));
    assert.equal(new TextDecoder().decode(bytes), "<html><head><link re");
  });

  test("gives a shorter page whole", async () => {
    handler = serve("<html><head></head></html>", "text/html");
    const { bytes } = await fetchWebBytes(url("/"), toHost({ cutAt: 100_000 }));
    assert.equal(new TextDecoder().decode(bytes), "<html><head></head></html>");
  });

  test("is still refused compressed, and still capped without a cut", async () => {
    handler = serve("<html>", "text/html", { "content-encoding": "gzip" });
    await assert.rejects(fetchWebBytes(url("/"), toHost({ cutAt: 100 })), /compressed/);
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": String(1_000_000) });
      response.write("{}");
    };
    await assert.rejects(fetchWebBytes(url("/m.json"), toHost({ maxBytes: 65_536 })), /larger than/);
  });

  test("is no way around the address rule: a redirect inside is refused, cut or not", async () => {
    handler = (_request, response) => response.writeHead(302, { location: url("/", "inside.example") }).end();
    await assert.rejects(fetchWebBytes(url("/"), toHost({ cutAt: 100 })), /private address/);
  });
});

describe("what a request asks for, and where the answer came from", () => {
  test("asks with the accept header given, and pictures by default", async () => {
    handler = serve("{}", "application/manifest+json");
    await fetchWebBytes(url("/site.webmanifest"), toHost({ accept: "application/manifest+json,application/json;q=0.9" }));
    assert.equal(host.requests.at(-1)!.headers.accept, "application/manifest+json,application/json;q=0.9");
    handler = serve(png(10, 10));
    await fetchPictureBytes(url("/a.png"), toHost());
    assert.match(host.requests.at(-1)!.headers.accept ?? "", /^image\/avif,image\/webp/);
  });

  test("says the address the answer finally came from, after redirects", async () => {
    handler = (request, response) => {
      if (request.url === "/") response.writeHead(301, { location: url("/home", "www.brand.example") }).end();
      else serve("<html></html>", "text/html")(request, response, host);
    };
    const { url: final } = await fetchWebBytes(url("/"), toHost({ cutAt: 1_000 }));
    assert.equal(final, url("/home", "www.brand.example"));
    handler = serve("<html></html>", "text/html");
    assert.equal((await fetchWebBytes(url("/x?y=1"), toHost())).url, url("/x?y=1"));
  });
});
