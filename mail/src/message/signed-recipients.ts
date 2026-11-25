/**
 * Which recipient fields of a message its sender's own DKIM signature vouches for (`ProviderMessage.signedRecipients`;
 * the screening gate's security review of 2026-11-25). A real alert addressed to someone else can be sent on with its
 * signature intact and a To or Cc naming the victim added on top: most signers don't sign a Cc that wasn't there, and a
 * parser merges a second To with the first. So a recipient field counts as the sender's only when it appears once in
 * the message and every DKIM signature aligned with the From domain that the provider's own checker passed names it in
 * its `h=` tag. A message giving To or Cc twice has none.
 *
 * Which signature passed is read from the checker's result: Gmail prints each passing signature's first characters
 * (`header.b`), else its domain. Every aligned signature that fits counts, and a field must be signed by all of them:
 * a signature added by whoever passed the mail on can only take a field away, never add one. Pure, and linear in the
 * headers' length.
 */
import { namedDomain, parseAuthenticationResults, type AuthenticationOptions, type AuthenticationResult, type HeaderField } from "./auth-results.ts";

export type RecipientField = "to" | "cc";

/** Longer signatures, or more of them, are left unread: no signer writes them. */
const LIMITS = { length: 16_384, signatures: 16 };
/** The fewest characters of a signature a checker's `header.b` must show to name it. */
const SHOWN = 8;

/** A DKIM-Signature's tags, names lower case, values without whitespace (RFC 6376 3.2). Null when it can't be read. */
function tagsOf(value: string): Map<string, string> | null {
  if (value.length > LIMITS.length) return null;
  const tags = new Map<string, string>();
  for (const part of value.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0) {
      if (part.trim()) return null;
      continue;
    }
    const name = part.slice(0, equals).trim().toLowerCase();
    // A tag given twice makes a signature invalid.
    if (!name || tags.has(name)) return null;
    tags.set(name, part.slice(equals + 1).replace(/\s+/g, ""));
  }
  return tags;
}

/** The first value a result gives for a property, as written. */
function property(entry: AuthenticationResult, name: string): string | undefined {
  return entry.properties.find(([key]) => key === name)?.[1];
}

/**
 * The recipient fields the sender's aligned, passed DKIM signatures all sign, among those the message gives once. The
 * caller has found that the provider's checker proved `fromDomain` from its topmost result (`fromCheckOf`).
 */
export function signedRecipients(headers: readonly HeaderField[], fromDomain: string, options: AuthenticationOptions): RecipientField[] {
  const counts = { to: 0, cc: 0 };
  for (const field of headers) {
    const key = field.key.toLowerCase();
    if (key === "to" || key === "cc") counts[key]++;
  }
  if (counts.to > 1 || counts.cc > 1) return [];
  const top = headers.find((field) => field.key.toLowerCase() === "authentication-results");
  const parsed = top ? parseAuthenticationResults(top.value) : null;
  const organisation = options.organisationalDomain(fromDomain);
  if (!parsed || !organisation) return [];
  const passed = parsed.results.filter((entry) => entry.method === "dkim" && entry.result === "pass");
  let covered = null as Set<string> | null;
  const signatures = headers.filter((field) => field.key.toLowerCase() === "dkim-signature");
  if (signatures.length > LIMITS.signatures) return [];
  for (const field of signatures) {
    const tags = tagsOf(field.value);
    const domain = tags?.get("d")?.toLowerCase();
    const signedFields = tags?.get("h");
    if (!tags || !domain || !signedFields || options.organisationalDomain(domain) !== organisation) continue;
    const signature = tags.get("b") ?? "";
    const fits = passed.some((entry) => {
      const shown = property(entry, "header.b");
      if (shown !== undefined && shown.length >= SHOWN) return signature.startsWith(shown);
      return (namedDomain(entry, "header.d") ?? namedDomain(entry, "header.i")) === domain;
    });
    if (!fits) continue;
    const names = new Set(signedFields.split(":").map((name) => name.trim().toLowerCase()));
    const before: Set<string> | null = covered;
    covered = before === null ? names : new Set([...before].filter((name) => names.has(name)));
  }
  if (covered === null) return [];
  const signed: Set<string> = covered;
  return (["to", "cc"] as const).filter((name) => counts[name] === 1 && signed.has(name));
}
