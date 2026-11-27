// The ways a sender's mail offers to unsubscribe (docs/contract.md, "Unsubscribing"), read only from its List-Unsubscribe
// header, and only when the sender's own signature vouches for it (`ProviderMessage.signedUnsubscribe`; the caller also
// checks that the provider proved the From domain and that the mail was sent to this inbox, `queue.ts`): its https
// address takes a one-click POST when a signed List-Unsubscribe-Post says "List-Unsubscribe=One-Click" (RFC 8058) and is
// the page to open; its mailto address is written to. RFC 2369: addresses in angle brackets, separated by commas. No link
// in the body is ever used (the second security review of 2026-11-27): a signed mail can repeat someone else's words, a
// name given at sign-up or a comment, and a Content-Type added above a signed plain-text mail turns its words into
// HTML links.
//
// Everything here comes from the sender's mail and is only ever used as an address, never followed by this code, and
// bounded so a sender can't make the person's inbox say anything (the security review of 2026-11-27): an email goes to
// one plain address, with the address's subject only when it is short plain text, and always the server's own words as
// its body. Pages are https only, at a host name with a registrable domain: never an IP address, a user name or an
// address over 2,000 characters.

/** Which unsubscribe headers the sender's signature vouches for, as stored. */
export type SignedPart = "list-unsubscribe" | "list-unsubscribe-post";

/** An email that asks to unsubscribe: to the one address the header names. */
export interface EmailWay {
  to: string;
  subject: string;
  body: string;
}

export interface Ways {
  /** An https address that takes a one-click POST. */
  oneClick?: string;
  email?: EmailWay;
  /** An https page to open: the header's (which a failed one-click leaves too). */
  page?: string;
}

export interface WayOptions {
  /**
   * The registrable domain of a host name by the Public Suffix List, or null when it has none: a page's host must have
   * one. Absent (a server without the list): a host name with a dot and letters at its end.
   */
  registrable?: (host: string) => string | null;
}

/** The longest address kept from mail: anything longer is left out, as no real unsubscribe address is. */
const MOST_CHARS = 2000;
/** The longest subject kept from a mailto address, in plain ASCII; longer, or anything else, is "unsubscribe". */
const MOST_SUBJECT_CHARS = 100;

/** The body of every unsubscribe email: the server's own words, never the sender's. */
export const EMAIL_BODY = "Please unsubscribe this address from all your mailings.\n\nSent at the request of the person this mailbox belongs to.";

/**
 * The ways in one message's List-Unsubscribe header: none unless the sender's signature vouches for the header
 * (`signed`), and no one-click unless it vouches for List-Unsubscribe-Post too. Anything malformed is left out.
 */
export function headerWays(header: string | null, post: string | null, signed: readonly SignedPart[], options: WayOptions = {}): Ways {
  if (!header || !signed.includes("list-unsubscribe")) return {};
  const ways: Ways = {};
  const addresses = [...header.matchAll(/<([^<>]*)>/g)].map((found) => found[1]!.replace(/\s+/g, ""));
  const https = addresses.map((address) => httpsAddress(address, options)).find((address) => address !== null) ?? null;
  const oneClick = signed.includes("list-unsubscribe-post") && post !== null && /^\s*List-Unsubscribe\s*=\s*One-Click\s*$/i.test(post);
  if (https && oneClick) ways.oneClick = https;
  const email = addresses.map(emailWay).find((way) => way !== null) ?? null;
  if (email) ways.email = email;
  if (https) ways.page = https;
  return ways;
}

/**
 * `value` when it is an https address no longer than `MOST_CHARS`, with no user name, at a host name (never an IP
 * address) that has a registrable domain; else null.
 */
export function httpsAddress(value: string, options: WayOptions = {}): string | null {
  if (value.length > MOST_CHARS) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  // The URL parser writes every form of an IP address (0x7f.1, 2130706433, [::1]) canonically: dotted, or bracketed.
  const host = url.hostname;
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
  const named = options.registrable ? options.registrable(host) !== null : /\.[a-z][a-z0-9-]*[a-z0-9]$/i.test(host) || /\.xn--[a-z0-9-]+$/i.test(host);
  return named ? url.href : null;
}

/**
 * A mailto address as an email to send: its first address when that is one plain ASCII address, the subject it gives
 * when that is 1 to 100 characters of plain ASCII (else "unsubscribe"), and the server's own body, never the address's.
 */
function emailWay(value: string): EmailWay | null {
  if (!/^mailto:/i.test(value) || value.length > MOST_CHARS) return null;
  const [path, query = ""] = value.slice("mailto:".length).split("?", 2) as [string, string?];
  let to: string;
  try {
    to = decodeURIComponent(path).trim();
  } catch {
    return null;
  }
  // One address of visible ASCII: no list, no name, no brackets, quotes or spaces.
  if (to.length > 254 || !/^[\x21-\x7e]+$/.test(to) || !/^[^@,;:<>()"[\]\\]+@[^@,;:<>()"[\]\\]+\.[A-Za-z0-9-]+$/.test(to)) return null;
  let subject = "";
  try {
    subject = new URLSearchParams(query).get("subject")?.trim() ?? "";
  } catch {
    subject = "";
  }
  const plain = subject.length >= 1 && subject.length <= MOST_SUBJECT_CHARS && /^[\x20-\x7e]+$/.test(subject);
  return { to: to.toLowerCase(), subject: plain ? subject : "unsubscribe", body: EMAIL_BODY };
}
