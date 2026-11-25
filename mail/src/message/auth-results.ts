/**
 * Whether the mailbox provider's own checker proved a message's From domain, read from the Authentication-Results
 * header it stamps on mail it receives (RFC 8601). Only the topmost such header counts, and only when the provider's
 * own checker wrote it: a receiving server adds its header above every earlier one and must remove forged copies of
 * its own name (RFC 8601 sections 4 and 5), so anything lower down may be the sender's. The From domain is proved by a
 * DMARC pass for exactly the domain the From address shows, or, when the header has no DMARC result at all (Gmail
 * writes one only when the domain publishes a DMARC record), by a DKIM pass whose signing domain shares the From
 * domain's organisational domain (DMARC's relaxed alignment, RFC 7489). Any DMARC failure loses. What can't be read is
 * no proof. The server shows a sender's logo only for a proved domain, so a forged From can't borrow a brand's logo.
 */
import type { FromCheck } from "@usualmail/core";
import { addressParser } from "postal-mime";

/** The name Gmail's own checker writes its results under. */
export const GMAIL_CHECKER = "mx.google.com";

/** One header field as a parser hands it over, top first. Names are matched without regard to case. */
export interface HeaderField {
  key: string;
  value: string;
}

export interface AuthenticationOptions {
  /** The name the provider's own checker writes its results under (its authserv-id), for example "mx.google.com". */
  checker: string;
  /** The organisational domain of a domain in ASCII (its registrable domain), or null when it has none. */
  organisationalDomain: (domain: string) => string | null;
}

export type FromAuthentication =
  /** The provider's checker proved the From address's domain (lower case, ASCII). */
  | { result: "verified"; domain: string; by: "dmarc" | "dkim" }
  /** No Authentication-Results header at all. */
  | { result: "no_header" }
  /** The topmost Authentication-Results header is another checker's, which proves nothing here. */
  | { result: "other_checker" }
  /**
   * More than one Authentication-Results header names the provider's own checker: mail forwarded through it twice, or
   * brought in some other way, where the topmost may not be the provider's own. Proves nothing.
   */
  | { result: "repeated" }
  | { result: "unverified"; reason: UnverifiedReason };

export type UnverifiedReason =
  /** A DMARC result failed. */
  | "dmarc_failed"
  /** DMARC passed for another domain than the one the From address shows, or for none named. */
  | "not_aligned"
  /** Nothing passed that proves the From domain. */
  | "no_pass"
  /** The From field isn't one field naming one mailbox at a host name. */
  | "from_unusable"
  /** The topmost header couldn't be read. */
  | "malformed";

export interface AuthenticationResult {
  /** The method, lower case and without its version: "dkim", "spf", "dmarc". */
  method: string;
  /** The result, lower case: "pass", "fail", "none". */
  result: string;
  /** Its properties and reason in order, names lower case ("header.from", "reason"), values as written. */
  properties: Array<[string, string]>;
}

export interface AuthenticationResults {
  /** The checker's name as written, without quotes. */
  checker: string;
  results: AuthenticationResult[];
}

/**
 * A header field's name as compared: lower case, without the spaces a parser may keep before its colon ("To :"). Every
 * lookup here and in signed-recipients.ts uses it, so a field written that way counts like any other (one more From,
 * one more Authentication-Results), which only takes proof away.
 */
export const fieldName = (field: HeaderField): string => field.key.trim().toLowerCase();

/** The topmost Authentication-Results field, the only one a receiving checker's can be. */
export function topAuthenticationResults(headers: readonly HeaderField[]): HeaderField | undefined {
  return headers.find((field) => fieldName(field) === "authentication-results");
}

/** Longer values, deeper comments, more results or properties are refused unread: no checker writes them. */
const LIMITS = { length: 16_384, depth: 16, results: 64, properties: 32 };

/** What the provider's own checker proved about the From domain. */
export function fromAuthentication(headers: readonly HeaderField[], options: AuthenticationOptions): FromAuthentication {
  const top = topAuthenticationResults(headers);
  if (!top) return { result: "no_header" };
  const parsed = parseAuthenticationResults(top.value);
  if (!parsed) return { result: "unverified", reason: "malformed" };
  const trusted = checkerName(options.checker);
  if (!trusted || checkerName(parsed.checker) !== trusted) return { result: "other_checker" };
  const ours = headers.filter((field) => fieldName(field) === "authentication-results" && checkerIn(field.value) === trusted);
  if (ours.length > 1) return { result: "repeated" };
  const fromDomain = singleFromDomain(headers);
  if (!fromDomain) return { result: "unverified", reason: "from_unusable" };

  const dmarc = parsed.results.filter((entry) => entry.method === "dmarc");
  if (dmarc.some((entry) => entry.result === "fail")) return { result: "unverified", reason: "dmarc_failed" };
  const passed = dmarc.filter((entry) => entry.result === "pass");
  if (passed.some((entry) => namedDomain(entry, "header.from") === fromDomain)) return { result: "verified", domain: fromDomain, by: "dmarc" };
  if (passed.length > 0) return { result: "unverified", reason: "not_aligned" };
  if (dmarc.length > 0) return { result: "unverified", reason: "no_pass" };

  const organisation = options.organisationalDomain(fromDomain);
  const aligned = organisation !== null && parsed.results.some((entry) => {
    if (entry.method !== "dkim" || entry.result !== "pass") return false;
    const signer = namedDomain(entry, "header.d") ?? namedDomain(entry, "header.i");
    return signer !== null && options.organisationalDomain(signer) === organisation;
  });
  return aligned ? { result: "verified", domain: fromDomain, by: "dkim" } : { result: "unverified", reason: "no_pass" };
}

/**
 * The provider's word on the From domain as a ProviderMessage carries it, for a message whose From address the parser
 * read as `fromEmail`: proved only when the proved domain is that address's own (it always is, both reading the one
 * From field; this keeps it so).
 */
export function fromCheckOf(headers: readonly HeaderField[], fromEmail: string, options: AuthenticationOptions): FromCheck {
  const found = fromAuthentication(headers, options);
  if (found.result !== "verified") return { result: found.result };
  const at = fromEmail.lastIndexOf("@");
  return at > 0 && asciiDomain(fromEmail.slice(at + 1)) === found.domain ? { result: "verified", domain: found.domain } : { result: "unverified" };
}

/** The first mailbox a From field names, lower case, as the parser reads it; "" for none. */
export function firstFromAddress(value: string): string {
  const first = addressParser(value)[0];
  const member = first?.group ? first.group[0] : first;
  return (member?.address ?? "").trim().toLowerCase();
}

/**
 * The checker a header names, compared like `checkerName`: read whole when it can be, else from its start (a comment
 * or two, then the name, quoted or not), so a header that can't be read still counts as the checker's it names.
 */
function checkerIn(value: string): string | null {
  const parsed = parseAuthenticationResults(value);
  if (parsed) return checkerName(parsed.checker);
  const start = /^\s*(?:\([^()]*\)\s*)*"?([^\s;"()]+)/.exec(value);
  return start ? checkerName(start[1]!) : null;
}

/** A checker's name as compared: lower case, without a trailing dot. */
const checkerName = (name: string): string => name.trim().toLowerCase().replace(/\.$/, "");

/** The one domain a result's property names (a domain, or an address whose domain counts), or null for none or several. */
export function namedDomain(entry: AuthenticationResult, property: string): string | null {
  const found = new Set<string | null>();
  for (const [name, value] of entry.properties) {
    if (name !== property) continue;
    const at = value.lastIndexOf("@");
    found.add(asciiDomain(at >= 0 ? value.slice(at + 1) : value));
  }
  if (found.size !== 1) return null;
  return [...found][0] ?? null;
}

/** The domain of the From field's one mailbox, in ASCII; null unless there is exactly one field naming one mailbox. */
function singleFromDomain(headers: readonly HeaderField[]): string | null {
  const from = headers.filter((field) => fieldName(field) === "from");
  if (from.length !== 1) return null;
  const parsed = addressParser(from[0]!.value);
  if (parsed.length !== 1 || parsed[0]!.group) return null;
  const address = parsed[0]!.address ?? "";
  const at = address.lastIndexOf("@");
  return at > 0 ? asciiDomain(address.slice(at + 1)) : null;
}

/**
 * A host name in ASCII, lower case, without a trailing dot: international names in their xn-- form. Null for anything
 * else: address literals, empty labels, characters a host name can't have, a numeric top label (an IPv4 address).
 */
export function asciiDomain(value: string): string | null {
  const name = value.trim().replace(/\.$/, "");
  if (!name || name.length > 253 || !/^[\p{L}\p{N}\p{M}.-]+$/u.test(name)) return null;
  let ascii: string;
  try {
    ascii = new URL(`http://${name}`).hostname;
  } catch {
    return null;
  }
  const labels = ascii.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (/^[0-9]+$/.test(labels.at(-1)!)) return null;
  return ascii;
}

// --- Reading the header (RFC 8601 section 2.2) ---------------------------------------------------------------------

type Token =
  | { kind: "word"; text: string; spaced: boolean }
  | { kind: "quoted"; text: string; spaced: boolean }
  | { kind: ";" | "=" | "/"; spaced: boolean };

/** The header's checker and results, or null when it can't be read whole. */
export function parseAuthenticationResults(value: string): AuthenticationResults | null {
  if (value.length > LIMITS.length) return null;
  const tokens = tokenize(value);
  if (!tokens) return null;
  const segments: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === ";") segments.push([]);
    else segments.at(-1)!.push(token);
  }
  if (segments.length - 1 > LIMITS.results) return null;

  const [head, ...rest] = segments as [Token[], ...Token[][]];
  const id = head[0];
  if (!id || (id.kind !== "word" && id.kind !== "quoted")) return null;
  const version = head[1];
  if (head.length > 2 || (version && !(version.kind === "word" && /^[0-9]+$/.test(version.text)))) return null;

  const results: AuthenticationResult[] = [];
  for (const [index, segment] of rest.entries()) {
    if (segment.length === 0 && index === rest.length - 1) continue; // a trailing ";"
    const only = segment[0];
    if (segment.length === 1 && only?.kind === "word" && only.text.toLowerCase() === "none") continue;
    const result = resultOf(segment);
    if (!result) return null;
    results.push(result);
  }
  return { checker: id.text, results };
}

/** One `method[/version]=result [name=value]...` entry, or null. */
function resultOf(tokens: Token[]): AuthenticationResult | null {
  let at = 0;
  const word = (): string | null => {
    const token = tokens[at];
    if (token?.kind !== "word") return null;
    at++;
    return token.text;
  };
  const is = (kind: "=" | "/"): boolean => {
    if (tokens[at]?.kind !== kind) return false;
    at++;
    return true;
  };
  const method = word();
  if (!method || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(method)) return null;
  if (is("/") && !word()) return null;
  if (!is("=")) return null;
  const result = word();
  if (!result || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result)) return null;

  const properties: Array<[string, string]> = [];
  while (at < tokens.length) {
    if (properties.length >= LIMITS.properties) return null;
    const name = word();
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)?$/.test(name) || !is("=")) return null;
    const value = tokens[at++];
    if (!value || (value.kind !== "word" && value.kind !== "quoted")) return null;
    let text = value.text;
    // A quoted local part followed at once by "@domain": `"first last"@brand.example`.
    const next = tokens[at];
    if (value.kind === "quoted" && next?.kind === "word" && !next.spaced && next.text.startsWith("@")) {
      text = `"${value.text}"${next.text}`;
      at++;
    }
    properties.push([name.toLowerCase(), text]);
  }
  // A DKIM or DMARC result is about headers; an envelope property (smtp.mailfrom, smtp.helo) on one is what a ")" in
  // a part the sender controls leaves behind when it closes the provider's comment early. Refused.
  const kind = method.toLowerCase();
  if ((kind === "dkim" || kind === "dmarc") && properties.some(([name]) => name.startsWith("smtp."))) return null;
  return { method: kind, result: result.toLowerCase(), properties };
}

const SPECIAL = new Set([";", "=", "/"]);
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\r" || c === "\n";

/**
 * The header as tokens: words, quoted strings and the separators `;`, `=` and `/`, with comments (nested, with
 * quoted pairs) and whitespace left out, and whitespace around a dot joined away (`header . from`). Null when a
 * comment or a quoted string doesn't end, a `)` has no `(`, or comments nest too deep.
 */
function tokenize(value: string): Token[] | null {
  const tokens: Token[] = [];
  let spaced = false;
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    if (isSpace(c)) {
      spaced = true;
      i++;
    } else if (c === "(") {
      let depth = 0;
      for (; i < value.length; i++) {
        const d = value[i]!;
        // A quote inside a comment, escaped or not, is refused: in a comment it delimits nothing, so the ")" of a
        // quoted local part Gmail echoes there (the envelope sender) would end the comment and let the sender write
        // results of their own (the security review of 2026-11-19).
        if (d === '"' || (d === "\\" && value[i + 1] === '"')) return null;
        if (d === "\\") i++;
        else if (d === "(" && ++depth > LIMITS.depth) return null;
        else if (d === ")" && --depth === 0) break;
      }
      if (depth !== 0) return null;
      i++;
      spaced = true;
    } else if (c === ")") {
      return null;
    } else if (c === '"') {
      let text = "";
      let closed = false;
      for (i++; i < value.length; i++) {
        const d = value[i]!;
        if (d === "\\") text += value[++i] ?? "";
        else if (d === '"') {
          closed = true;
          break;
        } else text += d;
      }
      if (!closed) return null;
      // No checker needs a ";" or a parenthesis in a quoted value; a sender's quoted local part carrying them is how
      // an injection would be hidden.
      if (/[;()]/.test(text)) return null;
      i++;
      tokens.push({ kind: "quoted", text, spaced });
      spaced = false;
    } else if (SPECIAL.has(c)) {
      tokens.push({ kind: c as ";" | "=" | "/", spaced });
      spaced = false;
      i++;
    } else {
      let text = "";
      while (i < value.length) {
        const d = value[i]!;
        if (isSpace(d)) {
          // `header . from`: a dot with whitespace around it still joins a property's name. Only a name: a domain
          // value ending in a dot ("brand.example. ") doesn't swallow the next property.
          let j = i;
          while (j < value.length && isSpace(value[j]!)) j++;
          if (/^[A-Za-z0-9_-]+\.$/.test(text) || value[j] === ".") {
            i = j;
            continue;
          }
          break;
        }
        if (d === "(" || d === ")" || d === '"' || SPECIAL.has(d)) break;
        text += d;
        i++;
      }
      tokens.push({ kind: "word", text, spaced });
      spaced = false;
    }
  }
  return tokens;
}
