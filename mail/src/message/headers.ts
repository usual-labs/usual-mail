/**
 * Reading the headers rules care about: message ids, list headers and signs of machine-sent mail.
 */

export type HeaderMap = ReadonlyMap<string, readonly string[]>;

export function headerMap(headers: readonly { key: string; value: string }[]): HeaderMap {
  const map = new Map<string, string[]>();
  for (const { key, value } of headers) {
    const name = key.trim().toLowerCase();
    const list = map.get(name);
    if (list) list.push(value);
    else map.set(name, [value]);
  }
  return map;
}

export function firstHeader(headers: HeaderMap, name: string): string | undefined {
  const value = headers.get(name)?.[0];
  return value === undefined ? undefined : collapse(value);
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** "<a@x> <b@y>" to ["a@x", "b@y"]. Falls back to whitespace or commas when there are no angle brackets. */
export function messageIds(value: string | undefined): string[] {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((match) => match[1] ?? "");
  const ids = bracketed.length ? bracketed : value.split(/[\s,]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = stripBrackets(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function stripBrackets(value: string): string {
  return value.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/** The list's id from List-Id (RFC 2919): the part in angle brackets, lower case. */
export function listIdOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bracketed = /<([^<>]+)>/.exec(value)?.[1];
  const id = (bracketed ?? value).trim().toLowerCase();
  return id || undefined;
}

const NO_REPLY_LOCAL =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|dont[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?)(?:$|[-_.+])/i;

/** True when the address's local part says nobody reads replies: noreply, mailer-daemon, bounces. */
export function isNoReplyAddress(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return NO_REPLY_LOCAL.test(local);
}

/**
 * True for bulk or machine-sent mail: an Auto-Submitted value other than "no", Precedence bulk, list or
 * junk, any List-* header, a delivery report, an empty Return-Path (bounces), auto-reply markers, or a
 * no-reply style sender.
 */
export function isAutomated(headers: HeaderMap, fromEmail: string): boolean {
  const autoSubmitted = firstHeader(headers, "auto-submitted")?.toLowerCase();
  if (autoSubmitted && !autoSubmitted.startsWith("no")) return true;
  const precedence = firstHeader(headers, "precedence")?.toLowerCase();
  if (precedence && /^(bulk|list|junk|auto[-_]reply)\b/.test(precedence)) return true;
  for (const name of ["list-id", "list-unsubscribe", "list-post", "list-help", "list-owner"]) {
    if (headers.has(name)) return true;
  }
  if (headers.has("x-autoreply") || headers.has("x-autorespond") || headers.has("feedback-id")) return true;
  const contentType = firstHeader(headers, "content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("multipart/report")) return true;
  const returnPath = headers.get("return-path");
  if (returnPath && returnPath.some((value) => /^\s*<\s*>\s*$/.test(value))) return true;
  return isNoReplyAddress(fromEmail);
}
