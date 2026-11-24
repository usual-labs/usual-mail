// What every host's picture source keeps, and how it judges the bytes it fetched (docs/contract-pictures.md): the
// limits on what is kept, when a failing site is asked again, the blank picture served for a refused one, and the
// check that the bytes are a picture the server shows. Node keeps pictures on disk (`src/node/pictures/cache.ts`),
// Cloudflare in its object's SQLite (`src/cloudflare/web/pictures.ts`); both follow these.

import type { WebPicture } from "../host.ts";
import { PictureRefused } from "./refused.ts";
import { sniffPicture, tooLarge } from "./sniff.ts";

/** Pictures: at most 256 MB in all (the least recently served go first), nothing unserved for 30 days, six fetched at once. */
export const CACHE_LIMITS = {
  maxBytes: 256 * 1024 * 1024,
  maxIdleMs: 30 * 24 * 60 * 60_000,
  concurrency: 6,
};

/** Records of refusals and failures: how many are kept, and for how long unserved. */
export const RECORD_LIMITS = { count: 50_000, maxIdleMs: 365 * 24 * 60 * 60_000 };

/** When a failed picture is tried again: after the first failure, and after the second. A third is final. */
export const RETRY_AFTER_MS = [10 * 60_000, 24 * 60 * 60_000];

/** A 1×1 transparent GIF, served in place of a refused picture and of a fetched one of at most 2×2 pixels. */
export const TRANSPARENT_GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
export const BLANK: WebPicture = { mimeType: "image/gif", data: TRANSPARENT_GIF };

/** The types a kept picture may have. */
export const KEPT_TYPES = /^image\/(?:png|jpeg|gif|webp|avif)$/;

/** The picture the bytes are, as served: a real PNG, JPEG, GIF, WebP or AVIF of a sane size; tiny ones blanked. */
export function checkedPicture(bytes: Uint8Array): WebPicture {
  const facts = sniffPicture(bytes);
  if (!facts) throw new PictureRefused("it isn't a picture the server shows (PNG, JPEG, GIF, WebP or AVIF)", "refused");
  const large = tooLarge(facts);
  if (large) throw new PictureRefused(large, "refused");
  // A picture of at most 2×2 shows nothing; served blank, it keeps the page as it was.
  if (facts.width <= 2 && facts.height <= 2) return BLANK;
  return { mimeType: facts.mimeType, data: bytes };
}
