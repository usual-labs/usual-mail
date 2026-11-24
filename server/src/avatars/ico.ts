// Icon files (ICO, the format of /favicon.ico): a directory of images, each a whole PNG or a BMP without its file
// header (its info header, a colour table for 1, 4 or 8 bits, colours bottom-up, then a 1-bit AND mask saying which
// pixels are transparent). The server takes the largest image and serves it as a PNG: an embedded PNG as it is, a BMP
// converted to a PNG the server writes itself, so no client ever decodes a sender's BMP. Only what an icon uses is read
// (BI_RGB at 1, 4, 8, 24 or 32 bits, at most 256 pixels a side, at most 64 images); sizes come from the images
// themselves, never the directory, which may lie; anything that doesn't add up is skipped.

import { sniffPicture } from "../pictures/sniff.ts";
import { encodePng } from "./png.ts";

/** The most images a directory may list, the largest side of a BMP image, and of an embedded PNG. */
export const ICO_LIMITS = { images: 64, bmpSide: 256, pngSide: 1_024 };

export interface IconImage {
  /** A PNG. */
  data: Uint8Array;
  width: number;
  height: number;
}

const le16 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const le32 = (b: Uint8Array, at: number): number => (le16(b, at) + le16(b, at + 2) * 0x10000);
const i32 = (b: Uint8Array, at: number): number => le32(b, at) | 0;

/** Whether the bytes start like an icon file: reserved zero, type 1 (not a cursor), at least one image. */
export function isIco(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && le16(bytes, 0) === 0 && le16(bytes, 2) === 1 && le16(bytes, 4) >= 1;
}

interface Entry {
  data: Uint8Array;
  png: boolean;
  width: number;
  height: number;
  bpp: number;
}

/** The icon file's largest image as a PNG, or null when it holds none the server can read. */
export async function pngFromIco(bytes: Uint8Array): Promise<IconImage | null> {
  if (!isIco(bytes)) return null;
  const count = le16(bytes, 4);
  const directoryEnd = 6 + 16 * count;
  if (count > ICO_LIMITS.images || directoryEnd > bytes.length) return null;
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    const size = le32(bytes, at + 8);
    const offset = le32(bytes, at + 12);
    if (size < 12 || offset < directoryEnd || offset + size > bytes.length) continue;
    const entry = inspect(bytes.subarray(offset, offset + size));
    if (entry) entries.push(entry);
  }
  // The largest, by its shorter side then its longer; a PNG before a BMP; more bits first.
  entries.sort((a, b) =>
    Math.min(b.width, b.height) - Math.min(a.width, a.height) ||
    Math.max(b.width, b.height) - Math.max(a.width, a.height) ||
    Number(b.png) - Number(a.png) ||
    b.bpp - a.bpp);
  for (const entry of entries) {
    if (entry.png) return { data: entry.data.slice(), width: entry.width, height: entry.height };
    const pixels = decodeBmp(entry.data);
    if (pixels) return { data: await encodePng(pixels.rgba, pixels.width, pixels.height), width: pixels.width, height: pixels.height };
  }
  return null;
}

/** What one image is, read from its own bytes, or null when it isn't one the server reads. */
function inspect(data: Uint8Array): Entry | null {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    const facts = sniffPicture(data);
    if (facts?.mimeType !== "image/png" || facts.width > ICO_LIMITS.pngSide || facts.height > ICO_LIMITS.pngSide) return null;
    return { data, png: true, width: facts.width, height: facts.height, bpp: 32 };
  }
  const header = bmpHeader(data);
  return header && { data, png: false, width: header.width, height: header.height, bpp: header.bpp };
}

interface BmpHeader {
  width: number;
  height: number;
  bpp: number;
  /** Where the colours start, after the info header and the colour table. */
  pixels: number;
  colors: number;
  stride: number;
  maskStride: number;
}

/** A BMP image's info header, checked: its colours must all be in the data; its AND mask may be missing. */
function bmpHeader(data: Uint8Array): BmpHeader | null {
  if (data.length < 40) return null;
  const size = le32(data, 0);
  if (size !== 40 && size !== 52 && size !== 56 && size !== 108 && size !== 124) return null;
  const width = i32(data, 4);
  const doubled = i32(data, 8);
  const bpp = le16(data, 14);
  const compression = le32(data, 16);
  const used = le32(data, 32);
  if (width < 1 || width > ICO_LIMITS.bmpSide) return null;
  // The height counts the colours and the AND mask: twice the image's. Negative (top-down) isn't an icon's.
  if (doubled < 2 || doubled % 2 !== 0 || doubled / 2 > ICO_LIMITS.bmpSide) return null;
  if (bpp !== 1 && bpp !== 4 && bpp !== 8 && bpp !== 24 && bpp !== 32) return null;
  if (compression !== 0) return null;
  if (used > (bpp <= 8 ? 2 ** bpp : 256)) return null;
  const colors = bpp <= 8 ? used || 2 ** bpp : used;
  const height = doubled / 2;
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const pixels = size + colors * 4;
  if (pixels + stride * height > data.length) return null;
  return { width, height, bpp, pixels, colors, stride, maskStride: Math.floor((width + 31) / 32) * 4 };
}

/** A BMP image's pixels as RGBA from the top, or null when its header doesn't hold. */
function decodeBmp(data: Uint8Array): { rgba: Uint8Array; width: number; height: number } | null {
  const header = bmpHeader(data);
  if (!header) return null;
  const { width, height, bpp, pixels, colors, stride, maskStride } = header;
  const tableStart = pixels - colors * 4;
  const maskStart = pixels + stride * height;
  const hasMask = maskStart + maskStride * height <= data.length;
  const rgba = new Uint8Array(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = pixels + (height - 1 - y) * stride; // bottom-up
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (bpp === 32) {
        const at = row + x * 4;
        rgba[out] = data[at + 2]!;
        rgba[out + 1] = data[at + 1]!;
        rgba[out + 2] = data[at]!;
        rgba[out + 3] = data[at + 3]!;
        if (data[at + 3]) anyAlpha = true;
      } else if (bpp === 24) {
        const at = row + x * 3;
        rgba[out] = data[at + 2]!;
        rgba[out + 1] = data[at + 1]!;
        rgba[out + 2] = data[at]!;
      } else {
        const bit = x * bpp;
        const index = (data[row + (bit >> 3)]! >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        if (index < colors) {
          const at = tableStart + index * 4;
          rgba[out] = data[at + 2]!;
          rgba[out + 1] = data[at + 1]!;
          rgba[out + 2] = data[at]!;
        } // else black: an index past the table names no colour
      }
    }
  }
  // Transparency: a 32-bit image's own alpha when it has any; otherwise the AND mask (a set bit is transparent), and
  // opaque when there is no mask.
  if (bpp !== 32 || !anyAlpha) {
    for (let y = 0; y < height; y++) {
      const row = maskStart + (height - 1 - y) * maskStride;
      for (let x = 0; x < width; x++) {
        const clear = hasMask && ((data[row + (x >> 3)]! >> (7 - (x & 7))) & 1) === 1;
        rgba[(y * width + x) * 4 + 3] = clear ? 0 : 255;
      }
    }
  }
  return { rgba, width, height };
}
