// What a picture is, read from its bytes the way a decoder reads them: the size a decoder will use is the one the
// pixel cap judges (every GIF frame, every AVIF image size), and what can't be read to its end isn't a picture.
// Made-up headers only.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sniffPicture, tooLarge } from "../src/pictures/sniff.ts";
import { avif, gif, jpeg, png, webp } from "./picture-hosts.ts";

describe("reading a picture's size", () => {
  test("each kind, as its decoder reads it", () => {
    assert.deepEqual(sniffPicture(png(40, 30)), { mimeType: "image/png", width: 40, height: 30 });
    assert.deepEqual(sniffPicture(jpeg(40, 30)), { mimeType: "image/jpeg", width: 40, height: 30 });
    assert.deepEqual(sniffPicture(gif(40, 30)), { mimeType: "image/gif", width: 40, height: 30 });
    assert.deepEqual(sniffPicture(webp(40, 30)), { mimeType: "image/webp", width: 40, height: 30 });
    assert.deepEqual(sniffPicture(avif(40, 30)), { mimeType: "image/avif", width: 40, height: 30 });
  });

  test("a GIF is as large as its largest frame, wherever it sits, not its logical screen", () => {
    const sneaky = gif(100, 100, [{ width: 10, height: 10 }, { width: 20_000, height: 20_000 }]);
    const facts = sniffPicture(sneaky)!;
    assert.deepEqual(facts, { mimeType: "image/gif", width: 20_000, height: 20_000 });
    assert.match(tooLarge(facts) ?? "", /20000 × 20000/);
    assert.deepEqual(sniffPicture(gif(100, 100, [{ left: 19_000, top: 0, width: 1_500, height: 10 }])), { mimeType: "image/gif", width: 20_500, height: 100 });
  });

  test("a GIF without its trailer is a picture when its last block ends where the data ends", () => {
    const whole = gif(40, 30, [{ width: 40, height: 30 }, { width: 40, height: 30 }]);
    assert.deepEqual(sniffPicture(whole.subarray(0, whole.length - 1)), { mimeType: "image/gif", width: 40, height: 30 });
  });

  test(`a GIF of more than 2,000 frames, or an AVIF of more than 2,000 boxes, isn't read`, () => {
    const frames = (n: number) => Array.from({ length: n }, () => ({ width: 1, height: 1 }));
    assert.ok(sniffPicture(gif(10, 10, frames(2_000))));
    assert.equal(sniffPicture(gif(10, 10, frames(2_001))), null);
    assert.ok(sniffPicture(avif(10, 10, Array.from({ length: 1_990 }, () => [10, 10] as [number, number]))));
    assert.equal(sniffPicture(avif(10, 10, Array.from({ length: 2_001 }, () => [10, 10] as [number, number]))), null);
  });

  test("an AVIF image sequence isn't a picture the server shows: its track may be any size", () => {
    assert.equal(sniffPicture(avif(16, 16, [], false, "avis")), null);
    assert.equal(sniffPicture(avif(16, 16, [], false, "avif", true)), null, "a movie box in an avif");
  });

  test("a GIF that can't be read to its end isn't a picture", () => {
    const whole = gif(40, 30, [{ width: 40, height: 30 }, { width: 40, height: 30 }]);
    assert.equal(sniffPicture(whole.subarray(0, 30)), null, "cut inside a frame");
    const one = gif(40, 30);
    assert.equal(sniffPicture(one.subarray(0, 34)), null, "a data block runs past the end");
    const garbage = Uint8Array.from([...whole.subarray(0, 13), 0x99, 0x3b]);
    assert.equal(sniffPicture(garbage), null, "an unknown block");
  });

  test("an AVIF is as large as its largest image size, and a decoy in its file type box counts for nothing", () => {
    assert.deepEqual(sniffPicture(avif(16, 16, [[16_384, 16_384]])), { mimeType: "image/avif", width: 16_384, height: 16_384 });
    const decoyed = sniffPicture(avif(16_384, 16_384, [], true))!;
    assert.deepEqual(decoyed, { mimeType: "image/avif", width: 16_384, height: 16_384 });
    assert.ok(tooLarge(decoyed));
  });

  test("an AVIF whose boxes don't add up isn't a picture", () => {
    const whole = avif(40, 30);
    assert.equal(sniffPicture(whole.subarray(0, whole.length - 4)), null, "a box runs past the end");
    const broken = Uint8Array.from(whole);
    new DataView(broken.buffer).setUint32(24, 3); // the meta box claims to be 3 bytes long
    assert.equal(sniffPicture(broken), null);
    const noSize = Uint8Array.from(avif(40, 30).subarray(0, 24));
    assert.equal(sniffPicture(noSize), null, "no image size at all");
  });
});
