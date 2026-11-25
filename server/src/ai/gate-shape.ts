// The shape of mail that may skip Screening (the security review of 2026-11-25; docs/contract-ai.md, "A model's answer
// at the screening gate"). The provider's proof says which domain sent the mail, not who wrote it: platforms carry
// anyone's words under their own domain (a comment on a shared document, a mention, a money request, a help desk's
// free trial), and a brand's real alert can be sent on to others with its signature intact. So mail of every kind but
// a code must also look sent to this person by that organisation alone:
//
// (a) no List-Id;
// (b) every Reply-To at the From's registrable domain;
// (c) To or Cc names the inbox's own address (a "+tag" ignored, and dots at gmail.com), which a copy sent on by Bcc
//     doesn't; codes need this too;
// (d) not from a platform whose customers send from their own subdomain of it.
//
// Pure: the caller gives the suffix list.

import type { Address } from "@usualmail/core";
import { asciiHost } from "../avatars/host.ts";
import type { SuffixList } from "../avatars/suffixes.ts";

/**
 * Platforms anyone can sign up to whose customers send from a subdomain of the platform's domain (a help desk's
 * `acme.zendesk.com`, a shop's `acme.myshopify.com`): a trial account writes anything there under the platform's proof,
 * so their mail never skips Screening. The gate's own list; sender pictures keep theirs (`isSharedPlatform`).
 */
export const TENANT_PLATFORMS: readonly string[] = [
  "zendesk.com", "freshdesk.com", "freshservice.com", "atlassian.net", "zohodesk.com", "zohodesk.eu", "kayako.com",
  "happyfox.com", "deskpro.com", "gorgias.help", "myshopify.com",
];

/** The message's headers the shape is read from. */
export interface ShapedMessage {
  to: readonly Address[];
  cc: readonly Address[];
  replyTo: readonly Address[] | null;
  listId: string | null;
}

/** An address's domain in ASCII and lower case, or null. */
function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at > 0 ? asciiHost(email.slice(at + 1).toLowerCase()) : null;
}

/**
 * An address as its mailbox receives it: lower case, its domain in ASCII, without a "+tag"; at gmail.com (and
 * googlemail.com, the same mailboxes) without dots. Null when it isn't an address.
 */
export function mailboxKey(email: string): string | null {
  const at = email.lastIndexOf("@");
  let domain = domainOf(email);
  if (!domain) return null;
  if (domain === "googlemail.com") domain = "gmail.com";
  let local = email.slice(0, at).toLowerCase();
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "gmail.com") local = local.replaceAll(".", "");
  return local ? `${local}@${domain}` : null;
}

/** (c): To or Cc names the inbox's own address. */
export function addressedTo(message: Pick<ShapedMessage, "to" | "cc">, inboxAddress: string): boolean {
  const own = mailboxKey(inboxAddress);
  return own !== null && [...message.to, ...message.cc].some((address) => mailboxKey(address.email) === own);
}

/** (d): the domain is a tenant platform's, or under one. */
export function onTenantPlatform(domain: string): boolean {
  return TENANT_PLATFORMS.some((platform) => domain === platform || domain.endsWith(`.${platform}`));
}

/**
 * (a) to (d): mail sent to this person by the organisation whose domain `domain` the checker proved, alone. `home` is
 * that domain's registrable domain.
 */
export function soleSender(message: ShapedMessage, domain: string, home: string, inboxAddress: string, suffixes: SuffixList): boolean {
  if (message.listId || onTenantPlatform(domain)) return false;
  const replies = message.replyTo ?? [];
  if (!replies.every((reply) => {
    const at = domainOf(reply.email);
    return at !== null && suffixes.registrableDomain(at) === home;
  })) return false;
  return addressedTo(message, inboxAddress);
}
