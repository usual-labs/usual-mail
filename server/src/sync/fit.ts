// Fitting a message into what the host stores (`HostLimits.storedMessageBytes`). A Durable Object's rows hold at most
// 8 MB, all columns together, and a statement writing a larger one fails; the sync keeps its cursor only once a batch is
// stored, so one such message would fail its batch at every try, forever. So, on a host with a limit, a message whose
// stored row would be larger is made to fit before it is taken in: headers no message needs that long are cut first
// (only when they alone take more than a quarter of the limit), then the HTML is left out and the text kept (made from
// the HTML when there is none), then the text is cut; each step leaves a note in the text. The same message read again
// fits the same way, so it isn't rewritten at every sync. Node sets no limit: every message is stored as it came.

import type { Address, ProviderMessage } from "@usualmail/core";
import { isStubText, readableHtml } from "../ai/text.ts";

/** Ends the text of a message whose HTML was left out. */
export const HTML_LEFT_OUT = "[This message is too large to keep here in full, so its formatted version was left out. Open it in the mailbox to see all of it.]";
/** Ends the text of a message whose text was cut. */
export const TEXT_CUT = "[This message is too large to keep here in full, so its text was cut here. Open it in the mailbox to read all of it.]";

/** How long a single header value is kept, in characters, once headers must be cut. */
const LONG_HEADER = 2_000;
/** How long an identifier (Message-ID, a reference, the thread's key) or one address part is kept then. */
const LONG_ID = 1_000;
/** How many references are kept then: the first, which names the thread's root, and the last ones, the closest parents. */
const KEPT_REFERENCES = 50;

/** The UTF-8 length of a string, without encoding it. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

const json = (value: unknown): number => (value === undefined ? 0 : utf8Length(JSON.stringify(value)));
const str = (value: string | undefined): number => (value === undefined ? 0 : utf8Length(value));

/** About the bytes the message's row takes in the store: every text and JSON column, and eight for each other one. */
export function storedBytes(m: ProviderMessage): number {
  return str(m.ref) + str(m.threadKey) + str(m.messageId) + str(m.inReplyTo) + json(m.references) + json(m.from) + json(m.to)
    + json(m.cc) + json(m.bcc) + json(m.replyTo) + str(m.subject) + str(m.text) + str(m.html) + str(m.listId)
    + str(m.listUnsubscribe) + json(m.placement) + str(m.fromCheck?.result) + str(m.fromCheck?.result === "verified" ? m.fromCheck.domain : undefined)
    + 160;
}

/** `text` cut to at most `bytes` UTF-8 bytes, never inside a character. */
function cutBytes(text: string, bytes: number): string {
  if (utf8Length(text) <= bytes) return text;
  let low = 0;
  let high = Math.min(text.length, bytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Length(text.slice(0, mid)) <= bytes) low = mid;
    else high = mid - 1;
  }
  // Not between the two halves of a surrogate pair.
  const code = text.charCodeAt(low - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? low - 1 : low);
}

const cut = (text: string | undefined, chars: number): string | undefined => (text === undefined || text.length <= chars ? text : text.slice(0, chars));
const cutAddress = (address: Address): Address => {
  const email = cut(address.email, LONG_ID)!;
  const name = cut(address.name, LONG_ID);
  return name === undefined ? { email } : { name, email };
};

/** The message with headers no message needs that long cut, its address lists kept within `budget` bytes in all. */
function cutHeaders<T extends ProviderMessage>(m: T, budget: number): T {
  const out: T = {
    ...m,
    threadKey: cut(m.threadKey, LONG_ID)!,
    subject: cut(m.subject, LONG_HEADER)!,
    references: (m.references.length <= KEPT_REFERENCES ? m.references : [m.references[0]!, ...m.references.slice(-(KEPT_REFERENCES - 1))])
      .map((ref) => cut(ref, LONG_ID)!),
    from: cutAddress(m.from),
    attachments: m.attachments.map((file) => ({ ...file, filename: cut(file.filename, LONG_ID)!, mimeType: cut(file.mimeType, LONG_ID)! })),
  };
  for (const [key, chars] of [["messageId", LONG_ID], ["inReplyTo", LONG_ID], ["listId", LONG_ID], ["listUnsubscribe", LONG_HEADER]] as const) {
    if (m[key] !== undefined) out[key] = cut(m[key], chars)!;
  }
  // The address lists, in order, while they fit what is left of the budget.
  let left = budget - storedBytes({ ...out, to: [], cc: [], bcc: [], text: undefined, html: undefined } as ProviderMessage);
  const keep = (list: Address[]): Address[] => {
    const kept: Address[] = [];
    for (const address of list.map(cutAddress)) {
      const size = json(address) + 1;
      if (size > left) break;
      left -= size;
      kept.push(address);
    }
    return kept;
  };
  out.to = keep(m.to);
  out.cc = keep(m.cc);
  out.bcc = keep(m.bcc);
  if (m.replyTo !== undefined) out.replyTo = keep(m.replyTo);
  return out;
}

/** The message as the store keeps it on a host whose rows hold at most `maxBytes` (Infinity: as it came). */
export function fitMessage<T extends ProviderMessage>(m: T, maxBytes: number): T {
  if (!Number.isFinite(maxBytes) || storedBytes(m) <= maxBytes) return m;
  let out: T = m;
  const head = storedBytes({ ...m, text: undefined, html: undefined });
  if (head > maxBytes / 4) out = cutHeaders(m, Math.floor(maxBytes / 4));
  const budget = maxBytes - storedBytes({ ...out, text: undefined, html: undefined });
  if (str(out.text) + str(out.html) <= budget) return out;

  // The HTML goes; the text stays, made from the HTML when there is none or only a stub of it.
  let text = out.text ?? "";
  if (out.html !== undefined) {
    if (!text.trim() || isStubText(out.text ?? null, out.html)) text = readableHtml(out.html);
    text = text ? `${text}\n\n${HTML_LEFT_OUT}` : HTML_LEFT_OUT;
  }
  if (utf8Length(text) > budget) text = `${cutBytes(text, Math.max(0, budget - utf8Length(TEXT_CUT) - 2))}\n\n${TEXT_CUT}`;
  const { html: _html, ...rest } = out;
  return { ...rest, text } as T;
}
