// Finding an inbox or a device by what a person types: its id, its name, or (for an inbox) its address.

import type { Inbox } from "@usualmail/core";
import type { Client } from "./client.ts";
import { Failure } from "./errors.ts";

export async function findInbox(client: Client, ref: string): Promise<Inbox> {
  const inboxes = await client.call<Inbox[]>("listInboxes");
  return pick(inboxes, ref, "inbox", "usual-mail inbox list", (inbox) => [inbox.name, inbox.address]);
}

/** By id first, then by name or address, ignoring case. Several matches is an error that lists their ids. */
export function pick<T extends { id: string }>(
  items: T[],
  ref: string,
  word: string,
  listCommand: string,
  names: (item: T) => string[],
): T {
  const byId = items.find((item) => item.id === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const matches = items.filter((item) => names(item).some((name) => name.toLowerCase() === wanted));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Failure(
      `More than one ${word} is called "${ref}": ${matches.map((item) => item.id).join(", ")}. Name it by its id.`,
      "invalid",
    );
  }
  throw new Failure(`No ${word} is called "${ref}". \`${listCommand}\` shows them, with their ids.`, "not_found");
}
