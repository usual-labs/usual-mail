// Pictures from the web on Cloudflare (src/cloudflare/web/pictures.ts, sources.ts) in workerd: through the server end
// to end (a Gmail message's pictures pointed at the picture route with trackers taken out, fetched when first asked,
// then kept in the object's SQLite across a reset, forgotten with the inbox), and the picture source's rules
// (docs/contract-pictures.md; Node's src/node/pictures/cache.ts): typed by its bytes, refused ones served blank and
// remembered, a failing site asked at most three times, kept per inbox, in parts of at most 1 MB, one fetch for several
// asks, the cap and the records' own limits. Fake hosts and DNS behind Miniflare's outbound service (web-hosts.ts).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Response as MiniflareResponse } from "miniflare";
import { TRANSPARENT_GIF } from "../../src/pictures/kept.ts";
import { avif, gif, jpeg, png, webp } from "../picture-hosts.ts";
import { ADDRESS, connectGmail, startServer, until, type TestServer } from "./harness.ts";
import { FakeWeb, serve, slow, webOp } from "./web-hosts.ts";

const HERO = png(600, 300);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let server: TestServer;
let token = "";
const web = new FakeWeb()
  // Its site calls it something else: the type comes from the bytes.
  .host("news.example", serve(HERO, "application/octet-stream"))
  .host("emltrk.com", serve(png(1, 1)))
  .host("inside.example", serve(HERO), ["10.0.0.1"])
  // The test server's own host (harness.ts's BASE): its fetcher must never ask it.
  .host("mail.example", serve(HERO));

before(async () => {
  server = await startServer({ web: web.handle });
  token = (await server.pair()).token;
});
after(async () => {
  await server?.stop();
});

/** A message with only an HTML part, raw. */
function htmlMessage(subject: string, html: string): string {
  return [
    "From: The News <letters@news.example>",
    `To: ${ADDRESS}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${subject.replace(/\W+/g, "-")}@news.example>`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    "",
  ].join("\r\n");
}

const picture = (body: Record<string, unknown>) => webOp(server, { op: "picture", ...body });
/** The rows kept for an inbox, oldest served first, found by the key the source derives from its id (SHA-256, 32 characters). */
async function keyRows(inboxId: string) {
  const key = createHash("sha256").update(inboxId).digest("hex").slice(0, 32);
  return server.sql<{ kind: string; size: number; tries: number; reason: string | null }>("SELECT kind, size, tries, reason FROM host_pictures WHERE inbox_key = ? ORDER BY used_at", key);
}

describe("through the server", () => {
  test("a message's pictures point at the picture route, trackers out; fetched when first asked, then kept in the object's SQLite, also after a reset", async () => {
    const html = [
      `<p>This week</p><img src="https://news.example/hero.png" alt="Hero" width="600">`,
      `<img src="https://emltrk.com/v2/abc123" alt="">`,
      `<img src="https://news.example/p.gif" width="1" height="1">`,
      `<img src="http://10.0.0.1/inside.png" alt="Inside" width="50">`,
      `<img src="https://inside.example/secret.png" alt="Secret" width="50">`,
      `<img src="https://mail.example/v1/info" alt="Self" width="50">`,
    ].join("");
    // Delivered before the inbox is connected: mail already in the mailbox is from someone the person knows, so its
    // pictures aren't held back.
    await server.fake.deliver(htmlMessage("This week in pictures", html));
    const inbox = await connectGmail(server, token);
    const thread = await until("the newsletter", async () => (await server.call("GET", "/v1/search?q=pictures", undefined, token)).body.items?.[0]);
    const [message] = (await server.call("GET", `/v1/threads/${thread.id}`, undefined, token)).body.messages;
    const paths: string[] = [...message.html.matchAll(/src="([^"]+)"/g)].map((match: RegExpMatchArray) => match[1]!);
    assert.equal(paths.length, 4, message.html);
    assert.ok(paths.every((path) => path.startsWith(`/v1/messages/${message.id}/pictures/`)), message.html);
    assert.doesNotMatch(message.html, /emltrk|p\.gif|news\.example|10\.0\.0\.1/);
    assert.deepEqual(message.remotePictures, { shown: 4, trackersRemoved: 2, trackers: ["Litmus"] });
    assert.equal(web.requests.length, 0, "nothing is fetched until a device asks");

    const [hero, inside, secret, self] = paths as [string, string, string, string];
    const first = await server.mf.dispatchFetch(`https://mail.example${hero}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), HERO);
    assert.deepEqual(web.questions.filter((q) => q.name === "news.example").map((q) => q.type).sort(), ["A", "AAAA"]);
    assert.deepEqual(web.seen("news.example").map((r) => r.path), ["/hero.png"]);
    assert.equal(web.seen("emltrk.com").length, 0, "the tracker is never asked");

    // An address the mail itself names in a private range: served blank, for good. A name the DNS answers with a
    // private address: a failure, in words.
    const blank = await server.mf.dispatchFetch(`https://mail.example${inside}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(blank.status, 200);
    assert.deepEqual(new Uint8Array(await blank.arrayBuffer()), TRANSPARENT_GIF);
    const failed = await server.call("GET", secret, undefined, token);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error.code, "provider_error");
    assert.match(failed.body.error.message, /private address/);
    assert.equal(web.seen("inside.example").length, 0);
    // A picture at the server's own address (the host this request came to): a failure, the server never asks itself.
    const own = await server.call("GET", self, undefined, token);
    assert.equal(own.status, 502);
    assert.match(own.body.error.message, /this server's own/);
    assert.equal(web.seen("mail.example").length, 0);

    // Kept: asked again, and after the object is reset, nothing more is fetched.
    assert.equal((await server.call("GET", hero, undefined, token)).status, 200);
    await server.evict();
    const again = await server.mf.dispatchFetch(`https://mail.example${hero}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(again.status, 200);
    assert.deepEqual(new Uint8Array(await again.arrayBuffer()), HERO);
    assert.equal(web.seen("news.example").length, 1);

    // The store holds the addresses only as hashes.
    const kept = JSON.stringify(await server.sql("SELECT * FROM host_pictures"));
    assert.doesNotMatch(kept, /news\.example|hero|inside|10\.0\.0\.1/);
    assert.deepEqual((await keyRows(inbox.id)).map((row) => row.kind).sort(), ["failed", "failed", "picture", "refused"]);

    // Removing the inbox forgets what it kept.
    assert.equal((await server.call("DELETE", `/v1/inboxes/${inbox.id}`, undefined, token)).status, 204);
    await until("the inbox's pictures gone", async () => (await keyRows(inbox.id)).length === 0);
    assert.deepEqual(await server.sql("SELECT count(*) AS n FROM host_picture_parts"), [{ n: 0 }]);
  });
});

describe("what the picture source serves", () => {
  test("each of the five kinds, typed by its bytes whatever its site says", async () => {
    const kinds = { png: png(40, 40), jpeg: jpeg(40, 40), gif: gif(40, 40), webp: webp(40, 40), avif: avif(40, 40) };
    for (const [kind, bytes] of Object.entries(kinds)) {
      web.host(`${kind}.example`, serve(bytes, "text/plain"));
      const answer = await picture({ inboxId: "inbox-kinds", url: `https://${kind}.example/p` });
      assert.deepEqual({ ok: answer.ok, mimeType: answer.mimeType, size: answer.size }, { ok: true, mimeType: `image/${kind}`, size: bytes.length }, kind);
    }
  });

  test("HTML posing as a picture, an SVG, a picture claiming to be enormous, a tiny one: each served blank; refused ones remembered, their site asked once", async () => {
    web.host("posing.example", serve("<html><script>alert(1)</script></html>", "image/png"));
    web.host("svg.example", serve("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "image/svg+xml"));
    web.host("enormous.example", serve(png(30_000, 30_000)));
    web.host("tiny.example", serve(png(2, 2)));
    for (const host of ["posing", "svg", "enormous", "tiny"]) {
      for (let i = 0; i < 2; i++) {
        const answer = await picture({ inboxId: "inbox-blank", url: `https://${host}.example/p` });
        assert.deepEqual({ ok: answer.ok, mimeType: answer.mimeType, size: answer.size }, { ok: true, mimeType: "image/gif", size: TRANSPARENT_GIF.length }, host);
      }
    }
    for (const host of ["posing", "svg", "enormous"]) assert.equal(web.seen(`${host}.example`).length, 1, `${host} was asked once`);
    assert.deepEqual((await keyRows("inbox-blank")).map((row) => row.kind), ["refused", "refused", "refused", "picture"]);
  });

  test("a refusal from fetching is passed on in its words", async () => {
    web.host("gone.example", () => new MiniflareResponse("Gone", { status: 410 }));
    const answer = await picture({ inboxId: "inbox-words", url: "https://gone.example/p" });
    assert.deepEqual({ ok: answer.ok, message: answer.message, kind: answer.kind }, { ok: false, message: "its site answered 410", kind: "failed" });
  });
});

describe("how pictures are kept", () => {
  test("kept apart for each inbox, and each address apart", async () => {
    web.host("shared.example", serve(png(20, 20)));
    for (const [inboxId, path] of [["inbox-a", "/one"], ["inbox-a", "/one"], ["inbox-b", "/one"], ["inbox-a", "/two"]]) {
      assert.equal((await picture({ inboxId, url: `https://shared.example${path}` })).ok, true);
    }
    assert.deepEqual(web.seen("shared.example").map((r) => r.path), ["/one", "/one", "/two"]);
  });

  test("a picture over 1 MB is kept in parts of at most 1 MB, and served from them as a stream, one part per read", async () => {
    const large = png(2_000, 1_000, 2_500_000);
    web.host("large.example", serve(large));
    const fetched = await picture({ inboxId: "inbox-large", url: "https://large.example/p" });
    assert.deepEqual({ size: fetched.size, streamed: fetched.streamed }, { size: large.length, streamed: false }, "fetched now: the bytes in hand");
    const kept = await picture({ inboxId: "inbox-large", url: "https://large.example/p" });
    assert.deepEqual({ size: kept.size, streamed: kept.streamed }, { size: large.length, streamed: true }, "kept: never assembled");
    assert.deepEqual(kept.chunks, [1_048_576, 1_048_576, large.length - 2 * 1_048_576]);
    assert.equal(web.seen("large.example").length, 1);
    const [parts] = await server.sql<{ n: number; largest: number; total: number }>("SELECT count(*) AS n, max(length(data)) AS largest, sum(length(data)) AS total FROM host_picture_parts");
    assert.ok(parts!.n >= 3, `${parts!.n} parts`);
    assert.ok(parts!.largest <= 1_048_576);
    assert.ok(parts!.total >= large.length);
  });

  test("several asking at once share one fetch", async () => {
    web.host("busy.example", slow(300, serve(png(20, 20))));
    const answer = await picture({ inboxId: "inbox-busy", url: "https://busy.example/p", together: 3 });
    assert.deepEqual(answer.sizes, [png(20, 20).length, png(20, 20).length, png(20, 20).length]);
    assert.equal(web.seen("busy.example").length, 1);
  });

  test("a failing site is asked at most three times: at once, after ten minutes, after a day; then kept failed", async () => {
    let answers = 0;
    web.host("flaky.example", () => (answers++, new MiniflareResponse("Down", { status: 503 })));
    const t0 = 1_800_000_000_000;
    const at = async (now: number) => (await picture({ inboxId: "inbox-flaky", url: "https://flaky.example/p", now })).message;
    assert.equal(await at(t0), "its site answered 503");
    assert.equal(await at(t0 + MINUTE), "its site answered 503", "remembered, not asked");
    assert.equal(answers, 1);
    await at(t0 + 10 * MINUTE);
    assert.equal(answers, 2);
    await at(t0 + 10 * MINUTE + DAY - MINUTE);
    assert.equal(answers, 2);
    await at(t0 + 10 * MINUTE + DAY);
    assert.equal(answers, 3);
    await at(t0 + 300 * DAY);
    assert.equal(answers, 3, "then kept as failed");
    assert.deepEqual((await keyRows("inbox-flaky")).map((row) => [row.kind, row.tries]), [["failed", 3]]);
  });

  test("a failure that recovers on a later try is kept like any picture", async () => {
    let up = false;
    web.host("recovers.example", () => (up ? new MiniflareResponse(png(30, 30), { headers: { "content-type": "image/png" } }) : new MiniflareResponse("Down", { status: 500 })));
    const t0 = 1_800_000_000_000;
    assert.equal((await picture({ inboxId: "inbox-recovers", url: "https://recovers.example/p", now: t0 })).ok, false);
    up = true;
    assert.equal((await picture({ inboxId: "inbox-recovers", url: "https://recovers.example/p", now: t0 + 10 * MINUTE })).ok, true);
    assert.deepEqual((await keyRows("inbox-recovers")).map((row) => [row.kind, row.reason]), [["picture", null]]);
  });

  test("removing an inbox while one of its pictures is being fetched leaves nothing behind; forgetting deletes that inbox only", async () => {
    web.host("slowly.example", slow(300, serve(png(20, 20))));
    assert.equal((await picture({ inboxId: "inbox-other", url: "https://slowly.example/kept" })).ok, true);
    assert.equal((await picture({ inboxId: "inbox-gone", url: "https://slowly.example/p", forgetDuring: true })).ok, true);
    assert.deepEqual(await keyRows("inbox-gone"), []);
    assert.equal((await keyRows("inbox-other")).length, 1);
    await webOp(server, { op: "forget", inboxId: "inbox-other" });
    assert.deepEqual(await keyRows("inbox-other"), []);
  });

  // Last: the cap and the records' count are the whole server's, as on Node, so this sweeps the other tests' rows too. Its
  // clock is later than every other test's, so theirs are the least recently served.
  test("over the cap, the least recently served go first, down to 90%; records of refusals stay outside it, at most so many", async () => {
    const bytes = png(20, 20, 400);
    web.host("capped.example", serve(bytes));
    web.host("refusing.example", serve("not a picture", "image/png"));
    const t0 = 1_900_000_000_000;
    const cap = { maxBytes: bytes.length * 2 + 10, records: { count: 2, maxIdleMs: 365 * DAY } };
    await picture({ inboxId: "inbox-cap", url: "https://refusing.example/r1", now: t0, ...cap });
    for (const [i, name] of ["a", "b", "c"].entries()) await picture({ inboxId: "inbox-cap", url: `https://capped.example/${name}`, now: t0 + (i + 1) * MINUTE, ...cap });
    // Three pictures over a cap of two: the least recently served went; the refusal stayed.
    assert.deepEqual((await keyRows("inbox-cap")).map((row) => row.kind), ["refused", "picture"]);
    await picture({ inboxId: "inbox-cap", url: "https://capped.example/c", now: t0 + 5 * MINUTE, ...cap });
    assert.deepEqual(web.seen("capped.example").map((r) => r.path), ["/a", "/b", "/c"], "the one kept is served from the store");
    // Records beyond their count: the least recently served go.
    for (const [i, name] of ["r2", "r3"].entries()) await picture({ inboxId: "inbox-cap", url: `https://refusing.example/${name}`, now: t0 + (6 + i) * MINUTE, ...cap });
    await picture({ inboxId: "inbox-cap", url: "https://capped.example/d", now: t0 + 2 * 60 * MINUTE, ...cap });
    assert.deepEqual((await keyRows("inbox-cap")).map((row) => row.kind), ["refused", "refused", "picture"]);
    assert.deepEqual(await server.sql("SELECT count(*) AS n FROM host_pictures WHERE kind <> 'picture'"), [{ n: 2 }]);
    await picture({ inboxId: "inbox-cap", url: "https://refusing.example/r1", now: t0 + 3 * 60 * MINUTE, ...cap });
    assert.equal(web.seen("refusing.example").length, 4, "the oldest record went, so its picture was asked again");
  });
});

