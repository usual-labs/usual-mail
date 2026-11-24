// Pictures from the web in the messages the service serves, and the picture route (docs/contract.md, "Pictures from
// the web"). The HTML is written again every time a message is served, from the HTML stored when it was read, so a
// sender let in later gets their pictures shown and a newer tracker list reaches older mail.

import { MAX_SHOWN_HTML_LENGTH, ServiceError, type Address, type Caller, type Id, type Message, type PicturesHeldBack } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { messages, type ThreadRow } from "../db/index.ts";
import type { ServedPicture } from "../host.ts";
import { presentPictures, shownPictureUrl } from "../pictures/present.ts";
import { PictureRefused } from "../pictures/refused.ts";
import { requirePerson, requireThread } from "./access.ts";
import type { Ctx } from "./context.ts";
import { blockedSenders } from "./store.ts";

/**
 * Why a message's pictures from the web are held back, if they are: the address it says it is from, or its thread's
 * sender, is blocked; or its thread is screened. Every message of such a thread, the inbox's own included: whether
 * mail is "outgoing" is read from its From, which anyone can write (the security review of 2026-11-18), so it
 * exempts nothing. This also covers a blocked sender's message in someone else's thread, which isn't shown at all.
 */
export function picturesHeldBack(
  thread: Pick<ThreadRow, "screened" | "sender">,
  message: { from: Address },
  blocked: ReadonlySet<string>,
): PicturesHeldBack | undefined {
  const from = message.from.email.toLowerCase();
  if (blocked.has(from) || (thread.sender !== null && blocked.has(thread.sender))) return "blocked";
  return thread.screened ? "screened" : undefined;
}

/**
 * A message as the service serves it: its HTML with its pictures from the web decided, and `remotePictures`. HTML
 * longer than MAX_SHOWN_HTML_LENGTH is left out (`htmlTooLarge`): its text stands for it. HTML the picture pass fails
 * on is left out too, and logged with a reason code only, so one message never breaks a thread or a list.
 */
export async function withPictures(ctx: Ctx, message: Message, held: PicturesHeldBack | undefined): Promise<Message> {
  if (message.html === undefined) return message;
  const out: Message = { ...message };
  if (message.html.length > MAX_SHOWN_HTML_LENGTH) {
    delete out.html;
    out.htmlTooLarge = true;
    return out;
  }
  let presented: Awaited<ReturnType<typeof presentPictures>>;
  try {
    presented = await presentPictures(message.id, message.html, held, ctx.picturePlans);
  } catch (error) {
    ctx.host.log.error(`The picture pass failed for message ${message.id}: ${error instanceof Error ? error.name : "unknown"}`);
    delete out.html;
    return out;
  }
  const { html, remotePictures } = presented;
  if (html) out.html = html;
  else delete out.html;
  if (remotePictures) out.remotePictures = remotePictures;
  return out;
}

/**
 * The picture a message shows as `pictureId`, for a person's device: fetched from the web once, then from the cache.
 * Only an address the message's stored HTML shows can be fetched; anything else is `not_found`, as is a message the
 * caller can't read or one whose pictures are held back.
 */
export async function fetchPicture(ctx: Ctx, caller: Caller, messageId: Id, pictureId: string): Promise<ServedPicture> {
  requirePerson(caller, "load pictures from the web");
  const message = await ctx.db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!message) throw new ServiceError("not_found", "No such message");
  const { thread, inbox } = await requireThread(ctx, caller, message.threadId).catch(() => {
    throw new ServiceError("not_found", "No such message");
  });
  const blocked = await blockedSenders(ctx, inbox.id);
  const url = message.html === null ? null : await shownPictureUrl(message.id, message.html, pictureId, picturesHeldBack(thread, message, blocked), ctx.picturePlans);
  if (!url) throw new ServiceError("not_found", "No such picture in this message");
  const source = ctx.host.pictures;
  if (!source) throw new ServiceError("not_found", "This server doesn't load pictures from the web");
  try {
    return await source.get(inbox.id, url);
  } catch (error) {
    if (error instanceof PictureRefused) {
      throw new ServiceError("provider_error", `The picture couldn't be loaded: ${error.message}`);
    }
    throw error;
  }
}

/** Forgets the pictures kept for a removed inbox, in the background; a failure is only logged. */
export async function forgetPictures(ctx: Ctx, inboxId: Id): Promise<void> {
  try {
    await ctx.host.pictures?.forget(inboxId);
  } catch (error) {
    ctx.host.log.error(`Couldn't forget the pictures kept for removed inbox ${inboxId}`, error);
  }
}
