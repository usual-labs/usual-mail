// What a model reads of a message's text, in both jobs (docs/contract-ai.md, "What leaves the server"): the text part,
// or text made from the HTML when there is no text part or only a stub of one, cleaned of what carries nothing to read
// (the audit of 2026-11-19: a third of the messages filled the 4,000 characters, most of them mostly links, invisible
// padding and divider lines). Each link keeps its scheme and site and loses its path and query; invisible characters
// go; runs of one divider character become three; spaces and blank lines collapse. The same field as before, with less
// noise: never the HTML itself. The screening gate's own check (gate.ts) reads the same, as far as the model read it.
// A thread's snippet is made from the same reading (`snippetText`), with links, tags and entities gone. Every pattern
// here runs in time linear in the text (0.1.3, after a security review): a pattern that can scan to the end of the text
// from many places ("<" a million times) would hold the server's lock for minutes, since the text is read under it.

/** A text part shorter than this, once cleaned, may be a stub ("view this email online"). */
export const STUB_TEXT = 300;
/** ... and is one when the HTML gives at least this many times as much text. */
export const STUB_RATIO = 3;

/** A text part that is HTML source (some senders put the HTML there too): read as HTML. */
const HTML_SOURCE = /^\s*<(?:!doctype\s+html|html|head|body|meta|table|div|p|span|center|style)[\s>/]/i;

/**
 * What a model reads of a message: its cleaned text part, or the HTML's text when there is none or only a stub, or
 * when the text part is HTML source itself.
 */
export function modelText(text: string | null, html: string | null): string {
  if (text && HTML_SOURCE.test(text)) return readableHtml(html ?? text);
  const own = cleanText(text ?? "");
  if (!html) return own;
  if (!own) return readableHtml(html);
  const fromHtml = readableHtml(html);
  return stub(own, fromHtml) ? fromHtml : own;
}

/** Whether a message's text part is a stub of its HTML (under 300 characters cleaned, the HTML three times as long). */
export function isStubText(text: string | null, html: string | null): boolean {
  const own = cleanText(text ?? "");
  return Boolean(own && html) && stub(own, readableHtml(html!));
}

function stub(own: string, fromHtml: string): boolean {
  return own.length < STUB_TEXT && fromHtml.length >= STUB_RATIO * own.length;
}

/** Text made from HTML, its entities read once, then cleaned. */
export function readableHtml(html: string): string {
  const shown = withoutComments(withoutBlocks(html));
  const lines = shown.replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|table|blockquote|pre)\s*>/gi, "\n");
  // A tag starts where HTML starts one, so a lone "<" in the text ("a < b") stays, and runs to its nearest ">", so a
  // "<" inside an attribute leaves no piece of the tag in the text.
  const text = withoutTags(lines, opensTag)
    .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (entity, name: string) => readEntity(name) ?? entity);
  return cleanText(text);
}

const NAMED: Record<string, string> = {
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "", shy: "", lrm: "", rlm: "",
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
  euro: "€", pound: "£", yen: "¥", cent: "¢",
};

function readEntity(name: string): string | null {
  if (name[0] !== "#") return NAMED[name.toLowerCase()] ?? null;
  const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : null;
}

/** Characters that show nothing: soft hyphens, joiners, fillers, direction marks, byte-order marks. */
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁤⁦-⁯ㅤ﻿ﾠ]/g;
/** Every other kind of space, read as one. */
const SPACES = /[\t\v\f   -   　]/g;
/** A web link, up to a space, a quote or an angle bracket. */
const LINK = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Punctuation a sentence puts right after a link. */
const AFTER_LINK = new Set(").,;:!?]}'\"");
/** Four or more of one divider character (punctuation, maths signs, box drawing), with or without single spaces between. */
const DIVIDER = /([\p{P}\p{Sm}\p{Sk}─-◿])(?: ?\1){3,}/gu;

/** Where a block whose content is never read opens: a style sheet, a script, the head, the title. */
const BLOCK_OPEN = /<(style|script|head|title)/gi;

/**
 * The HTML with each style, script, head and title block taken out, up to its nearest closing tag; one never closed
 * stays. In linear time: once no closing tag of a name follows, none follows a later opening either.
 */
function withoutBlocks(html: string): string {
  const unclosed = new Set<string>();
  const open = new RegExp(BLOCK_OPEN.source, "gi");
  let out = "";
  let kept = 0;
  for (let match = open.exec(html); match; match = open.exec(html)) {
    const name = match[1]!.toLowerCase();
    if (unclosed.has(name)) continue;
    const close = new RegExp(`</${name}\\s*>`, "gi");
    close.lastIndex = open.lastIndex;
    const found = close.exec(html);
    if (!found) {
      unclosed.add(name);
      continue;
    }
    out += `${html.slice(kept, match.index)} `;
    kept = found.index + found[0].length;
    open.lastIndex = kept;
  }
  return out + html.slice(kept);
}

/**
 * The text with each tag read as a space, as `/<[^>]*>/g` reads them (a tag runs from its "<" to the nearest ">", so a
 * "<" inside an attribute or a comment is part of it), in linear time: that pattern reads from every "<" to the end of
 * a text with no ">" after it, and once no ">" follows a "<", none follows a later one either. With `opens`, only a "<"
 * it accepts starts a tag (`opensTag`: as `/<\/?[a-z!?][^>]*>/gi` reads them).
 */
function withoutTags(text: string, opens: (text: string, at: number) => boolean = () => true): string {
  let out = "";
  let kept = 0;
  for (let at = text.indexOf("<"); at >= 0; at = text.indexOf("<", at + 1)) {
    if (!opens(text, at)) continue;
    const end = text.indexOf(">", at + 1);
    if (end < 0) break;
    out += `${text.slice(kept, at)} `;
    kept = end + 1;
    at = end;
  }
  return out + text.slice(kept);
}

/**
 * The HTML with each comment read as a space, ended where htmlparser2 and browsers end it: "<!-->" and "<!--->" are
 * whole comments, and any other runs to its nearest "-->" or "--!>"; one never closed stays. In linear time: each
 * close is looked for again only once the last one found is behind, from there on, and once one isn't found, never.
 */
function withoutComments(html: string): string {
  let out = "";
  let kept = 0;
  // The nearest "-->" and "--!>" at or after where the last look began; -1 once there is none.
  let plain = -2;
  let bang = -2;
  for (let open = html.indexOf("<!--"); open >= 0; open = html.indexOf("<!--", kept)) {
    const body = open + 4;
    let end: number;
    if (html[body] === ">") end = body + 1;
    else if (html.startsWith("->", body)) end = body + 2;
    else {
      if (plain !== -1 && plain < body) plain = html.indexOf("-->", body);
      if (bang !== -1 && bang < body) bang = html.indexOf("--!>", body);
      if (plain < 0 && bang < 0) break;
      end = plain >= 0 && (bang < 0 || plain < bang) ? plain + 3 : bang + 4;
    }
    out += `${html.slice(kept, open)} `;
    kept = end;
  }
  return out + html.slice(kept);
}

/** Whether a tag left in text starts here, as `<\/?[a-z!?]` reads it: "<", maybe "/", then a letter, "!" or "?". */
function opensTag(text: string, at: number): boolean {
  const next = text[at + 1] === "/" ? text[at + 2] : text[at + 1];
  return next !== undefined && /^[a-z!?]$/i.test(next);
}

/** A message's text with what carries nothing to read taken out. */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .replace(SPACES, " ")
    .replace(LINK, shortLink)
    .replace(DIVIDER, "$1$1$1")
    .replace(/ {2,}/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "https://host/…" for a link with a path or query, "https://host" for one without; never who signed in. */
function shortLink(match: string): string {
  // Read from the end, not by a pattern: a link ending in a long run of ")" stays linear.
  let end = match.length;
  while (end > 0 && AFTER_LINK.has(match[end - 1]!)) end--;
  const tail = match.slice(end);
  const link = match.slice(0, match.length - tail.length);
  const parsed = /^(https?):\/\/(?:[^@/?#]*@)?([^/?#]+)(.*)$/i.exec(link);
  if (!parsed) return match;
  const [, scheme, host, rest] = parsed;
  const more = rest !== "" && rest !== "/";
  return `${scheme!.toLowerCase()}://${host!.toLowerCase()}${more ? "/…" : ""}${tail}`;
}

/** How long a thread's snippet is at most. */
export const SNIPPET_LIMIT = 200;

/** A markdown-style link, "[text](https://…)", reduced to its text. */
const MARKDOWN_LINK = /\[([^[\]\n]*)\]\(\s*(?:https?:\/\/|mailto:)[^()[\]\s]*\s*\)/gi;
/** A link in angle brackets, "<https://…>". */
const ANGLE_LINK = /<\s*(?:https?:\/\/|mailto:)[^<>\s]*\s*>/gi;
/** A link standing in the text, as `cleanText` left it ("https://host/…") or starting with "www.". */
const NAKED_LINK = /(?<![\p{L}\p{N}])(?:https?:\/\/|www\.)[^\s<>"'`]*/giu;
/** An entity left in text (a text part that writes "&zwnj;"): read, or dropped when unknown. */
const ENTITY = /&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi;
/** Control and direction characters (the summary's check), read as a space. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * A thread's snippet (docs/contract.md, "Words"): plain reading text from a message, read as a model reads it
 * (`modelText`), its entities read, a markdown-style link reduced to its text, a link in angle brackets or standing
 * alone taken out (a message that is nothing but a link keeps that link's host), tags and control characters gone,
 * spaces and line breaks one space, then cut at a word boundary within `limit`. Never markup.
 */
export function snippetText(text: string | null, html: string | null, limit = SNIPPET_LIMIT): string {
  return cutAtWord(readingText(text, html), limit);
}

/**
 * A message's whole plain reading text, one line, as a snippet reads it before it is cut: what search indexes and
 * cuts its excerpts from (src/search/), so a snippet and an excerpt never read a message two ways.
 */
export function readingText(text: string | null, html: string | null): string {
  const read = modelText(text, html);
  const host = /\bhttps?:\/\/(?:[^@/?#\s]*@)?([^/?#\s<>)\]…]+)/i.exec(read)?.[1]?.toLowerCase().replace(/^www\./, "") ?? "";
  const line = plainLine(read
    .replace(ENTITY, (_entity, name: string) => readEntity(name) ?? "")
    .replace(MARKDOWN_LINK, "$1")
    .replace(ANGLE_LINK, " ")
    .replace(NAKED_LINK, " "));
  return line || host;
}

/** Text as one plain line: tags, invisible and control characters gone, every run of spaces one space. */
export function plainLine(text: string): string {
  return withoutTags(text, opensTag)
    .replace(INVISIBLE, "")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** At most `limit` characters, cut where the last word that fits ends (a single longer word at the limit). */
function cutAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const space = text.slice(0, limit + 1).lastIndexOf(" ");
  const cut = space > 0 ? text.slice(0, space).trimEnd() : text.slice(0, limit);
  return cut.replace(/[\ud800-\udbff]$/, "");
}
