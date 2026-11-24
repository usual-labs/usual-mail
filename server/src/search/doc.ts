// What search's index holds for one thread (docs/contract-search.md, "What is searched"), built from what the server
// stores, by rule: no provider read, no AI request. Only messages a person sees count, read at the time the thread is
// indexed, so what a blocked sender wrote into someone else's thread is never found and never in an excerpt.

import type { Address, Thread } from "@usualmail/core";
import { minorUnits } from "../ai/currencies.ts";
import { plainLine } from "../ai/text.ts";
import type { AttachmentRow, MessageRow, ThreadRow } from "../db/index.ts";
import { shownIn } from "../service/store.ts";
import { fold } from "./terms.ts";
import type { Column } from "./fts.ts";

/** A message's reading text is indexed up to this many characters, and a thread's bodies up to this many in all. */
export const BODY_PER_MESSAGE = 20_000;
export const BODY_PER_THREAD = 100_000;

/** Raised when what the index makes of a thread changes, so the first start of a build with the change reads every thread again. */
export const INDEX_FORMAT = 1;

export interface PersonRow {
  role: "from" | "to";
  email: string;
  name: string | null;
  folded: string;
  lastAt: number;
}

export interface ThreadDoc {
  columns: Record<Column, string>;
  people: PersonRow[];
}

/**
 * What of the thread's own columns the index reads, as one string: while it is the same, the thread's messages and
 * attachments are the same as when it was indexed (their count, newest time, snippet and people say so), so they aren't
 * read again.
 */
export function sourceOf(row: ThreadRow, served: Thread): string {
  return JSON.stringify([
    INDEX_FORMAT, row.subject, row.snippet, row.participants, row.lastMessageAt, row.messageCount, row.hasAttachments,
    row.sender, served.summary ?? null, served.payment ?? null, served.event ?? null,
  ]);
}

/** What the index reads of a message besides its text and HTML: who wrote it to whom, when, and whether it is the inbox's own. */
export type MessageHead = Pick<MessageRow, "id" | "date" | "from" | "to" | "cc" | "outgoing">;

/** What the index reads of an attachment: its name, whether it is an inline picture, and its message. */
export type FileHead = Pick<AttachmentRow, "messageId" | "inline" | "filename">;

/** A thread's messages a person sees, newest first: the order their reading texts go into the body. */
export function shownNewestFirst<T extends MessageHead>(row: Pick<ThreadRow, "sender">, blocked: Set<string>, list: readonly T[]): T[] {
  return list.filter(shownIn(row.sender, blocked)).sort((a, b) => b.date - a.date || (a.id < b.id ? 1 : -1));
}

/**
 * A thread's body column, built from its shown messages' reading texts (`readingText`), newest first: each message's up
 * to BODY_PER_MESSAGE characters, joined by " · ", until the thread's reach BODY_PER_THREAD. While it isn't `full`, the
 * next message's text is wanted; once it is, no further message is read.
 */
export class ThreadBody {
  #body = "";

  get full(): boolean {
    return this.#body.length >= BODY_PER_THREAD;
  }

  /** The characters the body holds so far. */
  get length(): number {
    return this.#body.length;
  }

  add(reading: string): void {
    const text = reading.slice(0, BODY_PER_MESSAGE);
    if (text) this.#body = this.#body ? `${this.#body} · ${text}` : text;
  }

  get text(): string {
    return this.#body.slice(0, BODY_PER_THREAD);
  }
}

/** The most a message can add to a body: its own text, cut, and the joining " · ". */
export const MAX_ADDED_PER_MESSAGE = BODY_PER_MESSAGE + 3;

/**
 * The thread's index entry: its subject; who wrote (incoming senders' names and addresses) and who else is in it (To and
 * Cc), the inbox's own address left out of both; the summary; the AI's checked facts; attachment names (not inline
 * pictures); and the body, every shown message's reading text newest first (`ThreadBody`, which the indexer fills while
 * reading the messages' text and HTML a few at a time).
 */
export function buildDoc(
  row: ThreadRow,
  served: Thread,
  ownAddress: string,
  blocked: Set<string>,
  list: readonly MessageHead[],
  files: readonly FileHead[],
  body: ThreadBody,
): ThreadDoc {
  const own = ownAddress.toLowerCase();
  const shown = shownNewestFirst(row, blocked, list);
  const senders = new Map<string, Address>();
  const others = new Map<string, Address>();
  const people = new Map<string, PersonRow>();
  const person = (role: "from" | "to", address: Address, at: number) => {
    const email = address.email.toLowerCase();
    if (!email) return;
    const key = `${role} ${email}`;
    const name = address.name ? plainLine(address.name) || null : null;
    const known = people.get(key);
    // Newest first: the first name met is the one they last wrote under.
    if (known) known.lastAt = Math.max(known.lastAt, at);
    else people.set(key, { role, email, name, folded: fold(`${name ?? ""} ${email}`), lastAt: at });
  };
  for (const message of shown) {
    person("from", message.from, message.date);
    for (const to of [...message.to, ...message.cc]) person("to", to, message.date);
    if (!message.outgoing && message.from.email.toLowerCase() !== own) senders.set(message.from.email.toLowerCase(), message.from);
    for (const to of [...message.to, ...message.cc]) {
      if (to.email.toLowerCase() !== own) others.set(to.email.toLowerCase(), to);
    }
  }
  for (const email of senders.keys()) others.delete(email);
  const named = (addresses: Iterable<Address>) =>
    [...addresses].map((a) => plainLine(`${a.name ?? ""} ${a.email}`)).join(" · ");
  const shownIds = new Set(shown.map((m) => m.id));
  return {
    columns: {
      subject: plainLine(row.subject),
      sender: named(senders.values()),
      people: named(others.values()),
      summary: plainLine(served.summary ?? ""),
      facts: factsOf(served),
      attachments: files.filter((f) => !f.inline && shownIds.has(f.messageId)).map((f) => plainLine(f.filename)).join(" · "),
      body: body.text,
    },
    people: [...people.values()],
  };
}

/** The AI's checked facts as words: a payment's party, what for, its amount as written digits and currency; an event's status and what it is about. */
function factsOf(thread: Thread): string {
  const out: string[] = [];
  const payment = thread.payment;
  if (payment) {
    if (payment.party) out.push(payment.party);
    if (payment.what) out.push(payment.what);
    if (payment.amount) out.push(amountWords(payment.amount.minor, payment.amount.currency));
  }
  const event = thread.event;
  if (event) {
    if (event.status) out.push(event.status);
    if (event.about) out.push(event.about);
  }
  return plainLine(out.join(" · "));
}

/**
 * An amount as people type it: "49.99 EUR", and for a thousand or more also grouped ("1234.56 1,234.56 EUR"), so
 * "49,99", "1.234,56" and "1234.56" all find it (the tokenizer reads both "." and "," as a break between digits).
 */
export function amountWords(minor: number, currency: string): string {
  const units = minorUnits(currency) ?? 2;
  const whole = Math.floor(minor / 10 ** units);
  const cents = units ? String(minor % 10 ** units).padStart(units, "0") : "";
  const plain = cents ? `${whole}.${cents}` : String(whole);
  const grouped = whole >= 1000 ? String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (cents ? `.${cents}` : "") : "";
  return [plain, grouped, currency].filter(Boolean).join(" ");
}
