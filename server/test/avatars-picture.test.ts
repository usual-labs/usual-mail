// What may be a sender's picture: a still PNG, JPEG or WebP (an icon file converted to PNG), of at least 16 pixels a
// side and at most 2048, roughly square, at most 1 MB. SVG, GIF, AVIF, anything that moves, and anything that isn't a
// picture are refused for good (the `refused` kind), so the domain isn't asked for it again. Made-up pictures only.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AVATAR_LIMITS, avatarPicture, isAnimatedPng, isAnimatedWebp } from "../src/avatars/picture.ts";
import { PictureRefused } from "../src/pictures/refused.ts";
import { avif, gif, jpeg, webp } from "./picture-hosts.ts";
import { chunk, dib, icoFile, pngFile, readPng, webpExtended, webpWithFrame } from "./avatar-pictures.ts";

const refused = async (bytes: Uint8Array, words: RegExp) =>
  assert.rejects(avatarPicture(bytes), (error: unknown) => {
    assert.ok(error instanceof PictureRefused, String(error));
    assert.equal(error.kind, "refused");
    assert.match(error.message, words);
    return true;
  });

describe("a sender's picture that may be kept", () => {
  test("a still PNG, JPEG or WebP, as it is", async () => {
    const png = pngFile(64, 64);
    assert.deepEqual(await avatarPicture(png), { mimeType: "image/png", data: png, width: 64, height: 64 });
    assert.deepEqual(await avatarPicture(jpeg(180, 180)), { mimeType: "image/jpeg", data: jpeg(180, 180), width: 180, height: 180 });
    assert.deepEqual(await avatarPicture(webp(192, 192)), { mimeType: "image/webp", data: webp(192, 192), width: 192, height: 192 });
    assert.equal((await avatarPicture(webpExtended(512, 512, false))).mimeType, "image/webp");
  });

  test("an icon file, as the PNG the server writes from it", async () => {
    const ico = icoFile([{ data: dib({ width: 32, height: 32, bpp: 32, pixel: () => [1, 2, 3, 255] }), width: 32, height: 32 }]);
    const out = await avatarPicture(ico);
    assert.equal(out.mimeType, "image/png");
    assert.equal(out.width, 32);
    assert.equal(readPng(out.data).pixels[0]![0]![2], 3);
  });

  test("at the edges of the limits", async () => {
    assert.ok(await avatarPicture(pngFile(16, 16)));
    assert.ok(await avatarPicture(jpeg(2048, 1024)));
    assert.ok(await avatarPicture(jpeg(100, 200)));
  });
});

describe("what is refused for good", () => {
  test("SVG, HTML, text and anything else that isn't a picture", async () => {
    await refused(new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`), /PNG, JPEG, WebP or ICO/);
    await refused(new TextEncoder().encode("<!doctype html><html><head></head></html>"), /PNG, JPEG, WebP or ICO/);
    await refused(new Uint8Array(100), /PNG, JPEG, WebP or ICO/);
    await refused(new Uint8Array(), /PNG, JPEG, WebP or ICO/);
  });

  test("GIF and AVIF", async () => {
    await refused(gif(64, 64), /GIF/);
    await refused(avif(64, 64), /AVIF/);
  });

  test("an icon file holding nothing the server reads", async () => {
    await refused(icoFile([{ data: new Uint8Array(64), width: 16, height: 16 }]), /icon file/);
  });

  test("anything that moves: an animated PNG, or a WebP with frames, flagged or not", async () => {
    const actl = new Uint8Array(8);
    new DataView(actl.buffer).setUint32(0, 2);
    await refused(pngFile(64, 64, { before: [chunk("acTL", actl)] }), /moves/);
    await refused(webpExtended(64, 64, true), /moves/);
    await refused(webpWithFrame(64, 64), /moves/);
    // An icon file's embedded PNG is checked as well.
    await refused(icoFile([{ data: pngFile(64, 64, { before: [chunk("acTL", actl)] }), width: 64, height: 64 }]), /moves/);
  });

  test("a PNG whose chunks can't be read up to its image data", async () => {
    const png = pngFile(64, 64);
    await refused(png.subarray(0, 40), /can't be read/);
    const lying = png.slice();
    new DataView(lying.buffer).setUint32(33, 0x7fffffff); // the chunk after IHDR claims 2 GB
    await refused(lying, /can't be read/);
  });

  test("too small, too large, too far from square, or too many bytes", async () => {
    await refused(pngFile(15, 15), /too small/);
    await refused(jpeg(2049, 2049), /too large/);
    await refused(jpeg(2048, 2048 * 2), /too large/);
    await refused(jpeg(300, 100), /square/);
    const big = new Uint8Array(AVATAR_LIMITS.maxBytes + 1);
    big.set(pngFile(64, 64));
    await refused(big, /larger than 1 MB/);
  });
});

describe("telling a picture that moves", () => {
  test("a PNG moves when an animation control chunk comes before its image data", () => {
    const actl = new Uint8Array(8);
    assert.equal(isAnimatedPng(pngFile(16, 16)), false);
    assert.equal(isAnimatedPng(pngFile(16, 16, { before: [chunk("tEXt", new TextEncoder().encode("a\0b")), chunk("acTL", actl)] })), true);
    assert.equal(isAnimatedPng(pngFile(16, 16).subarray(0, 30)), null, "can't tell");
  });

  test("reads a PNG of thousands of small chunks in bounded steps", () => {
    const many = Array.from({ length: 5_000 }, () => chunk("tEXt", new Uint8Array(1)));
    assert.equal(isAnimatedPng(pngFile(16, 16, { before: many })), null, "too many chunks to read is no answer");
  });

  test("a WebP moves by its flag or by its frames", () => {
    assert.equal(isAnimatedWebp(webp(16, 16)), false);
    assert.equal(isAnimatedWebp(webpExtended(16, 16, true)), true);
    assert.equal(isAnimatedWebp(webpWithFrame(16, 16)), true);
  });
});
