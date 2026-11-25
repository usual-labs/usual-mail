// The shape of mail that may skip Screening (the security reviews of 2026-11-25; docs/contract-ai.md, "A model's answer
// at the screening gate"). The provider's proof says which domain sent the mail, not who wrote it: platforms carry
// anyone's words under their own domain (a comment on a shared document, a mention, a money request, a help desk's
// free trial), and a brand's real alert can be sent on to others with its signature intact. So mail of every kind but
// a code must also look sent to this person by that organisation alone:
//
// (a) no List-Id;
// (b) every Reply-To at the From's registrable domain;
// (c) To or Cc names the inbox's own address (a "+tag" ignored, and dots at gmail.com); on Gmail only a field the
//     sender's own DKIM signature vouches for (`signedRecipients`: given once, named in its h=), so a copy sent on by
//     Bcc, or with a To or Cc added on top, doesn't count. Codes need this too. It stops those replays, not every one:
//     a sender who signs a field it never wrote is beyond it;
// (d) not from a platform whose customers send from their own subdomain of it;
// (e) not from a notifier whose mail carries its users' words (a document's comments, a file shared, a calendar
//     event, a payment service's requests and receipts).
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
  "happyfox.com", "deskpro.com", "gorgias.help", "myshopify.com", "helpscoutapp.com", "service-now.com",
  "intercom-mail.com", "my.salesforce.com", "gitbook.io", "notion.site",
];

/**
 * (e) Notifiers whose mail carries their users' words under the platform's own address and proof: a comment or mention
 * in a shared document, a file shared with the sharer's note, an event someone else titled, a form's answers, and a
 * payment service's requests and receipts (anyone with an account sends them, with their own words). Where a request
 * can't be told from a security alert at the same address, the address is refused for every kind but a code: a real
 * alert waiting in Screening is the accepted cost. A starting list (the second security review of 2026-11-25).
 */
const CARRIER_ADDRESSES: ReadonlySet<string> = new Set([
  "comments-noreply@docs.google.com", "drive-shares-noreply@google.com", "drive-shares-dm-noreply@google.com",
  "calendar-notification@google.com", "forms-receipts-noreply@google.com",
]);
/** Carriers by domain: every address at it or under it. */
const CARRIER_DOMAINS: readonly string[] = ["stripe.com", "venmo.com", "square.com", "squareup.com", "sharepointonline.com"];
/** Carriers by name: every registrable domain whose first label it is (paypal.com, paypal.de, paypal.co.uk). */
const CARRIER_NAMES: ReadonlySet<string> = new Set(["paypal"]);

/** The message's headers the shape is read from. */
export interface ShapedMessage {
  from: { email: string };
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
export function addressedTo(message: { to: readonly Address[]; cc: readonly Address[] }, inboxAddress: string): boolean {
  const own = mailboxKey(inboxAddress);
  return own !== null && [...message.to, ...message.cc].some((address) => mailboxKey(address.email) === own);
}

/** (d): the domain is a tenant platform's, or under one. */
export function onTenantPlatform(domain: string): boolean {
  return TENANT_PLATFORMS.some((platform) => domain === platform || domain.endsWith(`.${platform}`));
}

/** (e): the address is a notifier's that carries its users' words. `home` is its proved registrable domain. */
export function carriesUsersWords(email: string, domain: string, home: string): boolean {
  return CARRIER_ADDRESSES.has(email.toLowerCase())
    || CARRIER_DOMAINS.some((carrier) => domain === carrier || domain.endsWith(`.${carrier}`))
    || CARRIER_NAMES.has(home.split(".")[0] ?? "");
}

/**
 * (a), (b), (d) and (e), with (c) worked out by the caller (`addressed`): mail sent to this person by the organisation
 * whose domain `domain` the checker proved, alone. `home` is that domain's registrable domain.
 */
export function soleSender(message: ShapedMessage, domain: string, home: string, addressed: boolean, suffixes: SuffixList): boolean {
  if (!addressed || message.listId || onTenantPlatform(domain) || carriesUsersWords(message.from.email, domain, home)) return false;
  return (message.replyTo ?? []).every((reply) => {
    const at = domainOf(reply.email);
    return at !== null && suffixes.registrableDomain(at) === home;
  });
}
