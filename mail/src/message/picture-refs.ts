/**
 * The pieces the sanitizer uses to hand each picture a message takes from the web to a caller that decides what
 * becomes of it (the server, when it serves a message: show it through itself, hold it back, or take it out as a
 * tracker). Nothing here fetches anything.
 */
import { cssAddresses, cssTokens } from "./css-tokens.ts";

/** Where in the HTML a picture from the web is asked for. */
export type PictureSite = "img" | "background" | "css";

/** One picture the HTML takes from the web. */
export interface RemotePicture {
  /** The address, absolute: http or https, a protocol-relative one taken as https, no fragment, no user name. */
  url: string;
  site: PictureSite;
  /** An `<img>` declared at most 1×1 (or 0 in either direction), or hidden by its own style: a likely tracker. */
  tiny: boolean;
}

/** What becomes of a picture: shown from `src` instead, held back (its address taken away), or taken out whole. */
export type PictureDecision = { kind: "show"; src: string } | { kind: "hold" } | { kind: "remove" };

/** Decides each picture from the web, in the order the HTML has them (style blocks last). */
export type PictureHook = (picture: RemotePicture) => PictureDecision;

const REMOTE = /^(?:https?:|\/\/)/;

/** True when an address (as an attribute or CSS has it) is one a browser would fetch from the web. */
export function isRemote(value: string): boolean {
  return REMOTE.test(value.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase());
}

/**
 * The address a picture is fetched from, or null when it can't be one: not http or https, not an address at all, or
 * carrying a user name or password. Protocol-relative addresses are taken as https; the fragment is dropped.
 */
export function canonicalPictureUrl(value: string): string | null {
  const compact = value.replace(/[\t\n\r]+/g, "").trim();
  let url: URL;
  try {
    url = new URL(compact.startsWith("//") ? `https:${compact}` : compact);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname) return null;
  url.hash = "";
  return url.href;
}

/** A length as an attribute or a style gives it, in pixels, or undefined when it isn't one. */
function pixels(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*(?:!\s*important)?\s*$/i.exec(value);
  return match ? Number(match[1]) : undefined;
}

/** The declarations of a sanitized style attribute, by lower-case property, the last one winning. */
function styleDeclarations(style: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (style ?? "").split(";")) {
    const colon = part.indexOf(":");
    if (colon > 0) out.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim().toLowerCase());
  }
  return out;
}

/**
 * Whether an `<img>` looks like a tracking pixel by itself: hidden by its own style, or declared at most 1×1 (one
 * side of at most 1 with the other not given counts too, and a side of 0 always does). A spacer of 1×20 doesn't.
 * Styles from a style block or a class aren't looked at.
 */
export function isTinyOrHidden(attribs: Record<string, string>): boolean {
  const style = styleDeclarations(attribs.style);
  const display = style.get("display");
  if (display && /^none\b/.test(display)) return true;
  const visibility = style.get("visibility");
  if (visibility && /^(?:hidden|collapse)\b/.test(visibility)) return true;
  const opacity = style.get("opacity");
  if (opacity && /^0*(?:\.0*)?%?\s*(?:!\s*important)?$/.test(opacity)) return true;
  if (pixels(style.get("max-width")) === 0 || pixels(style.get("max-height")) === 0) return true;
  const width = pixels(style.get("width")) ?? pixels(attribs.width);
  const height = pixels(style.get("height")) ?? pixels(attribs.height);
  if (width === 0 || height === 0) return true;
  if (width !== undefined && width <= 1) return height === undefined || height <= 1;
  if (height !== undefined && height <= 1) return width === undefined;
  return false;
}

// --- CSS -----------------------------------------------------------------------------------------------------

/** One of the server's own picture paths, whole. */
const OWN_PATH = /^\/v1\/messages\/[A-Za-z0-9%._~-]+\/pictures\/[A-Za-z0-9_-]+$/;

/**
 * A CSS value as the server serves it, with each picture from the web decided by `hook`: a shown one points at its
 * new address, a held-back or removed one becomes `none`. Returns null when the declaration must go instead: in
 * `@font-face` when anything loads from the web (fonts never do); when an address on the web is written with escapes,
 * or the value is broken in a way that could hide one, or loads more than MAX_ADDRESSES_PER_VALUE; and whenever the
 * result fails the last check (`servableCss`). One pass, in the order the addresses are written.
 */
export function rewriteCssPictures(raw: string, hook: PictureHook, fontFace: boolean): string | null {
  const addresses = cssAddresses(raw);
  if (addresses === null) return null;
  let out = raw;
  if (addresses.some((address) => isRemote(address.value))) {
    if (fontFace) return null;
    const parts: string[] = [];
    let at = 0;
    for (const address of addresses) {
      if (!isRemote(address.value)) continue;
      if (raw.slice(address.start, address.end).includes("\\")) return null;
      const decision = decideCss(address.value, hook);
      if (!decision) return null;
      // A held or removed string takes its whole image-set() with it; the strings after it in there go too.
      const span = decision.kind !== "show" && address.within ? address.within : address;
      if (span.start < at) continue; // inside a span already replaced
      const text = decision.kind !== "show" ? "none" : address.kind === "string" ? `"${decision.src}"` : `url("${decision.src}")`;
      parts.push(raw.slice(at, span.start), text);
      at = span.end;
    }
    parts.push(raw.slice(at));
    out = parts.join("");
  }
  return servableCss(out) ? out : null;
}

/**
 * The last check on served CSS (a value, an attribute or a whole style block), read token by token as a browser reads
 * it: nothing broken that could hide something; every address it loads is one of the server's picture paths, a `cid:`
 * or a `data:` picture other than SVG (no SVG anywhere); and no string anywhere names the web ("http:", "https:",
 * "//"), since a custom property could hand it to `image-set()`. Escapes elsewhere (a bullet in `content`, an icon
 * font's glyph, a font's name) are fine. `max` is how many addresses it may load (MAX_ADDRESSES_PER_VALUE for a value).
 */
export function servableCss(value: string, max?: number): boolean {
  const addresses = cssAddresses(value, max === undefined ? {} : { max });
  if (addresses === null) return false;
  for (const { value: address } of addresses) {
    const compact = address.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
    if (!compact || OWN_PATH.test(address) || compact.startsWith("cid:")) continue;
    if (compact.startsWith("data:image/") && !compact.startsWith("data:image/svg")) continue;
    return false;
  }
  for (const token of cssTokens(value)) {
    if ((token.type === "string" || token.type === "url") && /https?:|\/\//i.test(token.value) && !OWN_PATH.test(token.value)) return false;
  }
  return true;
}

function decideCss(value: string, hook: PictureHook): PictureDecision | null {
  const url = canonicalPictureUrl(value);
  if (!url) return null;
  // A new address that would load from the web, or break out of the string it is written in, fails the last check
  // (`servableCss`), which drops the declaration.
  return hook({ url, site: "css", tiny: false });
}
