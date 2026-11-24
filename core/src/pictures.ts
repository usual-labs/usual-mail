/**
 * Pictures from the web in a message's HTML. The server shows them through itself and takes trackers out before
 * anything is fetched; docs/contract.md ("Pictures from the web") has the rules.
 */
import type { Id } from "./domain.ts";

/** Why a message's pictures from the web are held back: its thread is screened, or its sender is blocked. */
export type PicturesHeldBack = "screened" | "blocked";

/** What the server did with the pictures a message's HTML takes from the web. */
export interface RemotePictures {
  /** Pictures shown through the server: the HTML points each at `picturePath(message, picture)`. */
  shown: number;
  /**
   * Tracking pictures taken out before anything was fetched: those on the server's list of trackers, and tiny or
   * hidden ones.
   */
  trackersRemoved: number;
  /** Who made the trackers the list knows, by the list's names, each once, in alphabetical order. */
  trackers: string[];
  /**
   * Set when the message's other pictures from the web are held back, so none is shown, until its sender is let in:
   * its thread is screened, or its sender is blocked.
   */
  heldBack?: PicturesHeldBack;
}

/** The most pictures from the web one message shows; any further ones are left out. */
export const MAX_PICTURES_PER_MESSAGE = 100;

/**
 * The longest HTML, in characters, the server shows. Longer HTML (ten times Gmail's own clipping size and more) is
 * left out of the message, which comes with its text and `htmlTooLarge`, so a huge mail can't stall the server.
 */
export const MAX_SHOWN_HTML_LENGTH = 1_000_000;

/**
 * Where a message's HTML points a picture from the web it shows: the picture route under the server's root,
 * `/v1/messages/<message id>/pictures/<picture id>`. Only a person's device may load it.
 */
export function picturePath(messageId: Id, pictureId: string): string {
  return `/v1/messages/${encodeURIComponent(messageId)}/pictures/${encodeURIComponent(pictureId)}`;
}
