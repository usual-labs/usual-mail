// The Public Suffix List, read: which part of a host name anyone can register under (com, co.uk, and a platform's own
// suffix such as github.io), and so a host's registrable domain, the key a sender's logo is kept under: one fetch for
// every sender and inbox at a brand, and a platform's customers kept apart. The algorithm is the list's own
// (publicsuffix.org/list, "Formal algorithm"): an exception rule wins, else the rule with the most labels, else "*".
//
// The list is Mozilla's, under the Mozilla Public License 2.0. `scripts/update-suffixes.mjs` writes it from a pinned
// commit with `rulesFromList`, in ASCII, beside its licence; the server never downloads it.

import { asciiHost } from "./host.ts";

/** The list's rules in ASCII, as the file writes them: "com", "*.ck" (a wildcard), "!www.ck" (an exception). */
export interface SuffixRules {
  icann: string[];
  private: string[];
}

const BEGIN = { icann: "// ===BEGIN ICANN DOMAINS===", private: "// ===BEGIN PRIVATE DOMAINS===" };
const END = { icann: "// ===END ICANN DOMAINS===", private: "// ===END PRIVATE DOMAINS===" };

/** The rules of the list's file, each section apart, converted to ASCII. Throws on a rule it can't read. */
export function rulesFromList(text: string): SuffixRules {
  const out: SuffixRules = { icann: [], private: [] };
  let section: keyof SuffixRules | null = null;
  let sawIcann = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === BEGIN.icann) (section = "icann"), (sawIcann = true);
    else if (line === BEGIN.private) section = "private";
    else if (line === END.icann || line === END.private) section = null;
    else if (section && line && !line.startsWith("//")) out[section].push(asciiRule(line.split(/\s/)[0]!));
  }
  if (!sawIcann) throw new Error("The list has no ICANN section");
  return out;
}

/** One rule in ASCII, its wildcard or exception mark kept. */
function asciiRule(rule: string): string {
  const mark = rule.startsWith("!") ? "!" : rule.startsWith("*.") ? "*." : "";
  const name = asciiHost(rule.slice(mark.length));
  if (!name || name.includes("*")) throw new Error(`The rule ${JSON.stringify(rule)} can't be read`);
  return `${mark}${name}`;
}

export class SuffixList {
  readonly #rules = new Set<string>();
  /** For "*.ck": "ck". */
  readonly #wildcards = new Set<string>();
  /** For "!www.ck": "www.ck". */
  readonly #exceptions = new Set<string>();

  /** `private: false` reads the ICANN section alone. */
  constructor(rules: SuffixRules, options: { private?: boolean } = {}) {
    for (const rule of [...rules.icann, ...(options.private === false ? [] : rules.private)]) {
      if (rule.startsWith("!")) this.#exceptions.add(rule.slice(1));
      else if (rule.startsWith("*.")) this.#wildcards.add(rule.slice(2));
      else this.#rules.add(rule);
    }
  }

  /** The host's public suffix in ASCII, or null when it isn't a host name. */
  publicSuffix(host: string): string | null {
    const name = asciiHost(host);
    if (!name) return null;
    const labels = name.split(".");
    return labels.slice(labels.length - this.#suffixLength(labels)).join(".");
  }

  /** The host's registrable domain in ASCII: its public suffix and one label more. Null for a suffix itself. */
  registrableDomain(host: string): string | null {
    const name = asciiHost(host);
    if (!name) return null;
    const labels = name.split(".");
    const length = this.#suffixLength(labels);
    return labels.length > length ? labels.slice(labels.length - length - 1).join(".") : null;
  }

  /** How many labels at the end of `labels` are the public suffix. */
  #suffixLength(labels: string[]): number {
    const n = labels.length;
    // An exception rule wins; its suffix is the rule without its leftmost label. The longest is found first.
    for (let i = 0; i < n; i++) {
      if (this.#exceptions.has(labels.slice(i).join("."))) return n - i - 1;
    }
    // Else the rule with the most labels; a wildcard stands for exactly one label.
    for (let i = 0; i < n; i++) {
      if (this.#rules.has(labels.slice(i).join("."))) return n - i;
      if (i + 1 < n && this.#wildcards.has(labels.slice(i + 1).join("."))) return n - i;
    }
    return 1; // the default rule, "*"
  }
}
