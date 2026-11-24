// The store's record of each domain's site icon (`avatar_sites`), for every inbox at once: wanting one, what a fetch
// found, the pictures to serve, and forgetting domains no mail has wanted for 180 days (docs/contract-avatars.md).
//
// Timing, so the domain's owner learns as little as can be: a domain first wanted is fetched at a random moment within
// six hours, not when its mail arrives; once found (or found to have nothing), it is looked at again only when new
// mail that would show it arrives and the last look is more than 30 days old, never on a timer of its own; a site
// that fails is tried again after ten minutes and a day, then left until new mail after 30 days.

import type { Avatar, AvatarFit } from "@usualmail/core";
import { avatarPath } from "@usualmail/core";
import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { avatarSites, messages, type AvatarSiteRow } from "../db/index.ts";
import { endsWith } from "../db/match.ts";
import { inList } from "../db/params.ts";
import type { Ctx } from "../service/context.ts";

export const SITE_TIMES = {
  /** The longest random wait before a newly wanted domain is fetched. */
  firstDelayMs: 6 * 60 * 60_000,
  /** How old a look must be before new mail makes it look again. */
  lookAgainAfterMs: 30 * 24 * 60 * 60_000,
  /** When a failed fetch is tried again: after the first failure, and after the second. A third is final. */
  retryAfterMs: [10 * 60_000, 24 * 60 * 60_000],
  /** A domain no mail has wanted for this long is forgotten, its picture with it. */
  unwantedForMs: 180 * 24 * 60 * 60_000,
};

/** A site icon as a site source gives it: a picture to keep, or why there is none. */
export type SiteIcon =
  | { found: true; mimeType: "image/png" | "image/jpeg" | "image/webp"; data: Uint8Array; width: number; height: number; fit: AvatarFit }
  | { found: false; kind: "none" | "failed"; reason: string };

/** A random wait up to `SITE_TIMES.firstDelayMs`, from the host's random source. */
export function randomDelay(ctx: Ctx): number {
  const [a = 0, b = 0, c = 0, d = 0] = ctx.host.random.bytes(4);
  return Math.floor((((a << 24) >>> 0) + (b << 16) + (c << 8) + d) / 2 ** 32 * SITE_TIMES.firstDelayMs);
}

/**
 * Notes that mail wants this domain's picture. A domain never wanted before is queued for a random moment within six
 * hours. With `fresh` (new mail arrived), a look more than 30 days old is due again, at a random moment too. Returns
 * whether a fetch became due. Callers hold `ctx.lock`.
 */
export async function wantSite(ctx: Ctx, domain: string, fresh: boolean): Promise<boolean> {
  const now = ctx.now();
  const row = await ctx.db.select().from(avatarSites).where(eq(avatarSites.domain, domain)).get();
  if (!row) {
    await ctx.db.insert(avatarSites).values({ domain, state: "queued", dueAt: now + randomDelay(ctx), wantedAt: now, createdAt: now })
      .onConflictDoNothing();
    return true;
  }
  if (!fresh) return false;
  const stale = row.dueAt === null && row.checkedAt !== null && now - row.checkedAt > SITE_TIMES.lookAgainAfterMs;
  await ctx.db.update(avatarSites).set({
    wantedAt: now,
    ...(stale && { dueAt: now + randomDelay(ctx), tries: 0 }),
  }).where(eq(avatarSites.domain, domain));
  return stale;
}

/** The id a picture is served under: a hash of its domain and bytes, so a changed picture has a new one. */
export async function pictureId(domain: string, data: Uint8Array): Promise<string> {
  const name = new TextEncoder().encode(`${domain}\n`);
  const input = new Uint8Array(name.length + data.length);
  input.set(name);
  input.set(data, name.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Keeps what a fetch of the domain's site found. Returns whether the picture served for it changed (appeared, changed
 * or went), so the threads showing it are settled again. A failed look again keeps the picture it had. Callers hold
 * `ctx.lock`.
 */
export async function recordSite(ctx: Ctx, domain: string, icon: SiteIcon): Promise<boolean> {
  const now = ctx.now();
  const row = await ctx.db.select().from(avatarSites).where(eq(avatarSites.domain, domain)).get();
  if (!row) return false; // forgotten while it was fetched
  if (icon.found) {
    const id = await pictureId(domain, icon.data);
    await ctx.db.update(avatarSites).set({
      state: "found", pictureId: id, mimeType: icon.mimeType, data: toBase64(icon.data), width: icon.width, height: icon.height,
      fit: icon.fit, checkedAt: now, dueAt: null, tries: 0, reason: null,
    }).where(eq(avatarSites.domain, domain));
    return row.pictureId !== id;
  }
  if (icon.kind === "none") {
    await ctx.db.update(avatarSites).set({
      state: "none", pictureId: null, mimeType: null, data: null, width: null, height: null, fit: null,
      checkedAt: now, dueAt: null, tries: 0, reason: icon.reason,
    }).where(eq(avatarSites.domain, domain));
    return row.pictureId !== null;
  }
  if (row.state === "found") {
    // The site failed when looked at again: its picture stays until a later look says otherwise.
    await ctx.db.update(avatarSites).set({ checkedAt: now, dueAt: null, reason: icon.reason }).where(eq(avatarSites.domain, domain));
    return false;
  }
  const tries = row.tries + 1;
  const retry = SITE_TIMES.retryAfterMs[tries - 1];
  await ctx.db.update(avatarSites).set({
    state: "failed", checkedAt: now, tries, dueAt: retry === undefined ? null : now + retry, reason: icon.reason,
  }).where(eq(avatarSites.domain, domain));
  return false;
}

/** The pictures served for these domains, by domain: only those found. */
export async function sitePictures(ctx: Ctx, domains: Iterable<string>): Promise<Map<string, Avatar>> {
  const list = [...new Set(domains)];
  if (list.length === 0) return new Map();
  const rows = await ctx.db.select({
    domain: avatarSites.domain, pictureId: avatarSites.pictureId, fit: avatarSites.fit, width: avatarSites.width, height: avatarSites.height,
  }).from(avatarSites).where(and(inList(avatarSites.domain, list), eq(avatarSites.state, "found"), isNotNull(avatarSites.pictureId)));
  return new Map(rows.map((row) => [row.domain, {
    picture: avatarPath(row.pictureId!),
    fit: row.fit ?? "inset",
    size: Math.max(row.width ?? 0, row.height ?? 0),
  }]));
}

/** A kept picture by its id, with its domain, for the picture route; null when there is none. */
export async function sitePicture(ctx: Ctx, id: string): Promise<{ domain: string; mimeType: string; data: Uint8Array } | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const row = await ctx.db.select({ domain: avatarSites.domain, mimeType: avatarSites.mimeType, data: avatarSites.data }).from(avatarSites)
    .where(and(eq(avatarSites.pictureId, id), eq(avatarSites.state, "found"))).get();
  if (!row?.mimeType || row.data === null) return null;
  return { domain: row.domain, mimeType: row.mimeType, data: fromBase64(row.data) };
}

/**
 * Whether a picture may show in one of these inboxes: proved mail from its domain is there (every thread or message
 * showing it has some). Not one indexed lookup: it reads those inboxes' messages through the indexes that start with
 * the inbox, since nothing indexes a proved domain by inbox (migration 0013 is frozen). Only a caller limited to some
 * inboxes needs it, and no device that may load pictures is limited today.
 */
export async function pictureShownIn(ctx: Ctx, domain: string, inboxIds: readonly string[]): Promise<boolean> {
  if (inboxIds.length === 0) return false;
  const message = await ctx.db.select({ one: sql<number>`1` }).from(messages)
    .where(and(
      inList(messages.inboxId, inboxIds), eq(messages.outgoing, false),
      or(eq(messages.fromVerified, domain), endsWith(messages.fromVerified, `.${domain}`)),
    )).limit(1).get();
  return Boolean(message);
}

/** The domain due soonest whose time has come, or else when the next one is due (null: none). */
export async function dueSite(ctx: Ctx): Promise<{ domain: string } | { nextAt: number | null }> {
  const row: Pick<AvatarSiteRow, "domain" | "dueAt"> | undefined = await ctx.db.select({ domain: avatarSites.domain, dueAt: avatarSites.dueAt })
    .from(avatarSites).where(isNotNull(avatarSites.dueAt)).orderBy(avatarSites.dueAt, avatarSites.domain).limit(1).get();
  if (!row) return { nextAt: null };
  return row.dueAt! <= ctx.now() ? { domain: row.domain } : { nextAt: row.dueAt };
}

/** Forgets domains no mail has wanted for 180 days. Returns those that had a picture. Callers hold `ctx.lock`. */
export async function forgetUnwanted(ctx: Ctx): Promise<string[]> {
  const cutoff = ctx.now() - SITE_TIMES.unwantedForMs;
  const gone = await ctx.db.select({ domain: avatarSites.domain, pictureId: avatarSites.pictureId }).from(avatarSites)
    .where(lt(avatarSites.wantedAt, cutoff));
  if (gone.length === 0) return [];
  await ctx.db.delete(avatarSites).where(lt(avatarSites.wantedAt, cutoff));
  return gone.filter((row) => row.pictureId !== null).map((row) => row.domain);
}

/** Bytes as base64, as the store keeps a picture. */
export function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
