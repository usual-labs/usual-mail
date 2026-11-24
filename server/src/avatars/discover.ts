// Finding the icons a site names for itself: in its page's head (`<link rel="icon">`, `apple-touch-icon`, the web
// app manifest's address) and in that manifest's `icons`. Read defensively and with limits, since the sender chooses
// the site: only the page's first 512 KB, only up to `</head>` or the body's start, at most 50 links, `<base>` ignored,
// the first of a repeated attribute (as browsers do), and nothing inside comments, scripts, styles, titles or
// templates. Discovery only names candidates; whether an address may be fetched is the fetcher's address rule's to
// decide when it is fetched, so a candidate at a private address is handed on unchanged. SVG is never a candidate.

export type IconKind =
  /** A manifest icon made for masking into a circle: full-bleed, with its mark inside the safe zone. */
  | "maskable"
  /** An apple-touch-icon: a full square, drawn without transparency. */
  | "touch"
  /** Any other icon: often a mark on transparency. */
  | "icon";

export interface IconCandidate {
  /** An absolute http or https address, or a small `data:` picture. */
  url: string;
  kind: IconKind;
  /** The largest side it declares, in pixels; 0 when it declares none, or "any". */
  size: number;
  /** The type it declares, lower case, when it declares one. */
  type?: string;
}

export interface PageIcons {
  icons: IconCandidate[];
  /** The web app manifest's address, when the page names one. */
  manifest?: string;
}

export const DISCOVERY_LIMITS = {
  /** How much of a page is read. */
  pageLength: 524_288,
  /** How many `<link>` elements are read. */
  links: 50,
  /** How many attributes of one element are kept. */
  attributes: 32,
  /** The longest http or https address taken. */
  urlLength: 2_048,
  /** The longest `data:` picture taken. */
  dataLength: 98_304,
  /** The largest manifest read. */
  manifestLength: 65_536,
  /** How many of a manifest's icons are read. */
  manifestIcons: 50,
};

/** Elements whose content is text, never markup: what is inside them is skipped to their end tag. */
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "template", "noscript", "xmp", "iframe", "noembed", "noframes"]);

const DATA_PICTURE = /^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|webp|jpeg)(?:;[^,]*)?,/i;

/** The icons and manifest a page's head names. `pageUrl` is the page's address after any redirects. */
export function iconsInPage(html: string, pageUrl: string): PageIcons {
  const out: PageIcons = { icons: [] };
  const text = html.length > DISCOVERY_LIMITS.pageLength ? html.slice(0, DISCOVERY_LIMITS.pageLength) : html;
  // Lower-cased once, ASCII letters only so every index stays the same (a full lower-casing changes some characters'
  // length): searching for end tags in it stays linear however many scripts there are.
  const lower = text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
  let links = 0;
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<", i);
    if (open < 0) break;
    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const next = text[open + 1] ?? "";
    if (next === "!" || next === "?") {
      const end = text.indexOf(">", open + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (next === "/") {
      const name = /^[A-Za-z][A-Za-z0-9-]*/.exec(text.slice(open + 2, open + 34))?.[0]?.toLowerCase();
      if (name === "head") break;
      const end = text.indexOf(">", open + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(next)) {
      i = open + 1;
      continue;
    }
    const tag = readTag(text, open + 1);
    if (!tag) break;
    i = tag.end;
    if (tag.name === "body") break;
    if (RAW_TEXT.has(tag.name)) {
      const close = indexOfCloseTag(lower, tag.name, i);
      if (close < 0) break;
      i = close;
      continue;
    }
    if (tag.name !== "link") continue;
    if (++links > DISCOVERY_LIMITS.links) break;
    addLink(out, tag.attributes, pageUrl);
  }
  return out;
}

/** Adds what one `<link>` names, if it names an icon or the manifest. */
function addLink(out: PageIcons, attributes: Map<string, string>, pageUrl: string): void {
  const rel = new Set((attributes.get("rel") ?? "").toLowerCase().split(/[\t\n\f\r ]+/).filter(Boolean));
  const href = attributes.get("href");
  if (href === undefined) return;
  if (rel.has("manifest")) {
    if (out.manifest === undefined) {
      const url = usableUrl(href, pageUrl, false);
      if (url) out.manifest = url;
    }
    return;
  }
  const kind: IconKind | null = rel.has("apple-touch-icon") || rel.has("apple-touch-icon-precomposed") ? "touch" : rel.has("icon") ? "icon" : null;
  if (!kind) return;
  const icon = candidate(href, pageUrl, kind, attributes.get("sizes"), attributes.get("type"));
  if (icon) out.icons.push(icon);
}

/** A candidate, or null when its address or type can't be used. */
function candidate(href: string, base: string, kind: IconKind, sizes: string | undefined, declaredType: string | undefined): IconCandidate | null {
  const type = declaredType?.trim().toLowerCase();
  if (type && type.includes("svg")) return null;
  const url = usableUrl(href, base, true);
  if (!url) return null;
  if (!url.startsWith("data:") && /\.svgz?$/i.test(new URL(url).pathname)) return null;
  return { url, kind, size: largestSize(sizes), ...(type && { type }) };
}

/** An absolute http or https address (or, when allowed, a small `data:` picture) for `href`, or null. */
function usableUrl(href: string, base: string, allowData: boolean): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^data:/i.test(trimmed)) return allowData && trimmed.length <= DISCOVERY_LIMITS.dataLength && DATA_PICTURE.test(trimmed) ? trimmed : null;
  if (trimmed.length > DISCOVERY_LIMITS.urlLength) return null;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href.length <= DISCOVERY_LIMITS.urlLength ? url.href : null;
}

/** The largest side among sizes such as "16x16 32x32"; 0 for "any", none or nonsense. */
function largestSize(sizes: string | undefined): number {
  if (!sizes || sizes.length > 256) return 0;
  let largest = 0;
  for (const size of sizes.trim().split(/\s+/).slice(0, 16)) {
    const match = /^([1-9][0-9]{0,3})[xX]([1-9][0-9]{0,3})$/.exec(size);
    if (match) largest = Math.max(largest, Number(match[1]), Number(match[2]));
  }
  return largest;
}

interface Tag {
  name: string;
  /** The first value of each attribute, names lower case, values with their character references read. */
  attributes: Map<string, string>;
  /** Where the text after the tag starts. */
  end: number;
}

const SPACE = /[\t\n\f\r ]/;

/** The start tag whose name begins at `at`, or null when it doesn't end. */
function readTag(text: string, at: number): Tag | null {
  let i = at;
  while (i < text.length && !SPACE.test(text[i]!) && text[i] !== "/" && text[i] !== ">") i++;
  const name = text.slice(at, i).toLowerCase();
  const attributes = new Map<string, string>();
  for (;;) {
    while (i < text.length && (SPACE.test(text[i]!) || text[i] === "/")) i++;
    if (i >= text.length) return null;
    if (text[i] === ">") return { name, attributes, end: i + 1 };
    const start = i;
    i++; // a name may begin with "=" in HTML; it is part of the name
    while (i < text.length && !SPACE.test(text[i]!) && text[i] !== "/" && text[i] !== ">" && text[i] !== "=") i++;
    const key = text.slice(start, i).toLowerCase();
    while (i < text.length && SPACE.test(text[i]!)) i++;
    let value = "";
    if (text[i] === "=") {
      i++;
      while (i < text.length && SPACE.test(text[i]!)) i++;
      const quote = text[i];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, i + 1);
        if (close < 0) return null;
        value = text.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < text.length && !SPACE.test(text[i]!) && text[i] !== ">") i++;
        value = text.slice(valueStart, i);
      }
    }
    if (attributes.size < DISCOVERY_LIMITS.attributes && !attributes.has(key) && value.length <= DISCOVERY_LIMITS.dataLength) {
      attributes.set(key, decodeReferences(value));
    }
  }
}

/** Where the text after `</name ...>` starts in the lower-cased page, searching from `from`; -1 when it never ends. */
function indexOfCloseTag(lower: string, name: string, from: number): number {
  let at = from;
  for (;;) {
    const found = lower.indexOf(`</${name}`, at);
    if (found < 0) return -1;
    const after = lower[found + 2 + name.length];
    if (after === undefined || after === ">" || after === "/" || SPACE.test(after)) {
      const end = lower.indexOf(">", found);
      return end < 0 ? -1 : end + 1;
    }
    at = found + 2;
  }
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Character references in an attribute's value: the five named ones and numeric ones. Others stay as written. */
function decodeReferences(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos));?/g, (whole, hex?: string, decimal?: string, name?: string) => {
    if (name) return NAMED[name]!;
    const code = hex ? Number.parseInt(hex, 16) : Number(decimal);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

/** The icons a web app manifest names, resolved against the manifest's own address. Nothing for one that can't be read. */
export function iconsInManifest(json: string, manifestUrl: string): IconCandidate[] {
  if (json.length > DISCOVERY_LIMITS.manifestLength) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return [];
  const icons = (manifest as { icons?: unknown }).icons;
  if (!Array.isArray(icons)) return [];
  const out: IconCandidate[] = [];
  for (const entry of icons.slice(0, DISCOVERY_LIMITS.manifestIcons)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { src, sizes, type, purpose } = entry as Record<string, unknown>;
    if (typeof src !== "string") continue;
    const purposes = new Set((typeof purpose === "string" ? purpose.slice(0, 256) : "").toLowerCase().split(/\s+/).filter(Boolean));
    const kind: IconKind | null = purposes.has("maskable") ? "maskable" : purposes.size === 0 || purposes.has("any") ? "icon" : null;
    if (!kind) continue;
    const icon = candidate(src, manifestUrl, kind, typeof sizes === "string" ? sizes : undefined, typeof type === "string" ? type.slice(0, 256) : undefined);
    if (icon) out.push(icon);
  }
  return out;
}

/** The conventional addresses at the root of the site a page was fetched from, tried when nothing named works. */
export function fallbackIcons(pageUrl: string): IconCandidate[] {
  const origin = new URL(pageUrl).origin;
  return [
    { url: `${origin}/apple-touch-icon.png`, kind: "touch", size: 0 },
    { url: `${origin}/favicon.ico`, kind: "icon", size: 0 },
  ];
}

const KIND_ORDER: Record<IconKind, number> = { maskable: 0, touch: 1, icon: 2 };

/** How a declared size stands: 64 to 512 pixels first, then larger, then unknown, then smaller. */
function tier(size: number): number {
  if (size >= 64 && size <= 512) return 0;
  if (size > 512) return 1;
  return size === 0 ? 2 : 3;
}

const isIco = (icon: IconCandidate): boolean =>
  icon.type === "image/x-icon" || icon.type === "image/vnd.microsoft.icon" || /^data:image\/(?:x-icon|vnd\.microsoft\.icon)/i.test(icon.url) ||
  (!icon.url.startsWith("data:") && /\.ico$/i.test(new URL(icon.url).pathname));

/**
 * The order to try candidates in, each address once: a declared size of 64 to 512 pixels first (the sharpest honest
 * icon without waste), then larger ones smallest first, then those of unknown size, then smaller ones largest first;
 * within each, a maskable icon, a touch icon, then any other, and an ICO after a PNG of the same standing.
 */
export function rankIcons(candidates: readonly IconCandidate[]): IconCandidate[] {
  const ranked = candidates
    .map((icon, index) => ({ icon, index, tier: tier(icon.size), ico: isIco(icon) ? 1 : 0 }))
    .sort((a, b) =>
      a.tier - b.tier ||
      KIND_ORDER[a.icon.kind] - KIND_ORDER[b.icon.kind] ||
      (a.tier === 1 ? a.icon.size - b.icon.size : b.icon.size - a.icon.size) ||
      a.ico - b.ico ||
      a.index - b.index);
  const seen = new Set<string>();
  const out: IconCandidate[] = [];
  for (const { icon } of ranked) {
    if (seen.has(icon.url)) continue;
    seen.add(icon.url);
    out.push(icon);
  }
  return out;
}
