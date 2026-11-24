/**
 * Gmail's full form, for messages over the size limit (`largeMessageBytes`): the message's structure and headers with
 * the small parts' bytes inline, and an `attachmentId` instead of the bytes for the rest (60 quota units, as the raw
 * form). `rebuildFull` writes it back as MIME (payload.ts) for the parser the raw form goes through, so the stored
 * message matches what the raw form gives, without downloading the attachments.
 *
 * Storing a message and serving one of its attachments go through the same rounds with the same decisions, so the
 * attachments are numbered alike: what a stored message's attachment id names is what the same rebuild numbers.
 */
import { GmailApiError, failsTheBatch, type GmailClient } from "./client.ts";
import { downloadAttachment } from "./download.ts";
import { COST } from "./limits.ts";
import { rebuildMessage, type GmailPart, type Rebuilt } from "./payload.ts";
import { attachmentBytes } from "../message/parse.ts";

export interface FullGmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  historyId?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
}

export async function getFull(client: GmailClient, id: string): Promise<FullGmailMessage | undefined> {
  try {
    return await client.request<FullGmailMessage>("GET", `/messages/${encodeURIComponent(id)}`, {
      cost: COST.messagesGetFull,
      query: { format: "full" },
    });
  } catch (error) {
    if (error instanceof GmailApiError && (error.status === 404 || error.status === 400)) return undefined;
    throw error;
  }
}

export interface FullRebuild {
  rebuilt: Rebuilt;
  /**
   * Why a text part (or a forwarded message read into the text) stayed out, if one did: `size` when it didn't fit the
   * budget, `unavailable` when Gmail refused it, its answer couldn't be read, or it was nested too deep. `size` wins.
   */
  textLeftOut: "size" | "unavailable" | undefined;
  /** Parts written with no body: never to be served as an attachment. */
  emptied: ReadonlySet<GmailPart>;
}

export interface FullOptions {
  /**
   * Bytes this message may download in all (`largeMessageBytes`), shared by its text parts, forwarded messages and
   * calendar invites in the order they come. What doesn't fit stays out.
   */
  budget: number;
  /**
   * Serving an attachment: the same decisions as for storing the message, but only forwarded messages (which the
   * numbering depends on) are downloaded; text is written empty, calendar invites keep their markers, and the last
   * rebuild marks every part (`RebuildPlan.markAll`).
   */
  serve: boolean;
}

/** Rounds of forwarded messages inside forwarded messages; the parser itself reads ten levels deep. */
const MAX_ROUNDS = 12;
const CALENDAR = new Set(["text/calendar", "application/ics"]);

/**
 * Rebuilds the message, then gives each marked part the parser didn't take as an attachment what it needs, in the
 * order the parts come: a forwarded message Gmail expanded is written out from its parts; a text body or a forwarded
 * message Gmail left out is downloaded while it fits the budget; anything else is written empty. Calendar invites the
 * parser takes as attachments are downloaded while they fit too: the parser rewrites them as UTF-8, so their size
 * depends on their bytes. A download Gmail refuses, or whose answer can't be read, leaves its part out; only a
 * failure that may pass (failsTheBatch) is thrown.
 */
export async function rebuildFull(client: GmailClient, message: FullGmailMessage, options: FullOptions): Promise<FullRebuild> {
  const payload = message.payload ?? {};
  const contents = new Map<GmailPart, Uint8Array>();
  const expand = new Set<GmailPart>();
  const empty = new Set<GmailPart>();
  const decided = new Set<GmailPart>();
  let budget = options.budget;
  let textLeftOut: FullRebuild["textLeftOut"];
  const fetch = async (part: GmailPart): Promise<boolean> => {
    try {
      contents.set(part, await downloadAttachment(client, message.id, part.body!.attachmentId!, part.body?.size));
      return true;
    } catch (error) {
      if (failsTheBatch(error)) throw error;
      return false;
    }
  };
  /** Takes the part's size from the budget when it fits; the same in both modes, so both decide alike. */
  const afford = (part: GmailPart): boolean => {
    const size = part.body?.size;
    if (!part.body?.attachmentId || typeof size !== "number" || size > budget) return false;
    budget -= size;
    return true;
  };
  const final = (rebuilt?: Rebuilt): FullRebuild => ({
    rebuilt: options.serve || !rebuilt ? rebuildMessage(payload, { contents, expand, empty, markAll: options.serve }) : rebuilt,
    textLeftOut,
    emptied: empty,
  });

  for (let round = 0; ; round++) {
    const rebuilt = rebuildMessage(payload, { contents, expand, empty });
    if (!rebuilt.marked.length) return final(rebuilt);
    const attached = new Set((await attachmentBytes(rebuilt.bytes)).map((content) => rebuilt.partOf(content)));
    const deep = round >= MAX_ROUNDS;
    let expanded = false;
    let changed = false;
    for (const part of rebuilt.marked) {
      if (decided.has(part)) continue;
      decided.add(part);
      if (attached.has(part)) {
        if (!CALENDAR.has(typeOf(part))) continue;
        // In serve mode the invite keeps its marker: serving reads its bytes then.
        if (afford(part) && !options.serve && (await fetch(part))) changed = true;
        continue;
      }
      changed = true;
      const forwarded = typeOf(part) === "message/rfc822";
      if (forwarded && part.parts?.length && !deep) {
        expand.add(part);
        expanded = true;
      } else {
        const fits = !deep && afford(part);
        if (fits && (forwarded || !options.serve) && (await fetch(part))) continue;
        empty.add(part);
        if (!options.serve) textLeftOut = fits || deep ? (textLeftOut ?? "unavailable") : "size";
      }
    }
    if (!changed) return final(rebuilt);
    // Without an expansion no new part can be marked, so the next rebuild needs no further look.
    if (!expanded) return final();
  }
}

/** The part's type from its own Content-Type, else Gmail's `mimeType`. */
export function typeOf(part: GmailPart): string {
  const header = part.headers?.find((h) => h.name?.toLowerCase() === "content-type")?.value;
  return (header?.split(";")[0]?.trim() || part.mimeType || "").toLowerCase();
}
