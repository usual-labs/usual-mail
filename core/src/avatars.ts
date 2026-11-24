/**
 * Sender pictures: an organisation's own site icon shown for mail its domain is proved to have sent, kept by the server
 * and served through it. docs/contract-avatars.md has the rules: when a picture is shown, what is fetched and when,
 * what it reveals and what it doesn't protect.
 */

/**
 * How an app draws the picture in its round avatar. `fill`: a full square made to be cut to a circle (a maskable
 * manifest icon, an apple-touch-icon): scaled to fill the circle. `inset`: a mark that may sit on transparency (any other
 * icon): scaled to fit inside the circle on a white disc, with some padding.
 */
export type AvatarFit = "fill" | "inset";

/** The picture an app shows for a thread's sender or a message's From, instead of initials. */
export interface Avatar {
  /** The picture route under the server's root (`avatarPath`). The id changes whenever the picture does. */
  picture: string;
  fit: AvatarFit;
  /** The picture's longer side in pixels, as the server serves it (at least 16). */
  size: number;
}

/** The only types the picture route serves. An icon file is served as the PNG the server wrote from it. */
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/**
 * Where a sender picture is served: `/v1/avatars/<id>` under the server's root, a person's device only. The same
 * picture always has the same id, and a changed picture a new one, so an app may keep it for as long as it likes.
 */
export function avatarPath(id: string): string {
  return `/v1/avatars/${encodeURIComponent(id)}`;
}
