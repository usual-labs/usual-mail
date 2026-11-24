// What may be kept and served as a sender's picture, judged from its own bytes: a still PNG, JPEG or WebP, or an icon
// file (ICO) converted to a PNG the server writes; at least 16 pixels a side (smaller says nothing at any size), at
// most 2048 and 4 million pixels, no more than twice as wide as tall or the other way round (a wordmark is no avatar),
// and at most 1 MB. SVG is never one, and neither are GIF, AVIF, or anything that moves (an animated PNG, a WebP with
// frames): an app draws a still. Each refusal is for good (`refused`): the same bytes would be refused again.

import { PictureRefused } from "../pictures/refused.ts";
import { sniffPicture } from "../pictures/sniff.ts";
import { isIco, pngFromIco } from "./ico.ts";

export const AVATAR_LIMITS = { maxBytes: 1_048_576, minSide: 16, maxSide: 2_048, maxPixels: 4_194_304, maxAspect: 2 };

export interface AvatarPicture {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: Uint8Array;
  width: number;
  height: number;
}

const refuse = (words: string): never => {
  throw new PictureRefused(words, "refused");
};

/** The picture to keep for these bytes, or a `PictureRefused` of kind `refused` saying why not. */
export async function avatarPicture(bytes: Uint8Array): Promise<AvatarPicture> {
  if (bytes.length > AVATAR_LIMITS.maxBytes) refuse("it is larger than 1 MB");
  let data = bytes;
  let facts = sniffPicture(bytes);
  if (!facts && isIco(bytes)) {
    const converted = await pngFromIco(bytes);
    if (!converted) refuse("its icon file holds no picture the server can read");
    data = converted!.data;
    facts = sniffPicture(data);
  }
  if (!facts) return refuse("it isn't a PNG, JPEG, WebP or ICO picture");
  if (facts.mimeType === "image/gif" || facts.mimeType === "image/avif") return refuse("GIF and AVIF pictures aren't used for a sender");
  if (facts.mimeType === "image/png") {
    const moves = isAnimatedPng(data);
    if (moves === null) refuse("its PNG chunks can't be read");
    if (moves) refuse("it moves");
  }
  if (facts.mimeType === "image/webp" && isAnimatedWebp(data)) refuse("it moves");
  const { width, height } = facts;
  if (Math.min(width, height) < AVATAR_LIMITS.minSide) refuse(`it is too small (${width} × ${height} pixels)`);
  if (Math.max(width, height) > AVATAR_LIMITS.maxSide || width * height > AVATAR_LIMITS.maxPixels) {
    refuse(`it is too large (${width} × ${height} pixels)`);
  }
  if (Math.max(width, height) > AVATAR_LIMITS.maxAspect * Math.min(width, height)) refuse("it is too far from square");
  return { mimeType: facts.mimeType, data, width, height };
}

/** The most chunks read before giving up on an answer. */
const MAX_CHUNKS = 1_000;

const be32 = (b: Uint8Array, at: number): number => (((b[at] ?? 0) << 24) >>> 0) + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0));
const le32 = (b: Uint8Array, at: number): number => ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16)) + (b[at + 3] ?? 0) * 0x1000000;
const type = (b: Uint8Array, at: number): string => String.fromCharCode(...b.subarray(at, at + 4));

/**
 * Whether a PNG moves: an animation control chunk (APNG's acTL) before its first image data, as decoders read it.
 * Null when its chunks can't be read that far, or there are too many to read.
 */
export function isAnimatedPng(bytes: Uint8Array): boolean | null {
  let at = 8;
  for (let chunks = 0; chunks < MAX_CHUNKS; chunks++) {
    if (at + 8 > bytes.length) return null;
    const length = be32(bytes, at);
    const kind = type(bytes, at + 4);
    if (at + 12 + length > bytes.length) return null;
    if (kind === "acTL") return true;
    if (kind === "IDAT") return false;
    at += 12 + length;
  }
  return null;
}

/** Whether a WebP moves: its extended header's animation flag, or any animation or frame chunk. */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (type(bytes, 12) === "VP8X" && ((bytes[20] ?? 0) & 0x02) !== 0) return true;
  let at = 12;
  for (let chunks = 0; chunks < MAX_CHUNKS && at + 8 <= bytes.length; chunks++) {
    const kind = type(bytes, at);
    if (kind === "ANIM" || kind === "ANMF") return true;
    const size = le32(bytes, at + 4);
    at += 8 + size + (size % 2);
  }
  return false;
}
