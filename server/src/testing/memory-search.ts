// A memory mailbox's own search, as a Gmail mailbox has one (docs/contract-search.md): for tests and demo mode. Words
// match whole words of the subject, the people and the text, phrases word for word; the filters as the provider
// contract reads them. Spam and trash are left out; conversations come newest first, a page at a time.

import type { ProviderMessage, ProviderSearchHit, ProviderSearchPage, ProviderSearchQuery } from "@usualmail/core";

function words(text: string): string {
  const plain = text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\.(?![\p{L}\p{N}])/gu, " ");
  return ` ${plain.replace(/[^\p{L}\p{N}@.]+/gu, " ").trim()} `;
}

function everything(m: ProviderMessage): string {
  const people = [m.from, ...m.to, ...m.cc].map((a) => `${a.name ?? ""} ${a.email}`).join(" ");
  return words(`${m.subject} ${people} ${m.text ?? ""} ${(m.html ?? "").replace(/<[^>]*>/g, " ")}`);
}

function has(text: string, phrase: string): boolean {
  const wanted = words(phrase).trim();
  return wanted !== "" && text.includes(` ${wanted} `);
}

function who(addresses: ProviderMessage["to"], value: string): boolean {
  const v = value.toLowerCase();
  return addresses.some((a) => a.email.toLowerCase().includes(v) || (a.name ?? "").toLowerCase().includes(v));
}

function matches(m: ProviderMessage, q: ProviderSearchQuery): boolean {
  const all = everything(m);
  if (![...q.words, ...q.phrases].every((w) => has(all, w))) return false;
  if (q.exclude.some((w) => has(all, w))) return false;
  if (q.from && !who([m.from], q.from)) return false;
  if (q.to && !who([...m.to, ...m.cc], q.to)) return false;
  if (q.subject && !q.subject.split(/\s+/).every((w) => has(words(m.subject), w))) return false;
  const attached = m.attachments.some((a) => !a.inline);
  if (q.hasAttachment !== undefined && attached !== q.hasAttachment) return false;
  const at = Date.parse(m.date);
  if (q.after && at < Date.parse(q.after)) return false;
  if (q.before && at >= Date.parse(q.before)) return false;
  if (q.unread !== undefined && m.seen === q.unread) return false;
  if (q.categories && !q.categories.includes(m.placement.category as never)) return false;
  if (q.screened && !m.placement.screened) return false;
  if (q.archived && m.placement.inInbox) return false;
  return true;
}

const live = (m: ProviderMessage) => !m.placement.spam && !m.placement.trashed;

/** The conversations holding a message the query finds, newest first, `limit` from the page's offset. */
export function memorySearch(all: ProviderMessage[], query: ProviderSearchQuery, options: { page?: string; limit: number }): ProviderSearchPage {
  const found = new Set(all.filter((m) => live(m) && matches(m, query)).map((m) => m.threadKey));
  const threads = [...found].map((key) => all.filter((m) => m.threadKey === key && live(m)).sort((a, b) => Date.parse(a.date) - Date.parse(b.date)));
  // Equal times: the one that arrived later first, as a mailbox stamps its own arrival time.
  const arrived = new Map(all.map((m, i) => [m.ref, i]));
  const last = (list: ProviderMessage[]) => Math.max(...list.map((m) => arrived.get(m.ref)!));
  threads.sort((a, b) => Date.parse(b.at(-1)!.date) - Date.parse(a.at(-1)!.date) || last(b) - last(a));
  const offset = Number(options.page ?? 0) || 0;
  const hits: ProviderSearchHit[] = threads.slice(offset, offset + options.limit).map((list) => {
    const newest = list.at(-1)!;
    return {
      threadKey: newest.threadKey,
      subject: list[0]!.subject,
      from: newest.from,
      date: new Date(Date.parse(newest.date)).toISOString(),
      snippet: (newest.text ?? "").slice(0, 100),
      hasAttachments: list.some((m) => m.attachments.some((a) => !a.inline)),
      messageCount: list.length,
      inInbox: list.some((m) => m.placement.inInbox),
    };
  });
  return offset + options.limit < threads.length ? { hits, next: String(offset + options.limit) } : { hits };
}

/** Every message of one conversation, oldest first, spam and trash left out. */
export function memoryThread(all: ProviderMessage[], threadKey: string): ProviderMessage[] {
  return all.filter((m) => m.threadKey === threadKey && live(m)).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}
