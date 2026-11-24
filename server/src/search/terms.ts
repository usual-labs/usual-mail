// Reading what a person typed into search (docs/contract-search.md, "What a search takes"): the free text, quoted
// phrases, words to leave out, and the Gmail operators the server accepts, turned into the same filters a client can
// give. Anything it doesn't know is plain text, never an error.

import type { SearchFilters, SearchUnderstood } from "@usualmail/core";

/** A search as the server works with it: what it understood, and the parts the index matches. */
export interface Parsed {
  understood: SearchUnderstood;
  /** Free words, matched as word starts (search as you type). */
  words: string[];
  /** Quoted phrases, matched word for word. */
  phrases: string[];
  /** Words a thread must not hold. */
  exclude: string[];
  /** Words the subject must hold (the `subject` filter, given or typed). */
  subjectWords: string[];
}

/** The operators accepted, by name (any case). Gmail's `older:` and `newer:` are its names for `before:` and `after:`. */
const DATE_OPERATORS = { before: "before", older: "before", after: "after", newer: "after" } as const;

/** At most this many words, phrases and excluded words count; the rest of a long text is left out. */
const MAX_TERMS = 16;

/**
 * Reads `q` and the filters given into one search. A typed operator wins over the same filter given. `zone` is the IANA
 * time zone typed dates are days in.
 */
export function parseSearch(q: string, given: SearchFilters, zone: string): Parsed {
  const filters: SearchFilters = { ...given };
  const words: string[] = [];
  const phrases: string[] = [];
  const exclude: string[] = [];
  const text: string[] = [];
  for (const token of tokens(q)) {
    if (token.quoted) {
      if (token.negated) exclude.push(token.value);
      else if (token.value) {
        phrases.push(token.value);
        text.push(`"${token.value}"`);
      }
      continue;
    }
    const operator = /^([a-z]+):(.+)$/i.exec(token.value);
    const key = operator?.[1]!.toLowerCase();
    const value = operator?.[2] ?? "";
    if (operator && takeOperator(filters, key!, value, token.negated, zone)) continue;
    if (token.negated) exclude.push(token.value);
    else {
      words.push(token.value);
      text.push(token.value);
    }
  }
  const subject = filters.subject?.trim();
  const understood: SearchUnderstood = { ...dropEmpty(filters), text: text.join(" ") };
  if (subject) understood.subject = subject;
  else delete understood.subject;
  if (exclude.length) understood.exclude = exclude.slice(0, MAX_TERMS);
  return {
    understood,
    words: words.slice(0, MAX_TERMS),
    phrases: phrases.slice(0, MAX_TERMS),
    exclude: exclude.slice(0, MAX_TERMS),
    subjectWords: subject ? subject.split(/\s+/).slice(0, MAX_TERMS) : [],
  };
}

/** Applies one operator; false when it isn't one the server accepts or its value can't be read (plain text then). */
function takeOperator(filters: SearchFilters, key: string, value: string, negated: boolean, zone: string): boolean {
  const bare = value.replace(/^"|"$/g, "").trim();
  if (!bare) return false;
  if (key === "has" && bare.toLowerCase() === "attachment") {
    filters.hasAttachment = !negated;
    return true;
  }
  if (key === "is" && (bare.toLowerCase() === "unread" || bare.toLowerCase() === "read")) {
    filters.unread = (bare.toLowerCase() === "unread") !== negated;
    return true;
  }
  if (negated) return false;
  if (key === "from" || key === "to") {
    filters[key] = bare;
    return true;
  }
  if (key === "subject") {
    filters.subject = bare;
    return true;
  }
  if (key in DATE_OPERATORS) {
    const at = dayStart(bare, zone);
    if (at === null) return false;
    filters[DATE_OPERATORS[key as keyof typeof DATE_OPERATORS]] = at;
    return true;
  }
  return false;
}

interface Token {
  value: string;
  quoted: boolean;
  negated: boolean;
}

/**
 * Splits typed text into words, "quoted phrases" and operators whose value is quoted (`subject:"weekly report"`),
 * each possibly with a leading minus. An unclosed quote runs to the end.
 */
export function tokens(q: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i]!)) i++;
    if (i >= q.length) break;
    let negated = false;
    if (q[i] === "-" && i + 1 < q.length && !/\s/.test(q[i + 1]!)) {
      negated = true;
      i++;
    }
    if (q[i] === '"') {
      const end = q.indexOf('"', i + 1);
      const value = q.slice(i + 1, end < 0 ? q.length : end).replace(/\s+/g, " ").trim();
      out.push({ value, quoted: true, negated });
      i = end < 0 ? q.length : end + 1;
      continue;
    }
    let j = i;
    while (j < q.length && !/\s/.test(q[j]!)) {
      // An operator's quoted value runs to its closing quote: subject:"weekly report".
      if (q[j] === '"' && j > i && q[j - 1] === ":") {
        const end = q.indexOf('"', j + 1);
        j = end < 0 ? q.length : end + 1;
        continue;
      }
      j++;
    }
    out.push({ value: q.slice(i, j), quoted: false, negated });
    i = j;
  }
  return out;
}

/**
 * The start of a typed day in `zone`, as an ISO time: `2026/11/01`, `2026-11-01` or `2026/1/5` (Gmail's form). Null
 * for anything else or a day that doesn't exist.
 */
export function dayStart(value: string, zone: string): string | null {
  const parts = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (!parts) return null;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  // The zone's offset at that moment, read twice so a day that starts at a change of summer time lands right.
  const offset = (at: number) => {
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(local.find((part) => part.type === type)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - at;
  };
  let at = utc - offset(utc);
  at = utc - offset(at);
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function dropEmpty(filters: SearchFilters): SearchFilters {
  const out: SearchFilters = {};
  for (const [key, value] of Object.entries(filters) as Array<[keyof SearchFilters, unknown]>) {
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Text folded for matching names and addresses: lower case, accents taken off, ß and ẞ read as ss, every run of
 * anything but letters and digits one space, with a space at each end so a word's start is " word".
 */
export function fold(text: string): string {
  const plain = text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/ß/g, "ss");
  return ` ${plain.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}
