// A party's name as a person says it, and one name for one sender (docs/contract-ai.md, "Payment details"). Pure.

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Legal suffixes a company name ends with, longest first. Those of two capitals match only as written ("AS", "SE"),
 * the rest in any case.
 */
const LEGAL_SUFFIXES = [
  "GmbH & Co. KG", "GmbH & Co KG", "gGmbH", "GmbH", "mbH", "Inc.", "Inc", "Incorporated", "Ltd.", "Ltd", "Limited", "LLC",
  "L.L.C.", "LLP", "PLC", "Corp.", "Corp", "Corporation", "Co.", "S.A.S.", "S.A.", "SAS", "SARL", "S.à r.l.", "S.L.",
  "S.p.A.", "SpA", "S.r.l.", "Srl", "B.V.", "N.V.", "Pty Ltd", "Pty", "Oyj", "Oy", "K.K.", "Sp. z o.o.", "s.r.o.", "a.s.",
  "Kft.", "Zrt.", "e.K.", "e.V.", "OHG", "GbR", "ApS", "A/S", "AG", "KG", "UG", "SE", "SA", "BV", "NV", "AB", "AS", "KK",
].sort((a, b) => b.length - a.length);
const SUFFIX_PATTERNS = LEGAL_SUFFIXES.map((suffix) => new RegExp(`(?:^|[\\s,]+)${escape(suffix)}$`, /^[A-Z]{2}$/.test(suffix) ? "" : "i"));
const TEAM = /(?:^|[\s,]+)team$/i;

/**
 * A company's name as a person says it: without a trailing legal suffix ("Hetzner Online GmbH", "Acme, Inc."), and
 * without a trailing "Team" (and then a leading "The"). Null when nothing is left.
 */
export function partyName(name: string): string | null {
  let rest = name.trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const pattern of SUFFIX_PATTERNS) {
      const next = rest.replace(pattern, "").replace(/[\s,]+$/, "");
      if (next !== rest) {
        rest = next;
        changed = true;
      }
    }
    const withoutTeam = rest.replace(TEAM, "");
    if (withoutTeam !== rest) {
      rest = withoutTeam.replace(/^the\s+/i, "").replace(/[\s,]+$/, "");
      changed = true;
    }
  }
  return rest || null;
}

/** Separators that turn a name into display text ("Hetzner Online | Rechnung"). */
const DISPLAY_SEPARATORS = [" — ", " – ", " | ", " · "];

/**
 * A name cut at the first display-text separator, when what is before it still has two letters and isn't a single
 * lowercase word (a district, "nordend – Frischmarkt", rather than a name); null when it is either (the caller falls
 * back to the sender's name). A name without a separator stands as it is.
 */
export function cutDisplayText(name: string): string | null {
  const cuts = DISPLAY_SEPARATORS.map((separator) => name.indexOf(separator)).filter((index) => index >= 0);
  if (cuts.length === 0) return name;
  const head = name.slice(0, Math.min(...cuts)).trim();
  if ((head.match(/\p{L}/gu) ?? []).length < 2) return null;
  return /^[\p{Ll}\p{M}-]+$/u.test(head) ? null : head;
}

/**
 * One word in lower case only (letters, an inner hyphen), of at least two letters: "nordend", a district an earlier cut
 * left, rather than a name. A brand may write itself so; then its sender's name is usually the same word.
 */
export function isOneLowercaseWord(name: string): boolean {
  return /^[\p{Ll}\p{M}]+(?:-[\p{Ll}\p{M}]+)*$/u.test(name) && (name.match(/\p{L}/gu) ?? []).length >= 2;
}

/**
 * A party that is one lowercase word gives way to the sender's display name, already cleaned (`senderParty`); it
 * stays as it is when the sender has no usable name, so it is never blanked. The same word gives the same word.
 */
export function orSenderName(party: string, senderName: string | null): string {
  return senderName && isOneLowercaseWord(party) ? senderName : party;
}

/** A name ending in a web domain's ending: ".de", ".com", ".co.uk". */
const DOMAIN_ENDING = /\.(?:[a-z]{2,6})(?:\.[a-z]{2})?$/i;

/**
 * The one form two names of the same sender share, or null when they aren't the same name: the form without its
 * domain ending when they differ only by one ("Amazon.de" and "Amazon" give "Amazon", and so do "Amazon.de" and
 * "Amazon.com"); the shorter when one is the other's start at a word boundary ("Fernsafe" over "Fernsafe Digital").
 * Letter case aside. The shorter must keep two letters.
 */
export function samePartyForm(a: string, b: string): string | null {
  if (a === b) return a;
  const [baseA, baseB] = [a.replace(DOMAIN_ENDING, ""), b.replace(DOMAIN_ENDING, "")];
  if ((baseA !== a || baseB !== b) && baseA.toLowerCase() === baseB.toLowerCase() && /\p{L}.*\p{L}/u.test(baseA)) {
    return baseA === a ? a : baseB === b ? b : baseA;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (!/\p{L}.*\p{L}/u.test(shorter)) return null;
  return longer.toLowerCase().startsWith(`${shorter.toLowerCase()} `) ? shorter : null;
}

/** The form a name takes among the names the same sender's other threads already have. */
export function canonicalParty(name: string, others: readonly string[]): string {
  let form = name;
  for (const other of others) form = samePartyForm(form, other) ?? form;
  return form;
}
