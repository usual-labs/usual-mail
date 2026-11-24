// A site icon source for sender pictures (docs/contract-avatars.md), over a host's fetcher of the web: an organisation's
// own icon, fetched from its own site under every rule pictures from the web follow. Node's fetcher pins the connection
// to the address it checked (`src/node/avatars/site.ts`); Cloudflare's checks the name over DNS-over-HTTPS and can't
// pin (`src/cloudflare/web/`). For one registrable domain: its page at https://<domain>/ (else https://www.<domain>/),
// only the first 512 KB; the web app manifest it names, at most 64 KB; then the icons they name, best first, and the
// conventional /apple-touch-icon.png and /favicon.ico. At most 6 requests and 45 seconds in all. The first icon that is
// a picture the server keeps (`avatarPicture`) wins. Its fit follows what kind of icon it is: a maskable or touch icon
// fills the circle, any other sits inside it.

import { PictureRefused } from "../pictures/refused.ts";
import type { SiteIconSource } from "../host.ts";
import { fallbackIcons, iconsInManifest, iconsInPage, rankIcons, type IconCandidate } from "./discover.ts";
import { avatarPicture } from "./picture.ts";
import type { SiteIcon } from "./sites.ts";

export const SITE_LIMITS = {
  /** Requests to the web for one domain, its page, manifest and icons together. */
  requests: 6,
  /** Time for one domain, every request included. */
  totalMs: 45_000,
  /** How much of a page is read. */
  pageBytes: 524_288,
  /** The largest manifest read. */
  manifestBytes: 65_536,
  /** The largest icon fetched (the picture's own cap). */
  iconBytes: 1_048_576,
};

/** What a request may ask of the host's fetcher, on top of its own rules. */
export interface WebRequest {
  /** Read at most this many bytes and keep them, instead of refusing a longer answer. */
  cutAt?: number;
  maxBytes?: number;
  accept?: string;
  totalTimeoutMs: number;
}

/** The host's fetcher: the bytes at `url` and the address they finally came from, or a `PictureRefused` saying why not. */
export type WebFetch = (url: string, request: WebRequest) => Promise<{ bytes: Uint8Array; url: string }>;

export interface SiteIconsOptions {
  limits?: Partial<typeof SITE_LIMITS>;
  now?: () => number;
  /** The address a site's page is asked at for a host name. Default `https://<host>`; only tests change it. */
  origin?: (host: string) => string;
  /** The longest one request may take, within the domain's time. Default 15 seconds, a picture's. */
  requestTimeoutMs?: number;
}

const PAGE_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";
const MANIFEST_ACCEPT = "application/manifest+json,application/json;q=0.9,*/*;q=0.1";

export class SiteIcons implements SiteIconSource {
  readonly #fetch: WebFetch;
  readonly #limits: typeof SITE_LIMITS;
  readonly #now: () => number;
  readonly #origin: (host: string) => string;
  readonly #requestTimeoutMs: number;

  constructor(fetch: WebFetch, options: SiteIconsOptions = {}) {
    this.#fetch = fetch;
    this.#limits = { ...SITE_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
    this.#origin = options.origin ?? ((host) => `https://${host}`);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async fetch(domain: string): Promise<SiteIcon> {
    const limits = this.#limits;
    const deadline = this.#now() + limits.totalMs;
    let requests = 0;
    /** Whether any request got an answer from a site (a page, a picture, or a status), not only a failure to reach it. */
    let reached = false;
    let lastWords = "its site has no icon the server shows";
    const get = async (url: string, request: Omit<WebRequest, "totalTimeoutMs">) => {
      if (++requests > limits.requests) throw new PictureRefused(`more than ${limits.requests} requests for one site`, "refused");
      const left = deadline - this.#now();
      if (left <= 0) throw new PictureRefused("its site took too long", "refused");
      try {
        const got = await this.#fetch(url, { ...request, totalTimeoutMs: Math.min(left, this.#requestTimeoutMs) });
        reached = true;
        return got;
      } catch (error) {
        if (error instanceof PictureRefused && (error.kind === "refused" || /answered \d+/.test(error.message))) reached = true;
        throw error;
      }
    };

    let page: { bytes: Uint8Array; url: string } | null = null;
    for (const host of [domain, `www.${domain}`]) {
      try {
        page = await get(`${this.#origin(host)}/`, { cutAt: limits.pageBytes, accept: PAGE_ACCEPT });
        break;
      } catch (error) {
        if (error instanceof PictureRefused) lastWords = error.message;
      }
    }
    const candidates: IconCandidate[] = [];
    if (page) {
      const found = iconsInPage(new TextDecoder().decode(page.bytes), page.url);
      candidates.push(...found.icons);
      if (found.manifest) {
        try {
          const manifest = await get(found.manifest, { maxBytes: limits.manifestBytes, accept: MANIFEST_ACCEPT });
          candidates.push(...iconsInManifest(new TextDecoder().decode(manifest.bytes), manifest.url));
        } catch {
          // A manifest that can't be had leaves the page's own icons.
        }
      }
    }
    // What the site names, best first; then the conventional addresses, only after everything named.
    const named = rankIcons(candidates);
    const tried = [...named, ...fallbackIcons(page?.url ?? `${this.#origin(domain)}/`).filter((icon) => !named.some((n) => n.url === icon.url))];
    for (const icon of tried) {
      if (requests >= limits.requests && !icon.url.startsWith("data:")) break;
      try {
        const bytes = icon.url.startsWith("data:") ? dataBytes(icon.url) : (await get(icon.url, { maxBytes: limits.iconBytes })).bytes;
        const picture = await avatarPicture(bytes);
        return { found: true, ...picture, fit: icon.kind === "icon" ? "inset" : "fill" };
      } catch (error) {
        if (error instanceof PictureRefused) lastWords = error.message;
        if (this.#now() >= deadline) break;
      }
    }
    return reached ? { found: false, kind: "none", reason: lastWords } : { found: false, kind: "failed", reason: lastWords };
  }
}

/** The bytes of a `data:` picture (base64 or percent-encoded), read here, without the network. */
function dataBytes(url: string): Uint8Array {
  const comma = url.indexOf(",");
  if (comma < 0) throw new PictureRefused("its inline picture can't be read", "refused");
  const head = url.slice(5, comma);
  const body = url.slice(comma + 1);
  try {
    if (/;base64$/i.test(head)) return Uint8Array.from(atob(body.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    // Percent-encoded: each %XX is one byte, anything else its own (ASCII) byte.
    const out: number[] = [];
    for (let i = 0; i < body.length; i++) {
      const hex = body[i] === "%" ? /^[0-9a-fA-F]{2}$/.exec(body.slice(i + 1, i + 3))?.[0] : undefined;
      if (hex) {
        out.push(Number.parseInt(hex, 16));
        i += 2;
      } else out.push(body.charCodeAt(i) & 0xff);
    }
    return Uint8Array.from(out);
  } catch {
    throw new PictureRefused("its inline picture can't be read", "refused");
  }
}
