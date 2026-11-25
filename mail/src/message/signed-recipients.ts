/**
 * Which recipient fields of a message its sender's own DKIM signature vouches for (`ProviderMessage.signedRecipients`;
 * the screening gate's security reviews of 2026-11-25). A real alert addressed to someone else can be sent on with its
 * signature intact and a To or Cc naming the victim added: most signers don't sign a Cc that wasn't there, and a parser
 * merges a second To with the first. So the gate counts a recipient field only when the sender's signature names it.
 *
 * **The check is monotone: anything whoever passes the mail on can add to its headers or alter in them only takes
 * fields away, never adds one.** Three rounds of review each found one more way to make a real signature not count so
 * that a forged one decided, so the check no longer needs to know which signature is the real one:
 *
 * 1. The provider's own checker, whose result tops the message and can't be forged under its name (auth-results.ts),
 *    says a DKIM signature by the From address's organisation passed. A passing signature is in the message the
 *    checker read, so it is among the message's DKIM-Signature fields: one of them is real, though which is unknown.
 * 2. The fields are the intersection of the `h=` of **every** signature whose `d=` is in that organisation, whether or
 *    not it matches a result. The real one is among them, so nothing outside its `h=` can count; a signature added by
 *    anyone else can only shrink the intersection. At least one of them must also match a passing result (its `d=`
 *    the result's `header.d`, or `header.i`'s domain or a parent of it, and its first characters `header.b` when given),
 *    so a message whose real signature isn't among the fields read has none; matching picks no signature, so a
 *    signature fitting no result, or more than one fitting, changes nothing else.
 * 3. Whatever can't be read or placed leaves no field at all, never a signature skipped: a signature that can't be read
 *    (a tag twice, over 16 KB), lacks `d=`, `h=` or `b=`, has a `d=` that isn't a host name or has no organisation, or
 *    whose first characters a result that didn't pass names (`header.b`); more than 16 signatures; a header line that
 *    is neither a field nor a fold (a parser stops reading fields there, so the fields below, the real signature among
 *    them, would go unread: `headerBlockReadable`).
 * 4. A field counts only when the message gives it once: a To or Cc added on top makes it twice, and a field named
 *    with spaces before its colon ("To :") is counted all the same.
 *
 * So adding a field can only add a signature to the intersection, a recipient field to the count or an unreadable
 * line; altering one can only make a signature unreadable, fail it (then no result passes for the organisation, or
 * another real signature still bounds the intersection) or change a value the real signature doesn't sign. Each of
 * those only takes fields away. Pure, and linear in the headers' length.
 */
import { asciiDomain, fieldName, namedDomain, parseAuthenticationResults, topAuthenticationResults, type AuthenticationOptions, type AuthenticationResult, type HeaderField } from "./auth-results.ts";

export type RecipientField = "to" | "cc";

/** Longer signatures, or more of them, are left unread: no signer writes them. */
const LIMITS = { length: 16_384, signatures: 16 };

/**
 * A DKIM-Signature's tags, values without whitespace (RFC 6376 3.2). Tag names are case-sensitive there, so they are
 * kept as written: "D=" is no `d=`. Null when it can't be read.
 */
function tagsOf(value: string): Map<string, string> | null {
  if (value.length > LIMITS.length) return null;
  const tags = new Map<string, string>();
  for (const part of value.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0) {
      if (part.trim()) return null;
      continue;
    }
    const name = part.slice(0, equals).trim();
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
 * The recipient fields the sender's organisation's DKIM signatures all sign, among those the message gives once. The
 * caller has found that the provider's checker proved `fromDomain` from its topmost result (`fromCheckOf`).
 */
export function signedRecipients(headers: readonly HeaderField[], fromDomain: string, options: AuthenticationOptions): RecipientField[] {
  const counts = { to: 0, cc: 0 };
  for (const field of headers) {
    const name = fieldName(field);
    if (name === "to" || name === "cc") counts[name]++;
  }
  if (counts.to > 1 || counts.cc > 1) return [];
  const top = topAuthenticationResults(headers);
  const parsed = top ? parseAuthenticationResults(top.value) : null;
  const organisation = options.organisationalDomain(fromDomain);
  if (!parsed || !organisation) return [];
  const dkim = parsed.results.filter((entry) => entry.method === "dkim");
  // 1: a signature by the From address's organisation passed, by the checker's own word.
  const passedHere = dkim.some((entry) => {
    const signer = namedDomain(entry, "header.d") ?? namedDomain(entry, "header.i");
    return entry.result === "pass" && signer !== null && options.organisationalDomain(signer) === organisation;
  });
  if (!passedHere) return [];
  // The first characters of each signature a result says didn't pass.
  const failedShown = dkim.filter((entry) => entry.result !== "pass").map((entry) => property(entry, "header.b")).filter((shown): shown is string => Boolean(shown));
  const signatures = headers.filter((field) => fieldName(field) === "dkim-signature");
  if (signatures.length > LIMITS.signatures) return [];
  let covered = null as Set<string> | null;
  let matched = false;
  for (const field of signatures) {
    const tags = tagsOf(field.value);
    const written = tags?.get("d");
    const signedFields = tags?.get("h");
    const signature = tags?.get("b");
    // 3: one that can't be read or placed could be the real one, so nothing counts.
    if (!tags || !written || !signedFields || !signature) return [];
    const domain = asciiDomain(written);
    const home = domain ? options.organisationalDomain(domain) : null;
    if (!home || failedShown.some((shown) => signature.startsWith(shown))) return [];
    if (home !== organisation) continue;
    if (!matched) matched = dkim.some((entry) => entry.result === "pass" && fits(entry, domain!, signature));
    // 2: every signature of the organisation bounds what counts, matched to a result or not.
    const names = new Set(signedFields.split(":").map((name) => name.trim().toLowerCase()));
    const before: Set<string> | null = covered;
    covered = before === null ? names : new Set([...before].filter((name) => names.has(name)));
  }
  if (covered === null || !matched) return [];
  const signed: Set<string> = covered;
  return (["to", "cc"] as const).filter((name) => counts[name] === 1 && signed.has(name));
}

/**
 * Whether a signature with domain `domain` (ASCII) and value `signature` is the one a result names: its domain is the
 * result's `header.d`, or `header.i`'s domain is it or under it (i= may name a subdomain of d=, RFC 6376 3.5), and it
 * starts with the result's `header.b` when Gmail prints one.
 */
function fits(entry: AuthenticationResult, domain: string, signature: string): boolean {
  const signer = namedDomain(entry, "header.d");
  const identity = namedDomain(entry, "header.i");
  const named = signer !== null ? signer === domain : identity !== null && (identity === domain || identity.endsWith(`.${domain}`));
  const shown = property(entry, "header.b");
  return named && (shown === undefined || signature.startsWith(shown));
}

/** A field's first line: a name of visible ASCII but ":" (spaces may come before the colon), then the colon. */
const FIELD_LINE = /^[\x21-\x39\x3b-\x7e]+[ \t]*:/;

/**
 * Whether every line of the message's header block is a field or the fold of one. A parser stops reading fields at
 * the first line that is neither (no colon, a space inside a name, a byte that isn't visible ASCII), and everything
 * after it becomes body: a forged signature and an added Cc above such a line, the real signature below it, would read
 * as the only ones (the final review's attack). Linear in the block's length; the block ends at the first empty line.
 */
export function headerBlockReadable(raw: Uint8Array | string): boolean {
  const text = typeof raw === "string" ? raw : latin1(raw);
  const end = text.search(/\r?\n\r?\n/);
  const block = end < 0 ? text : text.slice(0, end);
  for (const line of block.split(/\r?\n/)) {
    if (line === "" || line[0] === " " || line[0] === "\t") continue;
    if (!FIELD_LINE.test(line)) return false;
  }
  return true;
}

/** The header block's bytes as one character each, for reading names: no byte is lost or merged. */
function latin1(bytes: Uint8Array): string {
  const end = Math.min(bytes.length, findBlockEnd(bytes));
  let out = "";
  for (let at = 0; at < end; at += 8192) out += String.fromCharCode(...bytes.subarray(at, Math.min(end, at + 8192)));
  return out;
}

/** Where the header block ends in the bytes (its blank line), or their length. */
function findBlockEnd(bytes: Uint8Array): number {
  for (let at = 0; at + 1 < bytes.length; at++) {
    if (bytes[at] !== 10) continue;
    if (bytes[at + 1] === 10 || (bytes[at + 1] === 13 && bytes[at + 2] === 10)) return at + 1;
  }
  return bytes.length;
}
