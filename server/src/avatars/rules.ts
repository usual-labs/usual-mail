// When a sender's logo may be shown, as far as the mail itself decides it (docs/contract-avatars.md): the provider's
// own checker proved the From domain, the mail is an organisation's, and the domain isn't a mailbox provider's anyone
// can sign up to. Whether the sender is let in and the thread isn't screened is the store's to say (`settle.ts`).

import type { Category } from "@usualmail/core";
import { isFreemail, isSharedPlatform } from "./freemail.ts";
import { asciiHost } from "./host.ts";
import type { SuffixList } from "./suffixes.ts";

/** The categories that are always an organisation's mail: everything filed, a one-time code included. */
const ORGANISATIONS: ReadonlySet<Category> = new Set(["newsletter", "invoice", "receipt", "notification", "otp"]);

/**
 * Whether mail is an organisation's rather than a person's: machine-sent (list headers, no-reply, bulk), or in a
 * filed category. A person writing from their company's domain is a person: initials.
 */
export function organisational(category: Category, automated: boolean): boolean {
  return automated || ORGANISATIONS.has(category);
}

/**
 * The registrable domain a logo is kept under for mail from `email` whose From domain the checker proved to be
 * `verified`, or null: the proved domain must be the address's own, not a platform's whose customers share it, have a
 * registrable domain by the list, and not be a mailbox provider's anyone can sign up to.
 */
export function avatarDomain(verified: string | null, email: string, suffixes: SuffixList): string | null {
  if (!verified) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || asciiHost(email.slice(at + 1)) !== verified || isSharedPlatform(verified)) return null;
  const registrable = suffixes.registrableDomain(verified);
  return registrable && !isFreemail(registrable) ? registrable : null;
}
