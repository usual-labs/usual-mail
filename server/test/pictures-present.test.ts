// How the server shows one message's pictures from the web: trackers on the list and tiny or hidden pictures taken
// out and counted, the rest pointed at the picture route (at most 100), held back for screened or blocked senders,
// and a picture id answering only for what the message shows. Plus the shipped tracker list itself.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_PICTURES_PER_MESSAGE, picturePath } from "@usualmail/core";
import { sanitizeHtml } from "@usualmail/mail";
import { MAX_EXAMINED_ADDRESSES, MAX_KEPT_CHARS, PicturePlans, pictureId, presentPictures, shownPictureUrl } from "../src/pictures/present.ts";
import { Trackers, trackers as shipped } from "../src/pictures/trackers.ts";

const list = new Trackers({
  source: { name: "test", repository: "", commit: "", license: "", licenseText: "" },
  trackers: [
    { name: "Open Counter", patterns: ["opens\\.example/o/"] },
    { name: "Beacon Mail", patterns: ["beacon\\.example"] },
  ],
});

/** Plans over the test list, made fresh for each use so no test sees another's. */
const plans = () => new PicturePlans(list);

const MAIL = sanitizeHtml([
  `<p>Hello</p>`,
  `<img src="https://news.example/hero.png" alt="Hero" width="600">`,
  `<img src="https://opens.example/o/abc123.gif" alt="">`,
  `<div style="background:url(https://beacon.example/b.png)">x</div>`,
  `<img src="https://news.example/px.gif" width="1" height="1">`,
  `<img src="https://news.example/spacer.gif" width="1" height="1">`,
  `<img src="https://news.example/hero.png" alt="Again">`,
  `<table><tr><td background="https://news.example/bg.png">t</td></tr></table>`,
].join(""))!;

describe("one message's pictures", () => {
  test("trackers and tiny pictures go before anything is fetched; the rest point at the picture route", async () => {
    const { html, remotePictures } = await presentPictures("m1", MAIL, undefined, plans());
    const hero = await pictureId("https://news.example/hero.png");
    const bg = await pictureId("https://news.example/bg.png");
    assert.equal(html, [
      `<p>Hello</p>`,
      `<img src="${picturePath("m1", hero)}" alt="Hero" width="600" />`,
      `<div style="background:none">x</div>`,
      `<img src="${picturePath("m1", hero)}" alt="Again" />`,
      `<table><tr><td background="${picturePath("m1", bg)}">t</td></tr></table>`,
    ].join(""));
    // Two trackers on the list and one tiny picture; the spacer goes too but isn't counted.
    assert.deepEqual(remotePictures, { shown: 2, trackersRemoved: 3, trackers: ["Beacon Mail", "Open Counter"] });
  });

  test("a picture id stands only for a picture the message shows", async () => {
    const hero = await pictureId("https://news.example/hero.png");
    assert.equal(await shownPictureUrl("m1", MAIL, hero, undefined, plans()), "https://news.example/hero.png");
    for (const url of ["https://opens.example/o/abc123.gif", "https://news.example/px.gif", "https://elsewhere.example/x.png"]) {
      assert.equal(await shownPictureUrl("m1", MAIL, await pictureId(url), undefined, plans()), null, url);
    }
    assert.equal(await shownPictureUrl("m1", MAIL, "not-an-id", undefined, plans()), null);
  });

  test("held back for a screened or blocked sender: nothing shown, trackers still taken out", async () => {
    for (const held of ["screened", "blocked"] as const) {
      const { html, remotePictures } = await presentPictures("m1", MAIL, held, plans());
      assert.doesNotMatch(html, /\/v1\/messages\//);
      assert.match(html, /<img alt="Hero" width="600" \/>/);
      assert.deepEqual(remotePictures, { shown: 0, trackersRemoved: 3, trackers: ["Beacon Mail", "Open Counter"], heldBack: held });
      assert.equal(await shownPictureUrl("m1", MAIL, await pictureId("https://news.example/hero.png"), held, plans()), null);
    }
  });

  test("a message with only trackers says nothing is held back", async () => {
    const html = sanitizeHtml(`<p>Hi</p><img src="https://opens.example/o/1.gif">`)!;
    const { remotePictures } = await presentPictures("m1", html, "screened", plans());
    assert.deepEqual(remotePictures, { shown: 0, trackersRemoved: 1, trackers: ["Open Counter"] });
  });

  test(`at most ${MAX_PICTURES_PER_MESSAGE} pictures are shown; the rest are left out`, async () => {
    const many = sanitizeHtml(Array.from({ length: 105 }, (_, i) => `<img src="https://news.example/${i}.png" alt="${i}">`).join(""))!;
    const { html, remotePictures } = await presentPictures("m1", many, undefined, plans());
    assert.equal(remotePictures?.shown, MAX_PICTURES_PER_MESSAGE);
    assert.equal(html.match(/src="\/v1\//g)?.length, MAX_PICTURES_PER_MESSAGE);
    assert.match(html, /<img alt="104" \/>/);
    assert.equal(await shownPictureUrl("m1", many, await pictureId("https://news.example/104.png"), undefined, plans()), null);
  });

  test("HTML without pictures from the web has no summary, and loses fonts from the web", async () => {
    const html = sanitizeHtml(`<style>@font-face{font-family:F;src:url(https://fonts.example/f.woff2)}</style><p>Hi</p>`)!;
    const out = await presentPictures("m1", html, undefined, plans());
    assert.equal(out.remotePictures, undefined);
    assert.doesNotMatch(out.html, /fonts\.example/);
  });

  test("the plan is made once per message: serving again and every picture asked for reuse it", async () => {
    const shared = plans();
    await presentPictures("m1", MAIL, undefined, shared);
    const after = { ...shared.work };
    assert.deepEqual(after, { plans: 1, matches: 6, rewrites: 1 });
    const hero = await pictureId("https://news.example/hero.png");
    for (let i = 0; i < 50; i++) assert.equal(await shownPictureUrl("m1", MAIL, hero, undefined, shared), "https://news.example/hero.png");
    await presentPictures("m1", MAIL, undefined, shared);
    assert.deepEqual(shared.work, after, "no new plan and no tracker matched again");
    // Another held-back state, another message or other HTML is another plan.
    await shownPictureUrl("m1", MAIL, hero, "screened", shared);
    await shownPictureUrl("m2", MAIL, hero, undefined, shared);
    await shownPictureUrl("m1", `${MAIL}<p>more</p>`, hero, undefined, shared);
    assert.equal(shared.work.plans, 4);
  });

  test("a message is written again once per state: later serves reuse the served HTML", async () => {
    const shared = plans();
    const first = await presentPictures("m1", MAIL, undefined, shared);
    for (let i = 0; i < 10; i++) assert.deepEqual(await presentPictures("m1", MAIL, undefined, shared), first);
    assert.equal(shared.work.rewrites, 1);
    await presentPictures("m1", MAIL, "screened", shared);
    assert.equal(shared.work.rewrites, 2);
  });

  test("the served HTML kept is bounded by its size, not only by the number of messages", async () => {
    // Room for two messages with their plans, not three.
    const probe = new PicturePlans(list);
    await presentPictures("m0", MAIL, undefined, probe);
    const small = new PicturePlans(list, { maxKeptChars: Math.floor(probe.keptChars * 2.5) });
    await presentPictures("m1", MAIL, undefined, small);
    await presentPictures("m2", `${MAIL}<p>2</p>`, undefined, small);
    await presentPictures("m3", `${MAIL}<p>3</p>`, undefined, small);
    assert.equal(small.work.rewrites, 3);
    await presentPictures("m1", MAIL, undefined, small); // pushed out by the size bound: written again
    assert.equal(small.work.rewrites, 4);
    await presentPictures("m3", `${MAIL}<p>3</p>`, undefined, small);
    assert.equal(small.work.rewrites, 4);
  });

  test("what is kept is counted honestly: a plan's addresses count, as the served HTML does", async () => {
    const urls = Array.from({ length: 250 }, (_, i) => `https://n.example/${"x".repeat(200)}/${i}.png`);
    const html = sanitizeHtml(urls.map((url) => `<img src="${url}" alt="">`).join(""))!;
    const counted = new PicturePlans(list);
    await shownPictureUrl("m1", html, "none", undefined, counted);
    assert.ok(counted.keptChars >= urls.join("").length, `a plan alone keeps ${counted.keptChars} characters`);
    const served = (await presentPictures("m1", html, undefined, counted)).html;
    assert.ok(counted.keptChars >= urls.join("").length + served.length);
  });

  test(`a long thread of large mail doesn't thrash what is kept: ${MAX_KEPT_CHARS} characters`, async () => {
    // Twenty messages of 1,000,000 characters each (the most one may have) fit, twice over the round.
    const big = (i: number) => `<p>${i}</p>${"<p>word word word</p>".repeat(Math.floor(990_000 / 20))}`;
    const shared = new PicturePlans(list);
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 20; i++) await presentPictures(`m${i}`, big(i), undefined, shared);
    }
    assert.equal(shared.work.rewrites, 20);
    assert.ok(MAX_KEPT_CHARS >= 20 * 1_000_000);
  });

  test("a declaration loading more than 100 addresses goes unread: no tracker matched, nothing fetched", async () => {
    const urls = Array.from({ length: 30_000 }, (_, i) => `url(https://n.example/${i})`).join(",");
    const html = `<div style="background:${urls};color:red">x</div>`;
    const counted = plans();
    const out = await presentPictures("m1", html, undefined, counted);
    assert.equal(out.html, `<div style="color:red">x</div>`);
    assert.equal(counted.work.matches, 0);
  });

  test(`examines at most ${MAX_EXAMINED_ADDRESSES} different addresses of a message; the rest are left out unfetched`, async () => {
    const many = sanitizeHtml(Array.from({ length: 2_000 }, (_, i) => `<img src="https://n.example/${i}" alt="${i}">`).join(""))!;
    const counted = plans();
    const { html, remotePictures } = await presentPictures("m1", many, undefined, counted);
    assert.equal(counted.work.matches, MAX_EXAMINED_ADDRESSES);
    assert.equal(remotePictures?.shown, 100);
    assert.equal(html.match(/src="\/v1\//g)?.length, 100);
    assert.equal(await shownPictureUrl("m1", many, await pictureId("https://n.example/1999"), undefined, counted), null);
  });

  test("a picture's id is its address's SHA-256, cut to 22 base64url characters", async () => {
    const id = await pictureId("https://news.example/hero.png");
    assert.match(id, /^[\w-]{22}$/);
    assert.equal(id, await pictureId("https://news.example/hero.png"));
    assert.notEqual(id, await pictureId("https://news.example/hero.png?x"));
  });
});

describe("the shipped tracker list", () => {
  test("names its source, carries its licence, and every pattern compiles", () => {
    assert.equal(shipped.source.name, "MailTrackerBlocker");
    assert.match(shipped.source.commit, /^[0-9a-f]{40}$/);
    assert.equal(shipped.source.license, "BSD-3-Clause");
    assert.match(shipped.source.licenseText, /Copyright \(c\) 2020, Aaron Lee/);
    assert.equal(shipped.match("about:blank"), null); // compiles every pattern
  });

  test("knows common trackers and leaves ordinary pictures alone", () => {
    assert.equal(shipped.match("https://simg.1und1.de/x.gif"), "1&1");
    assert.equal(shipped.match("https://emltrk.com/v2/abc"), "Litmus");
    for (const url of ["https://news.example/hero.png", "https://images.example/logo.png?v=2", "https://example.com/wp-content/uploads/2026/11/photo.jpg"]) {
      assert.equal(shipped.match(url), null, url);
    }
  });
});
