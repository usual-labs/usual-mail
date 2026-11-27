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

/**
 * Which of a newsletter's unsubscribe headers the sender's own signature vouches for (`ProviderMessage.signedUnsubscribe`;
 * docs/contract.md, "Unsubscribing"; the security reviews of 2026-11-27): List-Unsubscribe and List-Unsubscribe-Post,
 * each given once and named in every aligned signature's `h=`. Monotone as the recipient fields are. Nothing of the body
 * is read: a link there may be someone else's words the sender's mail repeats.
 */
export type SignedUnsubscribePart = "list-unsubscribe" | "list-unsubscribe-post";

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
  const signed = signedFields(headers, fromDomain, options);
  if (!signed) return [];
  return (["to", "cc"] as const).filter((name) => counts[name] === 1 && signed.has(name));
}

/**
 * The unsubscribe headers the sender's organisation's DKIM signatures all sign, each given once. Under the same rules
 * and with the same caller's proof as `signedRecipients`.
 */
export function signedUnsubscribe(headers: readonly HeaderField[], fromDomain: string, options: AuthenticationOptions): SignedUnsubscribePart[] {
  const counts = new Map<string, number>([["list-unsubscribe", 0], ["list-unsubscribe-post", 0]]);
  for (const field of headers) {
    const name = fieldName(field);
    if (counts.has(name)) counts.set(name, counts.get(name)! + 1);
  }
  const signed = signedFields(headers, fromDomain, options);
  if (!signed) return [];
  return (["list-unsubscribe", "list-unsubscribe-post"] as const).filter((name) => counts.get(name) === 1 && signed.has(name));
}

/**
 * The header fields every DKIM signature of the From address's organisation names in its `h=`; null when the checker's
 * word or the signatures leave nothing to count (steps 1 to 3 above).
 */
function signedFields(headers: readonly HeaderField[], fromDomain: string, options: AuthenticationOptions): Set<string> | null {
  const top = topAuthenticationResults(headers);
  const parsed = top ? parseAuthenticationResults(top.value) : null;
  const organisation = options.organisationalDomain(fromDomain);
  if (!parsed || !organisation) return null;
  const dkim = parsed.results.filter((entry) => entry.method === "dkim");
  // 1: a signature by the From address's organisation passed, by the checker's own word.
  const passedHere = dkim.some((entry) => {
    const signer = namedDomain(entry, "header.d") ?? namedDomain(entry, "header.i");
    return entry.result === "pass" && signer !== null && options.organisationalDomain(signer) === organisation;
  });
  if (!passedHere) return null;
  // The first characters of each signature a result says didn't pass.
  const failedShown = dkim.filter((entry) => entry.result !== "pass").map((entry) => property(entry, "header.b")).filter((shown): shown is string => Boolean(shown));
  const signatures = headers.filter((field) => fieldName(field) === "dkim-signature");
  if (signatures.length > LIMITS.signatures) return null;
  let covered = null as Set<string> | null;
  let matched = false;
  for (const field of signatures) {
    const tags = tagsOf(field.value);
    const written = tags?.get("d");
    const signedFields = tags?.get("h");
    const signature = tags?.get("b");
    // 3: one that can't be read or placed could be the real one, so nothing counts.
    if (!tags || !written || !signedFields || !signature) return null;
    const domain = asciiDomain(written);
    const home = domain ? options.organisationalDomain(domain) : null;
    if (!home || failedShown.some((shown) => signature.startsWith(shown))) return null;
    if (home !== organisation) continue;
    if (!matched) matched = dkim.some((entry) => entry.result === "pass" && fits(entry, domain!, signature));
    // 2: every signature of the organisation bounds what counts, matched to a result or not.
    const names = new Set(signedFields.split(":").map((name) => name.trim().toLowerCase()));
    const before: Set<string> | null = covered;
    covered = before === null ? names : new Set([...before].filter((name) => names.has(name)));
  }
  if (covered === null || !matched) return null;
  return covered;
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

/** The most of a message read for its header block: no real one is longer. Past it, the block counts as unreadable. */
const HEADER_BLOCK_LIMIT = 2 * 1024 * 1024;
const LF = 10;
const CR = 13;

/**
 * Whether the message's header block reads the same to every parser: every line, up to and including the blank line
 * that ends it, is a field (a name of visible ASCII but ":", spaces allowed before the colon, then the colon) or the
 * fold of one, and every line ends the same way (all CRLF, or all LF) with no CR anywhere else. A parser stops reading
 * fields at the first line that is neither (no colon, a space inside a name, a byte that isn't visible ASCII), and
 * postal-mime ends lines at a lone LF, so `X-C: z\n\r\n` reads to it as a blank line where a CRLF reader sees none: a
 * forged signature and an added Cc above either, the real signature below, would read as the only ones (the fourth
 * and fifth reviews' attacks). Walks the raw bytes or characters line by line, stopping at the first line that fails
 * or at the blank line, and reads at most 2 MiB: a block that doesn't end by then counts as unreadable.
 */
export function headerBlockReadable(raw: Uint8Array | string): boolean {
  const code = typeof raw === "string" ? (i: number) => raw.charCodeAt(i) : (i: number) => raw[i]!;
  const length = Math.min(raw.length, HEADER_BLOCK_LIMIT + 2);
  const lineOk = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) if (code(i) === CR) return false;
    if (from === to || code(from) === 0x20 || code(from) === 0x09) return true;
    let i = from;
    for (let c = code(i); i < to && c >= 0x21 && c <= 0x7e && c !== 0x3a; c = code(++i));
    if (i === from) return false;
    while (i < to && (code(i) === 0x20 || code(i) === 0x09)) i++;
    return i < to && code(i) === 0x3a;
  };
  let ending = 0;
  for (let start = 0; ;) {
    let end = start;
    while (end < length && code(end) !== LF) end++;
    if (end >= length) return raw.length <= HEADER_BLOCK_LIMIT && lineOk(start, raw.length);
    const crlf = end > start && code(end - 1) === CR;
    const kind = crlf ? 2 : 1;
    if (ending === 0) ending = kind;
    else if (ending !== kind) return false;
    const stop = crlf ? end - 1 : end;
    if (stop === start) return true;
    if (!lineOk(start, stop)) return false;
    start = end + 1;
  }
}
