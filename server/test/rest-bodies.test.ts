// When the REST routes read a request's body (src/rest/app.ts): after its token is checked, and only up to its limit.
// A body without Content-Length (chunked) used to be read up to 2 MB by a limit in front of every /v1/* path, before
// any route or token was looked at, so requests anyone could send held memory. Now a route checks the token first, a
// path that is no route reads nothing, and pairing reads at most 16 KiB.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createApp, PAIR_MAX_BYTES } from "../src/rest/app.ts";
import { makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
let app: ReturnType<typeof createApp>;

before(async () => {
  t = await makeServer();
  app = createApp(t.server, { scheduler: t.clock, log: t.host.log });
});
after(() => t.close());

const CHUNK = 16 * 1024;

/** A body of `total` bytes sent in chunks, without Content-Length, that counts what was pulled from it. */
function chunked(total: number, fill = 0x20) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) return controller.close();
      const size = Math.min(CHUNK, total - pulled);
      pulled += size;
      controller.enqueue(new Uint8Array(size).fill(fill));
    },
  });
  return { stream, pulled: () => pulled };
}

const post = (path: string, body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  Promise.resolve(app.request(path, { method: "POST", body, headers, duplex: "half" } as RequestInit));

describe("a body is read only after the token, and only up to its route's limit", () => {
  test("a route that needs a token answers 401 without reading the body", async () => {
    const body = chunked(1024 * 1024);
    const answer = await post("/v1/pairing-codes", body.stream, { "content-type": "application/json" });
    assert.equal(answer.status, 401);
    assert.ok(body.pulled() <= 2 * CHUNK, `${body.pulled()} bytes of the body were read`);
  });

  test("a wrong token is refused the same way", async () => {
    const body = chunked(1024 * 1024);
    const answer = await post("/v1/pairing-codes", body.stream, { authorization: "Bearer umt_not-a-token", "content-type": "application/json" });
    assert.equal(answer.status, 401);
    assert.ok(body.pulled() <= 2 * CHUNK, `${body.pulled()} bytes of the body were read`);
  });

  test("a path that is no route answers 404 without reading the body", async () => {
    const body = chunked(1024 * 1024);
    const answer = await post("/v1/no-such-route", body.stream);
    assert.equal(answer.status, 404);
    assert.ok(body.pulled() <= 2 * CHUNK, `${body.pulled()} bytes of the body were read`);
  });

  test("pairing reads at most 16 KiB, whether the body says its length or not", async () => {
    const body = chunked(1024 * 1024);
    const answer = await post("/v1/pair", body.stream, { "content-type": "application/json" });
    assert.equal(answer.status, 400);
    assert.match((await answer.json() as { error: { message: string } }).error.message, /too large/);
    assert.ok(body.pulled() <= PAIR_MAX_BYTES + 2 * CHUNK, `${body.pulled()} bytes of the body were read`);
    const declared = await post("/v1/pair", JSON.stringify({ code: "ABCD-EFGH", name: "x".repeat(PAIR_MAX_BYTES) }), { "content-type": "application/json" });
    assert.equal(declared.status, 400);
    assert.match((await declared.json() as { error: { message: string } }).error.message, /too large/);
  });

  test("with its token, a route reads a body sent without Content-Length, as before", async () => {
    const json = new TextEncoder().encode(JSON.stringify({ kind: "person" }));
    const stream = new ReadableStream<Uint8Array>({ start: (controller) => (controller.enqueue(json), controller.close()) });
    const answer = await post("/v1/pairing-codes", stream, { authorization: `Bearer ${t.personToken}`, "content-type": "application/json" });
    assert.equal(answer.status, 200, await answer.clone().text());
    assert.match((await answer.json() as { code: string }).code, /\w/);
  });
});
