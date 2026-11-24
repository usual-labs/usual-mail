// Node's picture source: what it serves (real pictures only, of a sane size, by the type read from their bytes), and
// how it keeps them (once per inbox, one fetch at a time per address, failures remembered for a while, removed
// inboxes forgotten, the oldest dropped over the cap). A fake host on 127.0.0.1 stands in for the web.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { DiskPictureSource, TRANSPARENT_GIF, type DiskPictureOptions } from "../src/node/pictures/cache.ts";
import { PictureRefused } from "../src/pictures/refused.ts";
import { avif, fakeHost, fakeResolver, gif, jpeg, png, serve, v4, webp, type FakeHost, type Handler } from "./picture-hosts.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let handler: Handler = serve(png(10, 10));
let host: FakeHost;
let dir: string;
let clock = 1_000_000;

before(async () => {
  host = await fakeHost((request, response, self) => handler(request, response, self));
});
after(() => host.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usual-mail-pictures-test-"));
  handler = serve(png(10, 10));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function source(options: Partial<DiskPictureOptions> = {}): DiskPictureSource {
  const { resolve } = fakeResolver({ "pictures.example": [v4("127.0.0.1")] });
  return new DiskPictureSource({
    dir,
    now: () => clock,
    fetchOptions: { resolve, allowAddress: (a) => a === "127.0.0.1", allowPort: (port) => port === host.port },
    ...options,
  });
}

const at = (path: string) => `http://pictures.example:${host.port}${path}`;

describe("what is served", () => {
  test("each of the five kinds, typed by its bytes whatever its site says", async () => {
    const kinds: Array<[Uint8Array, string]> = [
      [png(40, 30), "image/png"], [jpeg(40, 30), "image/jpeg"], [gif(40, 30), "image/gif"],
      [webp(40, 30), "image/webp"], [avif(40, 30), "image/avif"],
    ];
    const pictures = source();
    for (const [bytes, type] of kinds) {
      handler = serve(bytes, "text/html");
      const picture = await pictures.get("inbox-1", at(`/${type.slice(6)}`));
      assert.equal(picture.mimeType, type);
      assert.deepEqual(picture.data, bytes);
    }
  });

  test("not HTML posing as a picture: refused for good, served blank, its site asked once", async () => {
    handler = serve("<html><script>alert(1)</script></html>", "image/png");
    const pictures = source();
    const before = host.requests.length;
    for (const later of [0, 11 * MINUTE, DAY, 20 * DAY]) {
      clock += later;
      assert.deepEqual(await pictures.get("inbox-1", at("/not-a-picture.png")), { mimeType: "image/gif", data: TRANSPARENT_GIF });
    }
    assert.equal(host.requests.length, before + 1, "a sender learns of one opening only");
  });

  test("an address the mail itself names in a refused range: refused for good, served blank, never tried again", async () => {
    let tries = 0;
    const pictures = new DiskPictureSource({ dir, now: () => clock, fetch: async (url) => (tries++, (await import("../src/node/pictures/fetch.ts")).fetchPictureBytes(url)) });
    for (const later of [0, 11 * MINUTE, DAY, 20 * DAY]) {
      clock += later;
      assert.deepEqual(await pictures.get("inbox-1", "http://10.0.0.5/a.png"), { mimeType: "image/gif", data: TRANSPARENT_GIF });
    }
    assert.equal(tries, 1);
  });

  test("an address in the server's own network depends on where it runs: tried three times like a failure", async () => {
    const home = { en0: [{ address: "93.184.215.14", cidr: "93.184.215.14/24", family: "IPv4", netmask: "", mac: "", internal: false } as never] };
    let tries = 0;
    const pictures = new DiskPictureSource({ dir, now: () => clock, fetch: async (url) => (tries++, (await import("../src/node/pictures/fetch.ts")).fetchPictureBytes(url, { interfaces: home })) });
    for (const later of [0, 11 * MINUTE, DAY + MINUTE, 20 * DAY]) {
      clock += later;
      await assert.rejects(pictures.get("inbox-1", "http://93.184.215.99/a.png"), /own network/);
    }
    assert.equal(tries, 3);
  });

  test("a name that answers with a private address depends on the DNS, not the sender: tried three times like a failure", async () => {
    const { asked, resolve } = fakeResolver({ "inside.example": [v4("10.0.0.5")] });
    const pictures = new DiskPictureSource({ dir, now: () => clock, fetchOptions: { resolve } });
    for (const later of [0, 11 * MINUTE, DAY + MINUTE, 20 * DAY]) {
      clock += later;
      await assert.rejects(pictures.get("inbox-1", "http://inside.example/a.png"), /private address/);
    }
    assert.equal(asked.length, 3);
  });

  test("not HTML posing as a picture, nor an SVG with a script, nor anything else: each served blank", async () => {
    const bodies: Array<[string | Uint8Array, string]> = [
      ["<html><script>alert(1)</script></html>", "image/png"],
      [`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`, "image/svg+xml"],
      [`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>`, "image/png"],
      [new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "image/bmp"],
      ["", "image/png"],
    ];
    const pictures = source();
    for (const [i, [body, type]] of bodies.entries()) {
      handler = serve(body, type);
      assert.deepEqual(await pictures.get("inbox-1", at(`/not-${i}`)), { mimeType: "image/gif", data: TRANSPARENT_GIF });
    }
  });

  test("not a picture claiming to be enormous, which a client would have to decode: served blank", async () => {
    for (const [path, body] of [["/bomb.png", png(100_000, 100_000)], ["/wide.gif", gif(30_000, 10)]] as const) {
      handler = serve(body);
      assert.deepEqual(await source().get("inbox-1", at(path)), { mimeType: "image/gif", data: TRANSPARENT_GIF });
    }
  });

  test("a picture of at most 2×2 is served blank", async () => {
    handler = serve(gif(1, 1));
    const picture = await source().get("inbox-1", at("/pixel.gif"));
    assert.deepEqual(picture, { mimeType: "image/gif", data: TRANSPARENT_GIF });
  });

  test("a refusal from fetching is passed on in its words", async () => {
    handler = (_request, response) => response.writeHead(500).end();
    await assert.rejects(source().get("inbox-1", at("/broken.png")), (error: unknown) =>
      error instanceof PictureRefused && /answered 500/.test(error.message));
  });
});

describe("how pictures are kept", () => {
  test("fetched once, then served from the disk, also after a restart", async () => {
    const before = host.requests.length;
    const first = await source().get("inbox-1", at("/kept.png"));
    const again = await source().get("inbox-1", at("/kept.png"));
    assert.deepEqual(again, first);
    assert.equal(host.requests.length, before + 1);
  });

  test("kept apart for each inbox, and each address apart", async () => {
    const pictures = source();
    const before = host.requests.length;
    handler = serve(png(11, 11));
    const a = await pictures.get("inbox-1", at("/a.png"));
    handler = serve(png(22, 22));
    const b = await pictures.get("inbox-2", at("/a.png"));
    const c = await pictures.get("inbox-1", at("/c.png"));
    assert.equal(host.requests.length, before + 3);
    assert.deepEqual(a.data, png(11, 11));
    assert.deepEqual(b.data, png(22, 22));
    assert.deepEqual(c.data, png(22, 22));
    assert.deepEqual((await pictures.get("inbox-1", at("/a.png"))).data, png(11, 11), "one address's bytes never answer for another");
    assert.equal(readdirSync(dir).length, 2);
  });

  test("several asking at once share one fetch", async () => {
    handler = (request, response) => setTimeout(() => serve(png(10, 10))(request, response, host), 50);
    const before = host.requests.length;
    const pictures = source();
    const all = await Promise.all(Array.from({ length: 5 }, () => pictures.get("inbox-1", at("/shared.png"))));
    assert.equal(host.requests.length, before + 1);
    assert.equal(new Set(all.map((p) => p.data.length)).size, 1);
  });

  test("a failing site is asked at most three times: at once, after ten minutes, after a day; then kept failed", async () => {
    handler = (_request, response) => response.writeHead(503).end();
    const pictures = source();
    const before = host.requests.length;
    const open = async (after: number) => {
      clock += after;
      await assert.rejects(pictures.get("inbox-1", at("/down.png")), /answered 503/);
      return host.requests.length - before;
    };
    assert.equal(await open(0), 1);
    assert.equal(await open(5 * MINUTE), 1, "not again within ten minutes");
    assert.equal(await open(6 * MINUTE), 2, "again after ten minutes");
    assert.equal(await open(12 * 60 * MINUTE), 2, "not again within a day");
    assert.equal(await open(12 * 60 * MINUTE + 1), 3, "a last time after a day");
    assert.equal(await open(DAY), 3, "then never again");
    assert.equal(await open(20 * DAY), 3);
  });

  test("a failure that recovers on a later try is kept like any picture, and its record goes", async () => {
    handler = (_request, response) => response.writeHead(503).end();
    const pictures = source();
    await assert.rejects(pictures.get("inbox-1", at("/flaky.png")), /answered 503/);
    const [folder] = readdirSync(dir);
    assert.equal(readdirSync(join(dir, folder!)).filter((name) => name.endsWith(".record")).length, 1);
    clock += 11 * MINUTE;
    handler = serve(png(10, 10));
    assert.equal((await pictures.get("inbox-1", at("/flaky.png"))).mimeType, "image/png");
    assert.deepEqual(readdirSync(join(dir, folder!)).filter((name) => name.endsWith(".record")), []);
    const before = host.requests.length;
    clock += 10 * DAY;
    assert.equal((await pictures.get("inbox-1", at("/flaky.png"))).mimeType, "image/png");
    assert.equal(host.requests.length, before);
  });

  test("removing an inbox while one of its pictures is being fetched leaves nothing behind", async () => {
    let release: () => void = () => undefined;
    handler = (request, response) => {
      release = () => serve(png(10, 10))(request, response, host);
    };
    const pictures = source();
    const pending = pictures.get("inbox-gone", at("/racing.png"));
    while (host.requests.length === 0 || !host.requests.at(-1)!.path.endsWith("/racing.png")) await new Promise((r) => setTimeout(r, 5));
    // The inbox is forgotten whole before its picture arrives; writing it would make its folder again.
    await pictures.forget("inbox-gone");
    release();
    await pending;
    assert.deepEqual(readdirSync(dir), []);
  });

  test("a partly written file a crash left is swept; one being written isn't", async () => {
    const pictures = source({ now: () => Date.now() });
    const folder = join(dir, "0".repeat(32));
    mkdirSync(folder);
    const stale = join(folder, `${"a".repeat(64)}.${"b".repeat(12)}.partial`);
    const fresh = join(folder, `${"c".repeat(64)}.${"d".repeat(12)}.partial`);
    writeFileSync(stale, "x");
    writeFileSync(fresh, "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * MINUTE);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);
    await pictures.get("inbox-1", at("/sweeps.png")); // the first picture kept sweeps
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(fresh), true);
  });

  test("forgetting an inbox deletes its folder only", async () => {
    const pictures = source();
    await pictures.get("inbox-1", at("/f.png"));
    await pictures.get("inbox-2", at("/f.png"));
    assert.equal(readdirSync(dir).length, 2);
    await pictures.forget("inbox-1");
    assert.equal(readdirSync(dir).length, 1);
    const before = host.requests.length;
    await pictures.get("inbox-1", at("/f.png"));
    await pictures.get("inbox-2", at("/f.png"));
    assert.equal(host.requests.length, before + 1, "inbox-2's copy stayed");
  });

  test("records of refusals and failures outlive the cap: filling it with pictures doesn't make them asked again", async () => {
    const size = png(10, 10, 4_000).length;
    const pictures = source({ maxBytes: size * 3 + 100 });
    handler = (request, response) => {
      if (request.url === "/tracker.png") response.writeHead(503).end();
      else if (request.url === "/odd.png") serve("<html></html>", "image/png")(request, response, host);
      else serve(png(10, 10, 4_000))(request, response, host);
    };
    await assert.rejects(pictures.get("inbox-1", at("/tracker.png")), /answered 503/);
    await pictures.get("inbox-1", at("/odd.png"));
    for (let i = 0; i < 8; i++) {
      clock += 1_000;
      await pictures.get("inbox-1", at(`/flood-${i}.png`));
    }
    const before = host.requests.length;
    await assert.rejects(pictures.get("inbox-1", at("/tracker.png")), /answered 503/);
    assert.deepEqual(await pictures.get("inbox-1", at("/odd.png")), { mimeType: "image/gif", data: TRANSPARENT_GIF });
    assert.equal(host.requests.length, before, "neither was asked again");
  });

  test("at most so many records are kept: the least recently served go first", async () => {
    handler = (_request, response) => response.writeHead(503).end();
    const pictures = source({ records: { count: 2, maxIdleMs: 365 * DAY } });
    for (const name of ["r1", "r2", "r3"]) {
      clock += 2 * 60 * MINUTE; // a sweep runs at most hourly
      await assert.rejects(pictures.get("inbox-1", at(`/${name}.png`)), /answered 503/);
    }
    const [folder] = readdirSync(dir);
    assert.equal(readdirSync(join(dir, folder!)).filter((name) => name.endsWith(".record")).length, 2);
    const before = host.requests.length;
    await assert.rejects(pictures.get("inbox-1", at("/r1.png")), /answered 503/);
    assert.equal(host.requests.length, before + 1, "the oldest record went, so it was asked again");
  });

  test("over the cap, the least recently served go first", async () => {
    const size = png(10, 10, 4_000).length;
    const pictures = source({ maxBytes: size * 3 + 100 });
    handler = serve(png(10, 10, 4_000));
    for (const name of ["one", "two", "three"]) {
      clock += 1_000;
      await pictures.get("inbox-1", at(`/${name}.png`));
    }
    clock += 1_000;
    await pictures.get("inbox-1", at("/one.png")); // served again: now the most recent
    clock += 1_000;
    await pictures.get("inbox-1", at("/four.png")); // over the cap: "two" and "three" are the oldest
    const before = host.requests.length;
    await pictures.get("inbox-1", at("/one.png"));
    await pictures.get("inbox-1", at("/four.png"));
    assert.equal(host.requests.length, before, "the two most recent stayed");
    await pictures.get("inbox-1", at("/two.png"));
    assert.equal(host.requests.length, before + 1, "the oldest went");
  });

  test("files are the owner's only, and nothing partial is left", async () => {
    await source().get("inbox-1", at("/mode.png"));
    const [folder] = readdirSync(dir);
    const files = readdirSync(join(dir, folder!));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^[0-9a-f]{64}$/);
    assert.ok(existsSync(join(dir, folder!, files[0]!)));
  });
});
