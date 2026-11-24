/**
 * The fake's reading of Gmail's search operators, for messages.list and threads.list, shaped after Google's page
 * "Search operators you can use with Gmail": words and "phrases" anywhere in the message, a leading minus, from:,
 * to: (To and Cc), subject: (a word or (words)), has:attachment, is:unread and is:read, after: and before: (Unix
 * seconds, or a day as YYYY/MM/DD in UTC), label: (the name in lower case with spaces and slashes as hyphens),
 * in:inbox, in:drafts, in:chats, rfc822msgid:, and {a b} for any of them. Anything else is refused, so a test sees
 * when the provider sends something the fake doesn't know.
 */
import type { FakeLabel, FakeMessage } from "./store.ts";

type Matcher = (message: FakeMessage) => boolean;

/** A matcher for `q`, or the term the fake doesn't understand. */
export function compileQuery(q: string, labels: ReadonlyMap<string, FakeLabel>): Matcher | { unknown: string } {
  const matchers: Matcher[] = [];
  for (const term of split(q.trim())) {
    const matcher = compileTerm(term, labels);
    if ("unknown" in matcher) return matcher;
    matchers.push(matcher.match);
  }
  return (message) => matchers.every((m) => m(message));
}

function compileTerm(term: string, labels: ReadonlyMap<string, FakeLabel>): { match: Matcher } | { unknown: string } {
  const negated = term.startsWith("-") && term.length > 1;
  const body = negated ? term.slice(1) : term;
  const result = positive(body, labels);
  if ("unknown" in result) return result;
  return negated ? { match: (m) => !result.match(m) } : result;
}

function positive(term: string, labels: ReadonlyMap<string, FakeLabel>): { match: Matcher } | { unknown: string } {
  if (term.startsWith("{") && term.endsWith("}")) {
    const any: Matcher[] = [];
    for (const inner of split(term.slice(1, -1))) {
      const m = compileTerm(inner, labels);
      if ("unknown" in m) return m;
      any.push(m.match);
    }
    return { match: (message) => any.some((m) => m(message)) };
  }
  if (term.startsWith('"')) {
    const phrase = norm(term.replace(/^"|"$/g, ""));
    return { match: (m) => everything(m).includes(phrase) };
  }
  const operator = /^([a-z0-9]+):(.+)$/i.exec(term);
  if (!operator) {
    const word = norm(term);
    return { match: (m) => hasWord(everything(m), word) };
  }
  const key = operator[1]!.toLowerCase();
  const value = operator[2]!.replace(/^"|"$/g, "");
  const lower = value.toLowerCase();
  switch (key) {
    case "from":
      return { match: (m) => m.parsed.from.includes(lower) };
    case "to":
      return { match: (m) => m.parsed.to.includes(lower) };
    case "subject": {
      const words = lower.replace(/^\(|\)$/g, "").split(/\s+/).filter(Boolean);
      return { match: (m) => words.every((w) => hasWord(m.parsed.subject, w)) };
    }
    case "has":
      return lower === "attachment" ? { match: (m) => m.parsed.hasAttachment } : { unknown: term };
    case "is":
      if (lower === "unread") return { match: (m) => m.labelIds.has("UNREAD") };
      if (lower === "read") return { match: (m) => !m.labelIds.has("UNREAD") };
      return { unknown: term };
    case "after":
    case "before": {
      const at = /^\d+$/.test(value) ? Number(value) * 1000 : dayOf(value);
      if (at === null) return { unknown: term };
      return { match: (m) => (key === "after" ? m.internalDate > at : m.internalDate < at) };
    }
    case "label": {
      const ids = [...labels.values()].filter((l) => l.name.toLowerCase().replace(/[\s/]+/g, "-") === lower).map((l) => l.id);
      return { match: (m) => ids.some((id) => m.labelIds.has(id)) };
    }
    case "in": {
      const label = { inbox: "INBOX", drafts: "DRAFT", chats: "CHAT" }[lower];
      return label ? { match: (m) => m.labelIds.has(label) } : { unknown: term };
    }
    case "rfc822msgid":
      return { match: (m) => m.messageId === value.replace(/^<|>$/g, "") };
    default:
      return { unknown: term };
  }
}

/** Terms: words, "quoted phrases", {groups} and operators whose value is quoted or in (parentheses). */
function split(q: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i]!)) i++;
    if (i >= q.length) break;
    let j = i;
    while (j < q.length && !/\s/.test(q[j]!)) {
      const close = { '"': '"', "(": ")", "{": "}" }[q[j]!];
      if (close) {
        const end = q.indexOf(close, j + 1);
        j = end < 0 ? q.length : end + 1;
      } else {
        j++;
      }
    }
    out.push(q.slice(i, j));
    i = j;
  }
  return out;
}

function everything(m: FakeMessage): string {
  return `${m.parsed.subject} ${m.parsed.from} ${m.parsed.to} ${m.parsed.text}`;
}

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(text);
}

function dayOf(value: string): number | null {
  const parts = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(value);
  return parts ? Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : null;
}
