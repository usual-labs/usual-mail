// Sender pictures as the server runs them (docs/contract-avatars.md): on only with the Public Suffix List (the shipped
// one unless a test gives another), the fetch queue when the host can fetch sites, the background backfill at every
// start, and the picture route.

import { ServiceError, type Caller } from "@usualmail/core";
import type { WebPicture } from "../host.ts";
import { requirePerson } from "../service/access.ts";
import type { Ctx } from "../service/context.ts";
import { backfillFromChecks } from "./backfill.ts";
import { AvatarQueue, QUEUE_LIMITS } from "./queue.ts";
import { SHIPPED_SUFFIXES } from "./shipped.ts";
import { pictureShownIn, sitePicture } from "./sites.ts";
import type { SuffixList } from "./suffixes.ts";

/** The one line a server without the Public Suffix List logs at start. */
export const SENDER_PICTURES_OFF =
  "Sender pictures are off: this server carries no Public Suffix List (server/scripts/update-suffixes.mjs writes it), so it shows initials and fetches nothing.";

/** The line a server with the Public Suffix List logs at start: which list, and what it does with it. */
export function senderPicturesOn(source: { commit: string } | null): string {
  return `Sender pictures are on: the Public Suffix List at commit ${source?.commit.slice(0, 12) ?? "unknown"}; an organisation's own icon is fetched from its site, one domain at a time, within six hours of its first proved mail from a sender who is let in.`;
}

export interface AvatarOptions {
  /** The Public Suffix List. Default: the shipped one. Null, or none shipped: no sender pictures at all. */
  suffixes?: SuffixList | null;
  /** The fetch queue's limits; only tests change them. */
  queue?: Partial<typeof QUEUE_LIMITS>;
  /** Whether the backfill runs at start. Default true; tests that don't want it say so. */
  backfill?: boolean;
}

/** The Public Suffix List these options give: theirs, else the shipped one; null when none (no sender pictures). */
export function suffixListOf(options: AvatarOptions): SuffixList | null {
  return options.suffixes === undefined ? SHIPPED_SUFFIXES : options.suffixes;
}

export class Avatars {
  readonly #ctx: Ctx;
  readonly #queue: AvatarQueue | null;
  readonly #track: (work: Promise<unknown>) => void;
  readonly #backfill: boolean;
  #running = false;

  constructor(ctx: Ctx, options: AvatarOptions, track: (work: Promise<unknown>) => void) {
    this.#ctx = ctx;
    this.#track = track;
    this.#backfill = options.backfill ?? true;
    const suffixes = suffixListOf(options);
    if (!suffixes) {
      // The Node entry point says so once in its log (`SENDER_PICTURES_OFF`).
      this.#queue = null;
      return;
    }
    const queue = new AvatarQueue(ctx, ctx.host.siteIcons ?? null, track, options.queue);
    this.#queue = queue;
    ctx.avatars = { suffixes, wake: () => queue.wake() };
  }

  start(): void {
    if (!this.#queue) return;
    this.#running = true;
    this.#queue.start();
    if (this.#backfill) this.#track(backfillFromChecks(this.#ctx, () => this.#running).catch((error) => {
      this.#ctx.host.log.error(`Sender pictures: the backfill stopped (${error instanceof Error ? error.name : "unknown"})`);
    }));
  }

  stop(): void {
    this.#running = false;
    this.#queue?.stop();
  }

  /**
   * A kept sender picture, for a person's device. Never fetches: only what the server keeps. A caller limited to some
   * inboxes gets one only when it shows in one of them, so it learns nothing of other inboxes' senders.
   */
  async picture(caller: Caller, id: string): Promise<WebPicture> {
    requirePerson(caller, "load sender pictures");
    const picture = await sitePicture(this.#ctx, id);
    if (!picture || (caller.inboxIds && !(await pictureShownIn(this.#ctx, picture.domain, caller.inboxIds)))) {
      throw new ServiceError("not_found", "No such sender picture");
    }
    return { mimeType: picture.mimeType, data: picture.data };
  }
}
