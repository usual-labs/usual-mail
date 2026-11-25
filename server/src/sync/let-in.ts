// Senders let in for good when their mail arrives, without the AI (docs/contract.md, "Letting a sender in"; the
// owner's decision of 2026-11-25): another inbox connected on this server, and a colleague at the inbox's own domain
// when that domain isn't a public mail domain or a shared platform's. Both only when the mailbox provider's checker
// proved the From domain (`ProviderMessage.fromCheck`): anyone can write any From. The inbox's own address is never let
// in by this, as by no other way but `allow_sender` (`markKnown`). Runs under `ctx.lock`.

import { isPublicMailDomain, isSharedPlatform, type ProviderMessage } from "@usualmail/core";
import { asciiHost } from "../avatars/host.ts";
import { inboxes, type InboxRow } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { markKnown, senderStatus } from "../service/store.ts";

/** The domain of an address, in ASCII and lower case, or null. */
function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at > 0 ? asciiHost(email.slice(at + 1).toLowerCase()) : null;
}

/** Every inbox's address on this server, lower case: read once per batch, when first needed. */
export function serverAddresses(ctx: Ctx): () => Promise<Set<string>> {
  let found: Promise<Set<string>> | null = null;
  return () => (found ??= ctx.db.select({ address: inboxes.address }).from(inboxes).then((rows) => new Set(rows.map((row) => row.address.toLowerCase()))));
}

/**
 * Whether the message's sender is one of the person's own, proved: another inbox on this server, or someone at this
 * inbox's own domain when it is no public mail domain. Never the inbox's own address, never the mailbox's own mail.
 */
export async function provedOwnSender(ctx: Ctx, inbox: InboxRow, message: ProviderMessage, addresses: () => Promise<Set<string>>): Promise<boolean> {
  if (message.outgoing || message.fromCheck?.result !== "verified") return false;
  const email = message.from.email.toLowerCase();
  const domain = domainOf(email);
  // The checker proved exactly the From address's own domain.
  if (!domain || message.fromCheck.domain.toLowerCase() !== domain) return false;
  const own = inbox.address.toLowerCase();
  if (email === own) return false;
  if ((await addresses()).has(email)) return true;
  if (domain !== domainOf(own)) return false;
  const registrable = ctx.avatars?.suffixes.registrableDomain(domain) ?? null;
  return registrable !== null && !isPublicMailDomain(registrable) && !isSharedPlatform(domain);
}

/**
 * Lets the sender of new incoming mail in when they are one of the person's own (`provedOwnSender`) and not let in
 * or blocked yet: like every way in, their screened threads stop being screened. Returns the threads that changed,
 * for the caller to write back. Not for the first sync's history, which lets its senders in its own way.
 */
export async function letInOwnSender(ctx: Ctx, inbox: InboxRow, message: ProviderMessage, addresses: () => Promise<Set<string>>): Promise<string[]> {
  if (message.placement.screened || !await provedOwnSender(ctx, inbox, message, addresses)) return [];
  if (await senderStatus(ctx, inbox.id, message.from.email.toLowerCase()) !== null) return [];
  return markKnown(ctx, inbox.id, [message.from.email]);
}
