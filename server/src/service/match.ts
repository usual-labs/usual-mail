// Whether a rule matches a message. Pure, so the sync engine and tests share it.

import type { Address, RuleMatch } from "@usualmail/core";

export interface MatchSubject {
  from: string;
  /** To and Cc addresses. */
  to: string[];
  subject: string;
  listId: string | null;
  automated: boolean;
}

export function subjectFor(message: {
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  listId: string | null;
  automated: boolean;
}): MatchSubject {
  return {
    from: message.from.email.toLowerCase(),
    to: [...message.to, ...message.cc].map((a) => a.email.toLowerCase()),
    subject: message.subject,
    listId: normalizeListId(message.listId),
    automated: message.automated,
  };
}

/** "Weekly Build <weekly-build.example.com>" and "weekly-build.example.com" are the same list. */
export function normalizeListId(value: string | null | undefined): string | null {
  if (!value) return null;
  const inner = /<([^>]+)>/.exec(value)?.[1] ?? value;
  return inner.trim().toLowerCase() || null;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/** Every field that is set must match. A domain also matches its subdomains. */
export function ruleMatches(match: RuleMatch, message: MatchSubject): boolean {
  if (match.from !== undefined && match.from.toLowerCase() !== message.from) return false;
  if (match.domain !== undefined) {
    const want = match.domain.toLowerCase();
    const have = domainOf(message.from);
    if (have !== want && !have.endsWith(`.${want}`)) return false;
  }
  if (match.listId !== undefined && normalizeListId(match.listId) !== message.listId) return false;
  if (match.subjectContains !== undefined
    && !message.subject.toLowerCase().includes(match.subjectContains.toLowerCase())) return false;
  if (match.to !== undefined && !message.to.includes(match.to.toLowerCase())) return false;
  if (match.automated !== undefined && match.automated !== message.automated) return false;
  return true;
}
