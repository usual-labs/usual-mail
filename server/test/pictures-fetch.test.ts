// Fetching a picture that is allowed: what the request carries, https with the connection pinned to the checked
// address while the certificate is checked against the name, and the limits on answers (status, compression, size,
// time). The fake host is on 127.0.0.1, which these tests alone admit; the dangers are in pictures-dangers.test.ts.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fetchPictureBytes, PICTURE_USER_AGENT, type FetchOptions } from "../src/node/pictures/fetch.ts";
import { PictureRefused } from "../src/pictures/refused.ts";
import { fakeHost, fakeResolver, fakeTlsHost, makeCertificate, png, serve, v4, type FakeHost, type Handler } from "./picture-hosts.ts";

let handler: Handler = serve(png(10, 10));
let host: FakeHost;

before(async () => {
  host = await fakeHost((request, response, self) => handler(request, response, self));
});
after(() => host.close());

/** Admits only the fake host: 127.0.0.1 at its port, as `pictures.example`. */
function toHost(extra: FetchOptions = {}): FetchOptions & { asked: string[] } {
  const { asked, resolve } = fakeResolver({ "pictures.example": [v4("127.0.0.1")] });
  return { asked, resolve, allowAddress: (a) => a === "127.0.0.1", allowPort: (port) => port === host.port, ...extra };
}

const url = (path = "/a.png") => `http://pictures.example:${host?.port}${path}`;

describe("a picture that may be fetched", () => {
  test("is fetched with a common user agent, no compression, no cookie, referrer or language", async () => {
    handler = serve(png(10, 10));
    const bytes = await fetchPictureBytes(url("/a.png?x=1"), toHost());
    assert.deepEqual(bytes, png(10, 10));
    const seen = host.requests.at(-1)!;
    assert.equal(seen.method, "GET");
    assert.equal(seen.path, "/a.png?x=1");
    assert.equal(seen.headers["user-agent"], PICTURE_USER_AGENT);
    assert.equal(seen.headers["accept-encoding"], "identity");
    assert.equal(seen.headers.host, `pictures.example:${host.port}`);
    for (const name of ["cookie", "referer", "accept-language", "authorization", "x-forwarded-for", "origin"]) {
      assert.equal(seen.headers[name], undefined, name);
    }
  });

  test("opens a new connection for every request and every hop, never reusing one", async () => {
    handler = (request, response) => {
      if (request.url === "/hop.png") response.writeHead(302, { location: "/a.png" }).end();
      else serve(png(10, 10))(request, response, host);
    };
    const before = host.connections;
    await fetchPictureBytes(url("/a.png"), toHost());
    await fetchPictureBytes(url("/a.png"), toHost());
    await fetchPictureBytes(url("/hop.png"), toHost());
    assert.equal(host.connections - before, 4);
  });

  test("follows a redirect on the same checked host", async () => {
    handler = (request, response) => {
      if (request.url === "/old.png") response.writeHead(301, { location: "/new.png" }).end();
      else serve(png(10, 10))(request, response, host);
    };
    assert.deepEqual(await fetchPictureBytes(url("/old.png"), toHost()), png(10, 10));
  });
});

describe("answers that are refused", () => {
  test("a status other than 200", async () => {
    handler = (_request, response) => response.writeHead(404).end("no");
    await assert.rejects(fetchPictureBytes(url(), toHost()), /answered 404/);
  });

  test("a compressed body, which was never asked for", async () => {
    handler = serve(png(10, 10), "image/png", { "content-encoding": "gzip" });
    await assert.rejects(fetchPictureBytes(url(), toHost()), /compressed/);
  });

  test("a declared length over the cap, before reading it", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "image/png", "content-length": String(50 * 1024 * 1024) });
      response.write(png(10, 10));
    };
    await assert.rejects(fetchPictureBytes(url(), toHost()), /larger than 10 MB/);
  });

  test("a body that grows past the cap without saying so", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      const chunk = new Uint8Array(16 * 1024);
      let sent = 0;
      const more = () => {
        while (sent < 200 && response.write(chunk)) sent++;
        if (sent < 200 && !response.destroyed) response.once("drain", more);
      };
      more();
    };
    await assert.rejects(fetchPictureBytes(url(), toHost({ maxBytes: 64 * 1024 })), /larger than/);
  });

  test("a site that never answers", async () => {
    handler = () => undefined;
    await assert.rejects(fetchPictureBytes(url(), toHost({ connectTimeoutMs: 150 })), /didn't answer in time/);
  });

  test("a site that answers and then trickles", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      const timer = setInterval(() => (response.destroyed ? clearInterval(timer) : response.write(new Uint8Array(1))), 50);
      response.on("close", () => clearInterval(timer));
    };
    await assert.rejects(fetchPictureBytes(url(), toHost({ totalTimeoutMs: 400 })), (error: unknown) => {
      assert.ok(error instanceof PictureRefused);
      assert.match(error.message, /took too long/);
      return true;
    });
  });
});

describe("https", () => {
  const tls = makeCertificate("pictures.example");
  let secure: FakeHost | null = null;

  before(async () => {
    if (tls) secure = await fakeTlsHost(serve(png(10, 10)), tls);
  });
  after(() => secure?.close());

  function toSecure(names: Record<string, ReturnType<typeof v4>[]>): FetchOptions & { asked: string[] } {
    const { asked, resolve } = fakeResolver(names);
    return { asked, resolve, allowAddress: (a) => a === "127.0.0.1", allowPort: (port) => port === secure!.port, ca: tls!.cert };
  }

  test("connects to the checked address and checks the certificate against the name", async (t) => {
    if (!secure) return t.skip("no openssl to make a test certificate");
    const options = toSecure({ "pictures.example": [v4("127.0.0.1")] });
    assert.deepEqual(await fetchPictureBytes(`https://pictures.example:${secure.port}/a.png`, options), png(10, 10));
    assert.deepEqual(options.asked, ["pictures.example"]);
    assert.equal(secure.requests.at(-1)!.headers.host, `pictures.example:${secure.port}`);
  });

  test("refuses a certificate for another name, though the address is the same", async (t) => {
    if (!secure) return t.skip("no openssl to make a test certificate");
    const options = toSecure({ "other.example": [v4("127.0.0.1")] });
    const seen = secure.requests.length;
    await assert.rejects(fetchPictureBytes(`https://other.example:${secure.port}/a.png`, options), /certificate/);
    assert.equal(secure.requests.length, seen, "no request went over a connection whose certificate failed");
  });

  test("refuses a certificate no trusted authority signed", async (t) => {
    if (!secure) return t.skip("no openssl to make a test certificate");
    const { resolve } = fakeResolver({ "pictures.example": [v4("127.0.0.1")] });
    const options: FetchOptions = { resolve, allowAddress: (a) => a === "127.0.0.1", allowPort: (port) => port === secure!.port };
    await assert.rejects(fetchPictureBytes(`https://pictures.example:${secure.port}/a.png`, options), /certificate/);
  });
});
