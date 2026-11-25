// Taking email addresses out of what a summary request carries (docs/contract-ai.md, "What leaves the server": "no
// address is sent"), in time linear in the text's length, under the server's lock (the security reviews of 2026-11-25:
// the pattern this replaces took 55 seconds for 128 KB without an "@"). Pure.
//
// An address is found from its at sign ("@", or the full-width "＠"): the domain after it, one or more dots between
// labels (".", or the ideographic and full-width dots IDNA reads as one: "。", "．", "｡"), any number of labels of any
// length; then the local part back from it, the whole run of address characters when at most 256 long, else its last
// 64 (a run of letters with no space before an address, in Thai or Japanese, keeps its words and loses the address).
// Letters, digits and combining marks count, so a Thai, Hindi or decomposed name is taken out whole.

import { ADDRESS_STAND_IN } from "@usualmail/core";

/** The at signs. */
const AT = /[@＠]/g;
const isAt = (char: string | undefined) => char === "@" || char === "＠";
/** A character a local part may hold. */
const LOCAL_CHAR = /^[\p{L}\p{N}\p{M}._%+'=-]$/u;
/**
 * A domain from where it starts: labels of letters, digits, marks and hyphens, joined by dots. One position each, and
 * labels and dots never overlap, so it reads at most the run of domain characters after its at sign.
 */
const DOMAIN = /[\p{L}\p{N}\p{M}-]+(?:[.。．｡][\p{L}\p{N}\p{M}-]+)+/uy;
/** A character of a domain, dots included. */
const DOMAIN_UNIT = /[\p{L}\p{N}\p{M}.。．｡\-\ud800-\udfff]/u;
/** A local part this long or shorter is taken whole; past it, only its last 64 characters are (what mail allows). */
const LOCAL_RUN = 256;
const LOCAL_TAIL = 64;
/**
 * How far past the limit a cut looks for the end of a run, in UTF-16 code units: a local part and a domain of eleven
 * labels, twice over, since a character may take two units.
 */
const ROOM = 2 * (LOCAL_RUN + 1 + 11 * 64);
/** A character an address may hold, for where a cut may fall; any surrogate counts, to stay on the safe side. */
const ADDRESS_UNIT = /[\p{L}\p{N}\p{M}._%+'=@＠。．｡\-\ud800-\udfff]/u;

/** How many code units the local-part character ending at `end` takes (1 or 2), or 0 when it isn't one. */
function localCharBefore(text: string, end: number): number {
  if (end <= 0) return 0;
  const low = text.charCodeAt(end - 1);
  const size = low >= 0xdc00 && low <= 0xdfff && end >= 2 && (text.charCodeAt(end - 2) & 0xfc00) === 0xd800 ? 2 : 1;
  return LOCAL_CHAR.test(text.slice(end - size, end)) ? size : 0;
}

/** Where the local part of the at sign at `at` starts, not before `floor`: its whole run up to 256 long, else its last 64. */
function localStart(text: string, at: number, floor = 0): number {
  let start = at;
  let count = 0;
  for (let size = localCharBefore(text, start); size && start > floor && count <= LOCAL_RUN; size = localCharBefore(text, start)) {
    start -= size;
    count++;
  }
  if (count <= LOCAL_RUN) return start;
  start = at;
  for (let i = 0; i < LOCAL_TAIL; i++) start -= localCharBefore(text, start);
  return start;
}

/** The text with every email address in it replaced, so a summary request carries none. */
export function withoutAddresses(text: string): string {
  let out = "";
  let kept = 0;
  for (const match of text.matchAll(AT)) {
    const at = match.index;
    if (at < kept) continue;
    DOMAIN.lastIndex = at + 1;
    if (!DOMAIN.exec(text)) continue;
    const start = localStart(text, at, kept);
    if (start === at) continue;
    out += `${text.slice(kept, start)}${ADDRESS_STAND_IN}`;
    kept = DOMAIN.lastIndex;
  }
  return out + text.slice(kept);
}

/**
 * The text's first `limit` code units with every address replaced: cut first, to the limit and room for one address,
 * then back to where no address is split, so no part of one can come within the limit once the others are replaced.
 * When a run of address characters goes on past the limit and that room, the cut stays at the limit unless an address
 * could cross it there (`safeCut`).
 */
export function cutWithoutAddresses(text: string, limit: number): string {
  if (text.length <= limit) return withoutAddresses(text);
  const inRun = (at: number) => ADDRESS_UNIT.test(text[at - 1] ?? "") && ADDRESS_UNIT.test(text[at] ?? "");
  let end = Math.min(text.length, limit + ROOM);
  while (end > limit && inRun(end)) end--;
  if (end === limit && inRun(end)) end = safeCut(text, limit);
  return withoutAddresses(text.slice(0, end)).slice(0, limit);
}

/**
 * Where to cut inside a run of address characters at `limit` so that no address is cut in two, never further back than
 * needed (a long run of letters keeps its words): before the address of the last at sign behind the limit in the run
 * when its domain reaches the limit, and before that of the first at sign ahead of it in the run within a local part's
 * length (counted in code units). Before an address means before its local part, and when that starts right after
 * another at sign (addresses joined by "_", "+", "=", "'" or "%"), before that address too.
 */
function safeCut(text: string, limit: number): number {
  let cut = limit;
  let runStart = limit;
  while (runStart > 0 && ADDRESS_UNIT.test(text[runStart - 1]!)) runStart--;
  let behind = -1;
  for (let at = limit - 1; at >= runStart; at--) {
    if (isAt(text[at])) {
      behind = at;
      break;
    }
  }
  if (behind >= 0) {
    let reach = behind + 1;
    while (reach < limit && DOMAIN_UNIT.test(text[reach]!)) reach++;
    if (reach === limit) cut = Math.min(cut, chainStart(text, behind));
  }
  const ahead = limit + 2 * LOCAL_RUN + 2;
  for (let at = limit; at < Math.min(text.length, ahead) && ADDRESS_UNIT.test(text[at]!); at++) {
    if (isAt(text[at])) {
      cut = Math.min(cut, chainStart(text, at));
      break;
    }
  }
  // Never between the two halves of a character.
  if (cut > 0 && (text.charCodeAt(cut) & 0xfc00) === 0xdc00 && (text.charCodeAt(cut - 1) & 0xfc00) === 0xd800) cut--;
  return cut;
}

/** Where the address of the at sign at `at` starts, and that of any at sign its local part starts right after. */
function chainStart(text: string, at: number): number {
  let start = localStart(text, at);
  while (start > 0 && isAt(text[start - 1])) start = localStart(text, start - 1);
  return start;
}
