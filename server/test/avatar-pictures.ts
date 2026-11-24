// Made-up pictures for the avatar tests: whole PNGs (with their chunks and pixels, so the server's own PNGs can be read
// back), icon files with BMP or PNG images, and an animated WebP header. Built here, byte by byte; nothing is downloaded.

import { crc32, deflateSync, inflateSync } from "node:zlib";

export type Rgba = [number, number, number, number];

const ascii = (text: string) => new TextEncoder().encode(text);

function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** One PNG chunk with its length and CRC. */
export function chunk(type: string, data: Uint8Array = new Uint8Array()): Uint8Array {
  const body = concat(ascii(type), data);
  return concat(u32be(data.length), body, u32be(crc32(body)));
}

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A whole RGBA PNG of the given size, every pixel `color`, with any chunks given placed before its image data. */
export function pngFile(width: number, height: number, options: { color?: Rgba; before?: Uint8Array[] } = {}): Uint8Array {
  const color = options.color ?? [10, 20, 30, 255];
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(color, y * (width * 4 + 1) + 1 + x * 4);
  }
  return concat(SIGNATURE, chunk("IHDR", ihdr), ...(options.before ?? []), chunk("IDAT", deflateSync(raw)), chunk("IEND"));
}

/** Reads back an 8-bit RGBA PNG without interlacing whose rows all use filter 0, as the server writes them. */
export function readPng(bytes: Uint8Array): { width: number; height: number; pixels: Rgba[][] } {
  assertBytes(bytes.subarray(0, 8), SIGNATURE, "PNG signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  for (;;) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (view.getUint32(at + 8 + length) !== crc32(bytes.subarray(at + 4, at + 8 + length))) throw new Error(`bad CRC in ${type}`);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      assertBytes(data.subarray(8), Uint8Array.from([8, 6, 0, 0, 0]), "IHDR bit depth, colour type, methods");
    } else if (type === "IDAT") idat.push(data);
    at += 12 + length;
    if (type === "IEND") break;
  }
  if (at !== bytes.length) throw new Error("bytes after IEND");
  const raw = inflateSync(concat(...idat));
  if (raw.length !== (width * 4 + 1) * height) throw new Error("wrong amount of image data");
  const pixels: Rgba[][] = [];
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    if (raw[row] !== 0) throw new Error(`row ${y} uses filter ${raw[row]}`);
    pixels.push(Array.from({ length: width }, (_, x) => Array.from(raw.subarray(row + 1 + x * 4, row + 5 + x * 4)) as Rgba));
  }
  return { width, height, pixels };
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
  if (actual.length !== expected.length || actual.some((byte, i) => byte !== expected[i])) throw new Error(`not a ${what}`);
}

export interface DibOptions {
  width: number;
  height: number;
  bpp: 1 | 4 | 8 | 24 | 32;
  /** The colour of each pixel, from the top left. For 1, 4 and 8 bits, the palette index in the red place. */
  pixel: (x: number, y: number) => Rgba;
  /** The palette, for 1, 4 and 8 bits. */
  palette?: Array<[number, number, number]>;
  /** Whether a pixel is transparent in the AND mask; no mask is written when absent and `noMask` is set. */
  transparent?: (x: number, y: number) => boolean;
  noMask?: boolean;
  /** Overrides of header fields, to lie. */
  header?: Partial<{ size: number; width: number; height: number; planes: number; bpp: number; compression: number; colorsUsed: number }>;
}

/** An icon image as a BMP without its file header: the info header, palette, colours bottom-up, then the AND mask. */
export function dib(options: DibOptions): Uint8Array {
  const { width, height, bpp } = options;
  const palette = options.palette ?? [];
  const h = options.header ?? {};
  const header = new Uint8Array(40);
  const view = new DataView(header.buffer);
  view.setUint32(0, h.size ?? 40, true);
  view.setInt32(4, h.width ?? width, true);
  view.setInt32(8, h.height ?? height * 2, true);
  view.setUint16(12, h.planes ?? 1, true);
  view.setUint16(14, h.bpp ?? bpp, true);
  view.setUint32(16, h.compression ?? 0, true);
  view.setUint32(32, h.colorsUsed ?? (bpp <= 8 ? palette.length : 0), true);
  const table = new Uint8Array(palette.length * 4);
  palette.forEach(([r, g, b], i) => table.set([b, g, r, 0], i * 4));
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const colours = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const row = (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = options.pixel(x, y);
      if (bpp === 32) colours.set([b, g, r, a], row + x * 4);
      else if (bpp === 24) colours.set([b, g, r], row + x * 3);
      else {
        const bit = x * bpp;
        colours[row + (bit >> 3)]! |= r << (8 - bpp - (bit & 7));
      }
    }
  }
  const maskStride = Math.floor((width + 31) / 32) * 4;
  const mask = new Uint8Array(options.noMask ? 0 : maskStride * height);
  if (!options.noMask) {
    for (let y = 0; y < height; y++) {
      const row = (height - 1 - y) * maskStride;
      for (let x = 0; x < width; x++) if (options.transparent?.(x, y)) mask[row + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return concat(header, table, colours, mask);
}

export interface IconEntry {
  data: Uint8Array;
  /** What the directory says; 0 stands for 256. */
  width: number;
  height: number;
  /** Overrides, to lie. */
  size?: number;
  offset?: number;
}

/** An icon file: its header, its directory and its images. */
export function icoFile(entries: IconEntry[], options: { type?: number; count?: number } = {}): Uint8Array {
  const head = new Uint8Array(6 + 16 * entries.length);
  const view = new DataView(head.buffer);
  view.setUint16(2, options.type ?? 1, true);
  view.setUint16(4, options.count ?? entries.length, true);
  let offset = head.length;
  entries.forEach((entry, i) => {
    const at = 6 + 16 * i;
    head[at] = entry.width & 0xff;
    head[at + 1] = entry.height & 0xff;
    view.setUint16(at + 4, 1, true);
    view.setUint16(at + 6, 32, true);
    view.setUint32(at + 8, entry.size ?? entry.data.length, true);
    view.setUint32(at + 12, entry.offset ?? offset, true);
    offset += entry.data.length;
  });
  return concat(head, ...entries.map((entry) => entry.data));
}

/** An extended WebP header (VP8X) of the given size, with the animation flag set or not. */
export function webpExtended(width: number, height: number, animated: boolean): Uint8Array {
  const out = new Uint8Array(30);
  out.set(ascii("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, 22, true);
  out.set(ascii("WEBPVP8X"), 8);
  new DataView(out.buffer).setUint32(16, 10, true);
  out[20] = animated ? 0x02 : 0;
  const w = width - 1;
  const h = height - 1;
  out.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24);
  return out;
}

/** A lossy WebP followed by an animation frame chunk, without the extended header's flag saying so. */
export function webpWithFrame(width: number, height: number): Uint8Array {
  const vp8 = new Uint8Array(18);
  vp8.set([0x9d, 0x01, 0x2a], 3);
  new DataView(vp8.buffer).setUint16(6, width, true);
  new DataView(vp8.buffer).setUint16(8, height, true);
  const riffChunk = (type: string, data: Uint8Array) => {
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, data.length, true);
    return concat(ascii(type), size, data, data.length % 2 ? new Uint8Array(1) : new Uint8Array());
  };
  const body = concat(ascii("WEBP"), riffChunk("VP8 ", vp8), riffChunk("ANMF", new Uint8Array(16)));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, body.length, true);
  return concat(ascii("RIFF"), size, body);
}
