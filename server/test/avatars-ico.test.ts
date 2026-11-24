// Icon files (favicon.ico): the server reads their directory, picks the largest image, and serves it as a PNG it
// writes itself: an embedded PNG as it is, a BMP image (1, 4, 8, 24 or 32 bits, with its AND mask) converted. Hostile
// files (a directory that lies, images outside the file, sizes beyond an icon's, odd formats) give nothing rather than
// a picture or a crash. Made-up files only.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isIco, pngFromIco } from "../src/avatars/ico.ts";
import { encodePng } from "../src/avatars/png.ts";
import { dib, icoFile, pngFile, readPng, type Rgba } from "./avatar-pictures.ts";

const RED: Rgba = [200, 10, 20, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

describe("the PNG the server writes", () => {
  test("is a valid RGBA PNG holding exactly the pixels given", async () => {
    const pixels = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const png = readPng(await encodePng(pixels, 3, 2));
    assert.equal(png.width, 3);
    assert.equal(png.height, 2);
    assert.deepEqual(png.pixels, [[[255, 0, 0, 255], [0, 255, 0, 128], [0, 0, 255, 0]], [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]]);
  });

  test("refuses pixels that don't match the size", async () => {
    await assert.rejects(encodePng(new Uint8Array(10), 2, 2), /pixels/);
    await assert.rejects(encodePng(new Uint8Array(0), 0, 0), /pixels/);
  });
});

describe("telling an icon file", () => {
  test("by its header: reserved zero, type 1, at least one image", () => {
    const one = icoFile([{ data: pngFile(16, 16), width: 16, height: 16 }]);
    assert.equal(isIco(one), true);
    assert.equal(isIco(pngFile(16, 16)), false);
    assert.equal(isIco(icoFile([{ data: pngFile(16, 16), width: 16, height: 16 }], { type: 2 })), false, "a cursor");
    assert.equal(isIco(icoFile([], { count: 0 })), false);
    assert.equal(isIco(Uint8Array.from([0, 0, 1])), false);
  });
});

describe("an icon's image as a PNG", () => {
  test("an embedded PNG is served as it is", async () => {
    const inner = pngFile(32, 32, { color: RED });
    const out = await pngFromIco(icoFile([{ data: inner, width: 32, height: 32 }]));
    assert.deepEqual(out, { data: inner, width: 32, height: 32 });
  });

  test("a 32-bit BMP keeps its own transparency", async () => {
    const data = dib({ width: 2, height: 2, bpp: 32, pixel: (x, y) => (x === y ? RED : [0, 0, 255, 100]) });
    const out = (await pngFromIco(icoFile([{ data, width: 2, height: 2 }])))!;
    assert.deepEqual(readPng(out.data).pixels, [[RED, [0, 0, 255, 100]], [[0, 0, 255, 100], RED]]);
  });

  test("a 32-bit BMP without any alpha takes its transparency from the AND mask", async () => {
    const data = dib({ width: 2, height: 1, bpp: 32, pixel: () => [9, 8, 7, 0], transparent: (x) => x === 1 });
    const out = (await pngFromIco(icoFile([{ data, width: 2, height: 1 }])))!;
    assert.deepEqual(readPng(out.data).pixels, [[[9, 8, 7, 255], [9, 8, 7, 0]]]);
  });

  test("24-bit, 8-bit, 4-bit and 1-bit BMPs, rows padded and stored bottom-up, with their AND masks", async () => {
    const palette: Array<[number, number, number]> = [[0, 0, 0], [255, 255, 255], [200, 10, 20], [1, 2, 3]];
    const index = (x: number, y: number): Rgba => [(x + y) % 2, 0, 0, 0];
    const colour = (x: number, y: number): Rgba => [...palette[(x + y) % 2]!, 255] as Rgba;
    const hole = (x: number, y: number) => x === 2 && y === 1;
    for (const bpp of [1, 4, 8, 24] as const) {
      const ownPalette = bpp === 24 ? undefined : palette.slice(0, 2 ** bpp);
      const data = dib({ width: 5, height: 3, bpp, palette: ownPalette, pixel: bpp === 24 ? colour : index, transparent: hole });
      const out = (await pngFromIco(icoFile([{ data, width: 5, height: 3 }])))!;
      assert.equal(out.width, 5, `${bpp} bits`);
      assert.equal(out.height, 3, `${bpp} bits`);
      const expected = Array.from({ length: 3 }, (_, y) => Array.from({ length: 5 }, (_, x) => (hole(x, y) ? ([...colour(x, y).slice(0, 3), 0] as Rgba) : colour(x, y))));
      assert.deepEqual(readPng(out.data).pixels, expected, `${bpp} bits`);
    }
  });

  test("a BMP without an AND mask is opaque, and a palette index past the palette's end is black", async () => {
    const data = dib({ width: 2, height: 1, bpp: 8, palette: [[5, 5, 5]], pixel: (x) => [x === 0 ? 0 : 200, 0, 0, 0], noMask: true });
    const out = (await pngFromIco(icoFile([{ data, width: 2, height: 1 }])))!;
    assert.deepEqual(readPng(out.data).pixels, [[[5, 5, 5, 255], [0, 0, 0, 255]]]);
  });

  test("the largest image is taken, a PNG before a BMP of the same size", async () => {
    const small = dib({ width: 16, height: 16, bpp: 32, pixel: () => RED });
    const large = dib({ width: 48, height: 48, bpp: 32, pixel: () => RED });
    const png32 = pngFile(32, 32);
    const out = (await pngFromIco(icoFile([{ data: small, width: 16, height: 16 }, { data: large, width: 48, height: 48 }, { data: png32, width: 32, height: 32 }])))!;
    assert.equal(out.width, 48);
    const bmp32 = dib({ width: 32, height: 32, bpp: 32, pixel: () => RED });
    const tie = (await pngFromIco(icoFile([{ data: bmp32, width: 32, height: 32 }, { data: png32, width: 32, height: 32 }])))!;
    assert.deepEqual(tie.data, png32);
  });

  test("sizes are read from the images themselves, not the directory, which may lie", async () => {
    const data = dib({ width: 64, height: 64, bpp: 32, pixel: () => RED });
    const out = (await pngFromIco(icoFile([{ data, width: 16, height: 16 }])))!;
    assert.equal(out.width, 64);
  });

  test("an unreadable image is skipped for the next one", async () => {
    const broken = dib({ width: 48, height: 48, bpp: 32, pixel: () => RED, header: { compression: 3 } });
    const good = dib({ width: 16, height: 16, bpp: 32, pixel: () => RED });
    const out = (await pngFromIco(icoFile([{ data: broken, width: 48, height: 48 }, { data: good, width: 16, height: 16 }])))!;
    assert.equal(out.width, 16);
  });
});

describe("hostile icon files give nothing", () => {
  const good = () => dib({ width: 16, height: 16, bpp: 32, pixel: () => RED });
  const nothing = async (bytes: Uint8Array, why: string) => assert.equal(await pngFromIco(bytes), null, why);

  test("a directory that doesn't fit, or images outside the file or over the directory", async () => {
    const file = icoFile([{ data: good(), width: 16, height: 16 }]);
    await nothing(file.subarray(0, 12), "the directory runs past the end");
    await nothing(icoFile([{ data: good(), width: 16, height: 16, offset: 6 }]), "the image starts inside the directory");
    await nothing(icoFile([{ data: good(), width: 16, height: 16, size: 1_000_000 }]), "the image runs past the end");
    await nothing(icoFile([{ data: good(), width: 16, height: 16, offset: 0xffffffff }]), "the image starts past the end");
    await nothing(icoFile([{ data: good(), width: 16, height: 16, size: 0 }]), "an empty image");
    await nothing(icoFile([{ data: good(), width: 16, height: 16 }], { count: 65_535 }), "a count far beyond its directory");
    await nothing(icoFile(Array.from({ length: 65 }, () => ({ data: good(), width: 16, height: 16 }))), "more than 64 images");
    await nothing(icoFile([], { count: 0 }), "no images");
  });

  test("an image placed over the directory, even one that would read as a picture there", async () => {
    // Two entries; the first points into the second, whose bytes start like a 16 × 16, 32-bit BMP header.
    const file = new Uint8Array(38 + 2_000);
    const view = new DataView(file.buffer);
    view.setUint16(2, 1, true);
    view.setUint16(4, 2, true);
    file.set([16, 16], 6);
    view.setUint32(6 + 8, 1_200, true);
    view.setUint32(6 + 12, 22, true); // inside the directory
    file.set([40, 0, 0, 0], 22); // the second entry: width 40, height 0, reading as a header size of 40
    view.setUint16(22 + 4, 16, true); // planes, reading as the width
    view.setUint32(22 + 8, 32, true); // size, reading as the doubled height
    view.setUint16(22 + 12, 1, true); // offset, reading as planes
    view.setUint16(22 + 14, 32, true); // ... and bits
    await nothing(file, "an image read from the directory's own bytes");
  });

  test("BMP headers that lie or use what an icon doesn't", async () => {
    const lies: DibLie[] = [
      { size: 12 }, // an OS/2 header
      { size: 200 },
      { width: 0 },
      { width: 1_000 }, // beyond an icon's 256
      { width: -16 },
      { height: -32 }, // top-down, not an icon's
      { height: 31 }, // odd: no room for a mask
      { height: 0 },
      { bpp: 16 },
      { bpp: 2 },
      { compression: 1 },
      { compression: 3 },
    ];
    for (const lie of lies) await nothing(icoFile([{ data: dib({ width: 16, height: 16, bpp: 32, pixel: () => RED, header: lie }), width: 16, height: 16 }]), JSON.stringify(lie));
    await nothing(icoFile([{ data: dib({ width: 4, height: 4, bpp: 4, palette: [[1, 1, 1]], pixel: () => CLEAR, header: { colorsUsed: 17 } }), width: 4, height: 4 }]), "more colours than 4 bits hold");
    const seventeen = Array.from({ length: 17 }, (): [number, number, number] => [1, 1, 1]);
    await nothing(icoFile([{ data: dib({ width: 4, height: 4, bpp: 4, palette: seventeen, pixel: () => CLEAR }), width: 4, height: 4 }]), "a whole table of more colours than 4 bits hold");
    await nothing(icoFile([{ data: dib({ width: 300, height: 1, bpp: 32, pixel: () => RED }), width: 0, height: 1 }]), "wider than an icon's 256, its colours all there");
    await nothing(icoFile([{ data: dib({ width: 4, height: 4, bpp: 24, pixel: () => RED, header: { colorsUsed: 1_000 } }), width: 4, height: 4 }]), "a huge colour table");
  });

  test("colour data cut short", async () => {
    const whole = dib({ width: 16, height: 16, bpp: 32, pixel: () => RED, noMask: true });
    await nothing(icoFile([{ data: whole.subarray(0, whole.length - 1), width: 16, height: 16 }]), "one byte short");
  });

  test("an embedded PNG of an absurd size, or one that isn't a PNG", async () => {
    const huge = pngFile(1, 1);
    new DataView(huge.buffer).setUint32(16, 100_000);
    await nothing(icoFile([{ data: huge, width: 0, height: 0 }]), "a PNG claiming 100000 pixels a side");
    const fake = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
    await nothing(icoFile([{ data: fake, width: 16, height: 16 }]), "a PNG signature and nothing else");
  });

  test("all in bounded time, even with many large images", async () => {
    const big = dib({ width: 256, height: 256, bpp: 32, pixel: () => RED });
    const file = icoFile(Array.from({ length: 64 }, () => ({ data: big, width: 0, height: 0 })));
    const started = Date.now();
    const out = await pngFromIco(file);
    assert.equal(out?.width, 256);
    assert.ok(Date.now() - started < 2_000);
  });
});

type DibLie = NonNullable<Parameters<typeof dib>[0]["header"]>;
