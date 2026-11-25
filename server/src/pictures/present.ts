// How the server shows one message's pictures from the web (docs/contract-pictures.md): trackers on the list, and
// tiny or hidden pictures, are taken out before anything is fetched; the rest point at the picture route, at most
// MAX_PICTURES_PER_MESSAGE of them, unless the message's pictures are held back. The same plan answers which address
// a picture id stands for, so the route fetches only what the stored HTML shows.
//
// A plan costs a sanitizer pass over the HTML and the tracker list matched against each address, and writing the HTML
// again costs another pass, so both are made once per message (and held-back state, and HTML) and kept: a picture
// request then costs a lookup, and serving a thread again costs none (the security review of 2026-11-18 measured
// 0.5 s per request on a 5 MB mail, and 2.4 s per serve of one with 30,000 addresses). At most 200 messages are kept,
// and at most MAX_KEPT_CHARS characters of served HTML. At most MAX_EXAMINED_ADDRESSES different addresses of a
// message are looked at; any further ones are left out unfetched.

import { MAX_PICTURES_PER_MESSAGE, MAX_SHOWN_HTML_LENGTH, picturePath, type PicturesHeldBack, type RemotePictures } from "@usualmail/core";
import { remotePictures, rewritePictures, type PictureDecision, type RemotePicture } from "@usualmail/mail/pictures";
import { base64url } from "../util.ts";
import { trackers as shippedTrackers, type Trackers } from "./trackers.ts";

/** How many different addresses of one message are matched against the tracker list at most. */
export const MAX_EXAMINED_ADDRESSES = 300;
/** How much of a picture's address is matched against the tracker list. */
export const TRACKER_READ = 2_048;
/** How many messages' plans are kept. */
const KEPT_PLANS = 200;
/**
 * How much is kept, in characters, in all: served HTML and the addresses plans hold. Twenty messages of the largest
 * HTML shown (MAX_SHOWN_HTML_LENGTH), a long thread of large mail, fit with room to spare, so viewing such a thread
 * again doesn't write it all again. About 24 MB of memory for ordinary (one-byte) text, 48 MB at worst.
 */
export const MAX_KEPT_CHARS = 24_000_000;

/** Tiny pictures with these words in their address are spacers: still taken out, but not counted as trackers. */
const SPACER = /spacer|transparent\.gif/i;

const sha256 = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** A picture's id in the route: the first 22 characters of the base64url SHA-256 of its address. */
export async function pictureId(url: string): Promise<string> {
  return base64url(await sha256(url)).slice(0, 22);
}

interface Plan {
  /** Shown addresses and their ids, in the order the HTML first shows them. */
  shown: Map<string, string>;
  /** About how many characters the plan keeps: the addresses it looked at, and the ids it gave. */
  size: number;
  /** Decides one picture of the HTML (the same picture always the same way). */
  decide(picture: RemotePicture, messageId: string): PictureDecision;
  summary: RemotePictures | undefined;
}

interface Served {
  html: string;
  remotePictures?: RemotePictures;
}

interface Kept {
  plan: Promise<Plan>;
  served?: Served;
  /** The characters counted for it: its plan's, once made, and its served HTML's. */
  chars: number;
}

/** The plans and served HTML of recently served messages, over one tracker list, with the work they cost. */
export class PicturePlans {
  readonly #list: Trackers;
  readonly #maxKeptChars: number;
  readonly #kept = new Map<string, Kept>();
  #keptChars = 0;
  /** Plans made, addresses matched against the tracker list, HTML written again: what tests and diagnostics read. */
  readonly work = { plans: 0, matches: 0, rewrites: 0 };

  constructor(list: Trackers = shippedTrackers, options: { maxKeptChars?: number } = {}) {
    this.#list = list;
    this.#maxKeptChars = options.maxKeptChars ?? MAX_KEPT_CHARS;
  }

  /** The characters kept now, plans and served HTML together. */
  get keptChars(): number {
    return this.#keptChars;
  }

  /** The plan for a message's HTML as stored, held back or not: kept, or made now. */
  async plan(messageId: string, html: string, held: PicturesHeldBack | undefined): Promise<Plan> {
    return (await this.#entry(messageId, html, held)).kept.plan;
  }

  /** The message's HTML as served, and its `remotePictures`: kept, or written now. */
  async present(messageId: string, html: string, held: PicturesHeldBack | undefined): Promise<Served> {
    const { key, kept } = await this.#entry(messageId, html, held);
    if (kept.served) return kept.served;
    const { decide, summary } = await kept.plan;
    this.work.rewrites++;
    // Always written again, so fonts from the web, and addresses no picture can come from, go even without pictures.
    const out = rewritePictures(html, (picture) => decide(picture, messageId));
    const served: Served = summary ? { html: out, remotePictures: summary } : { html: out };
    if (this.#kept.get(key) === kept && !kept.served) {
      kept.served = served;
      this.#count(kept, out.length);
      this.#trim(key);
    }
    return served;
  }

  async #entry(messageId: string, html: string, held: PicturesHeldBack | undefined): Promise<{ key: string; kept: Kept }> {
    const key = `${messageId}\u0000${held ?? ""}\u0000${base64url(await sha256(html))}`;
    let kept = this.#kept.get(key);
    if (kept) {
      // The most recently used goes last; the first are dropped when there are too many, or too much.
      this.#kept.delete(key);
    } else {
      const made: Kept = { plan: this.#make(html, held), chars: 0 };
      made.plan.then(
        (plan) => {
          if (this.#kept.get(key) !== made) return;
          this.#count(made, plan.size);
          this.#trim(key);
        },
        () => this.#drop(key),
      );
      kept = made;
    }
    this.#kept.set(key, kept);
    this.#trim(key);
    return { key, kept };
  }

  /** Drops the least recently used until within both bounds, never `current`. */
  #trim(current: string): void {
    for (const key of this.#kept.keys()) {
      if (this.#kept.size <= KEPT_PLANS && this.#keptChars <= this.#maxKeptChars) return;
      if (key !== current) this.#drop(key);
    }
  }

  #count(kept: Kept, chars: number): void {
    kept.chars += chars;
    this.#keptChars += chars;
  }

  #drop(key: string): void {
    const kept = this.#kept.get(key);
    if (!kept) return;
    this.#keptChars -= kept.chars;
    this.#kept.delete(key);
  }

  async #make(html: string, held: PicturesHeldBack | undefined): Promise<Plan> {
    this.work.plans++;
    const pictures = remotePictures(html);
    const counted = new Set<string>();
    const names = new Set<string>();
    const candidates: string[] = [];
    const makers = new Map<string, string | null>();
    for (const picture of pictures) {
      if (!makers.has(picture.url)) {
        if (makers.size >= MAX_EXAMINED_ADDRESSES) continue;
        this.work.matches++;
        // Only an address's start is matched: the list's patterns name sites and paths, and a long address read whole
        // could hold the server for long (some patterns scan back and forth).
        makers.set(picture.url, this.#list.match(picture.url.slice(0, TRACKER_READ)));
      }
      const maker = makers.get(picture.url)!;
      if (maker) names.add(maker);
      if (maker || picture.tiny) {
        if (maker || !SPACER.test(picture.url)) counted.add(picture.url);
      } else if (!candidates.includes(picture.url)) {
        candidates.push(picture.url);
      }
    }
    const shown = new Map<string, string>();
    if (!held) {
      for (const url of candidates.slice(0, MAX_PICTURES_PER_MESSAGE)) shown.set(url, await pictureId(url));
    }
    const decide = (picture: RemotePicture, messageId: string): PictureDecision => {
      // An address never examined is left out, unfetched.
      if (!makers.has(picture.url)) return { kind: "hold" };
      if (makers.get(picture.url) || picture.tiny) return { kind: "remove" };
      const id = shown.get(picture.url);
      return id ? { kind: "show", src: picturePath(messageId, id) } : { kind: "hold" };
    };
    let size = 0;
    for (const url of makers.keys()) size += url.length;
    for (const [url, id] of shown) size += url.length + id.length;
    const summary: RemotePictures | undefined = pictures.length === 0 ? undefined : {
      shown: shown.size,
      trackersRemoved: counted.size,
      trackers: [...names].sort((a, b) => a.localeCompare(b, "en")),
      ...(held && candidates.length > 0 && { heldBack: held }),
    };
    return { shown, size, decide, summary };
  }
}

/** The plans the service uses, over the shipped list. */
export const servedPlans = new PicturePlans();

/**
 * A message's HTML as the server serves it, and what was done with its pictures from the web (absent when it takes
 * none). `held` holds back every picture that isn't a tracker. The service leaves HTML longer than
 * MAX_SHOWN_HTML_LENGTH out before it comes here.
 */
export function presentPictures(
  messageId: string,
  html: string,
  held: PicturesHeldBack | undefined,
  plans: PicturePlans = servedPlans,
): Promise<{ html: string; remotePictures?: RemotePictures }> {
  return plans.present(messageId, html, held);
}

/** The address a picture id stands for in a message, or null when the message doesn't show such a picture. */
export async function shownPictureUrl(
  messageId: string,
  html: string,
  id: string,
  held: PicturesHeldBack | undefined,
  plans: PicturePlans = servedPlans,
): Promise<string | null> {
  // The route's own check: HTML too long to be shown shows no pictures either.
  if (html.length > MAX_SHOWN_HTML_LENGTH) return null;
  const { shown } = await plans.plan(messageId, html, held);
  for (const [url, shownId] of shown) if (shownId === id) return url;
  return null;
}
