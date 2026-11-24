/**
 * Pictures from the web in sanitized mail HTML: finding them, and writing the HTML again with each one decided
 * (shown from a new address, held back, or taken out). Both run the sanitizer again with a `PictureHook`, so the
 * HTML that comes out is held to the same allow-list as when the message was read.
 */
import { sanitizeHtml } from "./sanitize.ts";
import type { PictureHook, RemotePicture } from "./picture-refs.ts";

export {
  canonicalPictureUrl,
  isTinyOrHidden,
  type PictureDecision,
  type PictureHook,
  type PictureSite,
  type RemotePicture,
} from "./picture-refs.ts";

/** Every picture the HTML takes from the web, in the order `rewritePictures` decides them (style blocks last). */
export function remotePictures(html: string): RemotePicture[] {
  const found: RemotePicture[] = [];
  sanitizeHtml(html, (picture) => {
    found.push(picture);
    return { kind: "hold" };
  });
  return found;
}

/**
 * The HTML with each picture from the web decided by `decide`, and fonts from the web taken out. Shown pictures
 * point at the address the decision gives (never one on the web); held-back ones lose their address, an `<img>`
 * keeping its place and alt text; removed `<img>` elements go whole. A CSS picture held back or removed becomes
 * `none`. Returns an empty string when nothing is left.
 */
export function rewritePictures(html: string, decide: PictureHook): string {
  return sanitizeHtml(html, decide) ?? "";
}
