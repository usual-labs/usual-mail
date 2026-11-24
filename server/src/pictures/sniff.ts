// What a picture really is, read from its own bytes, never from what its site says: PNG, JPEG, GIF, WebP or AVIF,
// with its width and height. Anything else (SVG, HTML, scripts, other formats) isn't a picture the server serves.
// The size is the one a decoder will use (the security review of 2026-11-18): for a GIF the largest frame where it
// sits, read to the GIF's end; for an AVIF the largest image size among its item properties, its boxes read whole.

export interface PictureFacts {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif";
  width: number;
  height: number;
}

/** The most pixels a picture may have, so a small file can't make a client decode a huge one. */
export const MAX_PIXELS = 40_000_000;
/** The longest side a picture may have. */
export const MAX_SIDE = 20_000;
/** The most frames a GIF may have, and the most boxes an AVIF, before it is refused unread. */
const MAX_PARTS = 2_000;

const ascii = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + length));
const be16 = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const le16 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const le24 = (b: Uint8Array, at: number): number => le16(b, at) | ((b[at + 2] ?? 0) << 16);
const be32 = (b: Uint8Array, at: number): number => ((be16(b, at) << 16) >>> 0) + be16(b, at + 2);

/** The type and size the bytes have, or null when they aren't one of the five kinds or can't be read. */
export function sniffPicture(bytes: Uint8Array): PictureFacts | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 7) === "PNG\r\n\x1a\n" && ascii(bytes, 12, 4) === "IHDR") {
    return facts("image/png", be32(bytes, 16), be32(bytes, 20));
  }
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return gif(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webp(bytes);
  // An AVIF image sequence ("avis") isn't served: its frames' size is in its track, which a still's reader doesn't see.
  if (ascii(bytes, 4, 4) === "ftyp" && ascii(bytes, 8, 4) === "avif") return avif(bytes);
  return null;
}

function facts(mimeType: PictureFacts["mimeType"], width: number, height: number): PictureFacts | null {
  return width > 0 && height > 0 ? { mimeType, width, height } : null;
}

/** A JPEG's size, from its first start-of-frame segment. */
function jpeg(bytes: Uint8Array): PictureFacts | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    // Start of frame: C0 to CF, except C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return facts("image/jpeg", be16(bytes, at + 7), be16(bytes, at + 5));
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    at += 2 + be16(bytes, at + 2);
  }
  return null;
}

/** A WebP's size, from its first chunk: lossy (VP8), lossless (VP8L) or extended (VP8X). */
function webp(bytes: Uint8Array): PictureFacts | null {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return facts("image/webp", le16(bytes, 26) & 0x3fff, le16(bytes, 28) & 0x3fff);
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
    return facts("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X" && bytes.length >= 30) return facts("image/webp", le24(bytes, 24) + 1, le24(bytes, 27) + 1);
  return null;
}

/**
 * A GIF's size: its logical screen, grown to every frame's far edge (decoders size their canvas by the frames).
 * Every block is read, up to the trailer; one that runs past the end, or an unknown one, means it isn't a picture.
 * A GIF without its trailer (common) is one when its last block ends exactly where the data ends.
 */
function gif(bytes: Uint8Array): PictureFacts | null {
  let width = le16(bytes, 6);
  let height = le16(bytes, 8);
  const table = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  /** Skips data sub-blocks from `at` to their terminator; -1 when they run past the end. */
  const blocks = (at: number): number => {
    let i = at;
    for (;;) {
      const size = bytes[i];
      if (size === undefined) return -1;
      i += 1;
      if (size === 0) return i;
      i += size;
    }
  };
  let at = 13 + table(bytes[10] ?? 0);
  let frames = 0;
  for (;;) {
    const kind = bytes[at];
    // The trailer, or the data's end right after a whole block (`at` never passes the end: see below).
    if (kind === 0x3b || kind === undefined) break;
    if (kind === 0x21) {
      if (at + 2 > bytes.length) return null;
      at = blocks(at + 2);
    } else if (kind === 0x2c) {
      if (at + 10 > bytes.length || ++frames > MAX_PARTS) return null;
      width = Math.max(width, le16(bytes, at + 1) + le16(bytes, at + 5));
      height = Math.max(height, le16(bytes, at + 3) + le16(bytes, at + 7));
      at = blocks(at + 10 + table(bytes[at + 9]!) + 1);
    } else {
      return null;
    }
    if (at < 0 || at > bytes.length) return null;
  }
  return frames > 0 ? facts("image/gif", width, height) : null;
}

/**
 * An AVIF's size: the largest of its image spatial extents (`ispe`) properties, found by reading its boxes as a
 * decoder does (meta, then iprp, then ipco). Boxes that don't add up mean it isn't a picture, and so does a movie
 * box: that is an image sequence, whatever its file type says.
 */
function avif(bytes: Uint8Array): PictureFacts | null {
  let width = 0;
  let height = 0;
  let boxes = 0;
  const walk = (start: number, end: number): boolean => {
    let at = start;
    while (at < end) {
      if (at + 8 > end || ++boxes > MAX_PARTS) return false;
      let size = be32(bytes, at);
      const type = ascii(bytes, at + 4, 4);
      let header = 8;
      if (size === 1) {
        if (at + 16 > end) return false;
        size = be32(bytes, at + 8) * 2 ** 32 + be32(bytes, at + 12);
        header = 16;
      } else if (size === 0) {
        size = end - at;
      }
      if (size < header || at + size > end) return false;
      const content = at + header;
      if (type === "moov") return false;
      if (type === "meta") {
        if (!walk(content + 4, at + size)) return false; // a full box: version and flags first
      } else if (type === "iprp" || type === "ipco") {
        if (!walk(content, at + size)) return false;
      } else if (type === "ispe") {
        if (size < header + 12) return false;
        width = Math.max(width, be32(bytes, content + 4));
        height = Math.max(height, be32(bytes, content + 8));
      }
      at += size;
    }
    return true;
  };
  if (!walk(0, bytes.length)) return null;
  return facts("image/avif", width, height);
}

/** Why a picture of this size isn't served, or null when it may be. */
export function tooLarge(picture: PictureFacts): string | null {
  if (picture.width > MAX_SIDE || picture.height > MAX_SIDE || picture.width * picture.height > MAX_PIXELS) {
    return `it claims to be ${picture.width} × ${picture.height} pixels, more than a mail picture needs`;
  }
  return null;
}
