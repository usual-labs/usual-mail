/**
 * A Gmail message in the full form, written back as a MIME message for the same parser the raw form goes through,
 * without the bytes Gmail left out: a part it gives as an `attachmentId` gets a short marker as its body. The parser
 * still sees every part with its own headers, so it numbers, names and places attachments as it does for the raw
 * message, and decides text, HTML and attachments by its own rules; the marker in an attachment's content says which
 * Gmail part it is, for its real size and its `attachmentId`.
 *
 * Which parts the parser reads into the text isn't worked out here: `full.ts` rebuilds once with markers, sees which
 * markers come back as attachments, and gives the others (text bodies, an inline forwarded message) their bytes or
 * nothing in a further rebuild. Two rules of the parser are repeated here: a message/rfc822 part keeps its transfer
 * encoding's kind, since the parser reads such a part inline only when it isn't base64 or quoted-printable; and a
 * marked calendar invite is declared UTF-8, since the parser decodes a calendar's content by its charset (a UTF-16
 * invite would otherwise turn the marker into something else).
 *
 * Every multipart gets a boundary of ours (with the rebuild's random nonce), never the one in its header: Gmail has
 * already split the parts, and a boundary the parser read differently from Gmail would lose or merge them.
 *
 * Assumptions about Gmail, from its reference (read 2026-11-21) and not checked against Gmail itself: `headers` are
 * each part's own header fields in the message's order, with values as written (encoded words left for the parser);
 * `body.data` is the part's bytes after its transfer encoding is undone, in its own charset; a message/rfc822 part
 * that Gmail expands has the forwarded message as its one child, with that message's headers.
 */
import type { LeftOutSize } from "../message/parse.ts";

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

/** How a rebuild treats the parts an earlier one marked. */
export interface RebuildPlan {
  /** Bytes fetched for a part Gmail left out. */
  contents?: ReadonlyMap<GmailPart, Uint8Array>;
  /** message/rfc822 parts written out from their expanded children instead of a marker. */
  expand?: ReadonlySet<GmailPart>;
  /** Parts written with no body at all (their bytes were left out and not fetched). */
  empty?: ReadonlySet<GmailPart>;
  /**
   * For serving an attachment: every part that isn't a message/rfc822 gets a marker, its bytes in the full form too,
   * so whatever the parser numbers as an attachment can be traced to Gmail's part (and an emptied one recognised).
   */
  markAll?: boolean;
}

export interface Rebuilt {
  bytes: Uint8Array;
  /** Every part that got a marker, in order. */
  marked: GmailPart[];
  /** The Gmail part an attachment's content stands for, when that content is a marker. */
  partOf(content: Uint8Array): GmailPart | undefined;
  /** For the parser: a marker's real size, Gmail's `body.size`. */
  leftOut: LeftOutSize;
}

const encoder = new TextEncoder();
const NAME = /^[!-9;-~]+$/;
const CALENDAR = new Set(["text/calendar", "application/ics"]);
type Header = { name: string; value: string };

export function rebuildMessage(payload: GmailPart, plan: RebuildPlan = {}): Rebuilt {
  const nonce = globalThis.crypto.randomUUID();
  const marked: GmailPart[] = [];
  const chunks: Uint8Array[] = [];
  let boundaries = 0;
  const write = (text: string) => chunks.push(encoder.encode(text));
  const mark = (part: GmailPart) => {
    marked.push(part);
    return encoder.encode(`usual-mail-left-out:${nonce}:${marked.length - 1}`);
  };

  const writePart = (part: GmailPart, parentMultipart: string | undefined): void => {
    const headers = (part.headers ?? []).filter((h): h is Header => typeof h.name === "string" && NAME.test(h.name) && typeof h.value === "string");
    const type = typeOf(headers, parentMultipart);
    if (type.startsWith("multipart/") && part.parts?.length) {
      const boundary = `usual-mail-${nonce}-${boundaries++}`;
      const others = headers.filter((h) => h.name.toLowerCase() !== "content-type");
      writeHeaders([...others, { name: "Content-Type", value: `${type}; boundary="${boundary}"` }]);
      write("\r\n");
      const subtype = type.slice("multipart/".length);
      for (const child of part.parts) {
        write(`--${boundary}\r\n`);
        writePart(child, subtype);
        write("\r\n");
      }
      write(`--${boundary}--`);
      return;
    }
    // A multipart Gmail found no parts in is written as it came: the parser reads its body as text when its boundary is
    // unusable, as it does for the raw form, and finds nothing in it otherwise.
    const rfc822 = type === "message/rfc822";
    if (rfc822 && plan.expand?.has(part) && part.parts?.length && !plan.contents?.has(part)) {
      writeHeaders(headers);
      write("\r\n");
      writePart(part.parts[0]!, undefined);
      return;
    }
    const body = bodyOf(part, rfc822, plan, mark);
    if (rfc822 && !encodedTransfer(headers)) {
      // Kept as it was written (7bit, 8bit or binary), so the parser still reads it inline when it would.
      writeHeaders(headers);
      write("\r\n");
      chunks.push(body);
      return;
    }
    const declared = marked.at(-1) === part && CALENDAR.has(type) ? asUtf8(headers) : headers;
    writeHeaders([...declared.filter((h) => h.name.toLowerCase() !== "content-transfer-encoding"), { name: "Content-Transfer-Encoding", value: "base64" }]);
    write("\r\n");
    write(base64Lines(body));
  };

  const writeHeaders = (headers: readonly Header[]) => {
    for (const { name, value } of headers) write(`${name}: ${unfoldSafe(value)}\r\n`);
  };

  writePart(payload, undefined);
  write("\r\n");

  const pattern = new RegExp(`^usual-mail-left-out:${nonce}:(\\d+)$`);
  const partOf = (content: Uint8Array): GmailPart | undefined => {
    if (content.byteLength > 120) return undefined;
    const match = pattern.exec(Buffer.from(content).toString("latin1").trimEnd());
    return match ? marked[Number(match[1])] : undefined;
  };
  return {
    bytes: concat(chunks),
    marked,
    partOf,
    leftOut: (content) => {
      const part = partOf(content);
      return part ? (part.body?.size ?? 0) : undefined;
    },
  };
}

/** A part's MIME type as the parser reads it: its Content-Type, else the default its parent gives (RFC 2046). */
function typeOf(headers: readonly Header[], parentMultipart: string | undefined): string {
  const header = headers.find((h) => h.name.toLowerCase() === "content-type")?.value;
  const value = header?.split(";")[0]?.trim().toLowerCase();
  if (value) return value;
  return parentMultipart === "digest" ? "message/rfc822" : "text/plain";
}

function bodyOf(part: GmailPart, rfc822: boolean, plan: RebuildPlan, mark: (part: GmailPart) => Uint8Array): Uint8Array {
  const fetched = plan.contents?.get(part);
  if (fetched) return fetched;
  if (plan.markAll && !rfc822) return mark(part);
  if (plan.empty?.has(part)) return new Uint8Array(0);
  if (typeof part.body?.data === "string" && part.body.data) return Buffer.from(part.body.data, "base64url");
  const leftOut = Boolean(part.body?.attachmentId) && (part.body?.size ?? 1) > 0;
  const expandable = rfc822 && Boolean(part.parts?.length);
  return leftOut || expandable ? mark(part) : new Uint8Array(0);
}

function encodedTransfer(headers: readonly Header[]): boolean {
  const value = headers.find((h) => h.name.toLowerCase() === "content-transfer-encoding")?.value ?? "";
  const token = /^[ \t]*([\w-]+)/.exec(value.replace(/\([^)]*\)/g, " ").toLowerCase())?.[1];
  return token === "base64" || token === "quoted-printable";
}

/** The Content-Type with its charset parameters replaced by UTF-8; every other parameter kept as written. */
function asUtf8(headers: readonly Header[]): Header[] {
  return headers.map((h) => {
    if (h.name.toLowerCase() !== "content-type") return h;
    const [type, ...params] = splitParams(h.value);
    const kept = params.filter((p) => !/^\s*charset\*?\s*=/i.test(p));
    return { name: h.name, value: [type, ...kept, " charset=utf-8"].join(";") };
  });
}

/** Splits a header value at the semicolons outside quoted strings. */
function splitParams(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quoted && c === "\\" && i + 1 < value.length) {
      current += c + value[++i];
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      out.push(current);
      current = "";
    } else current += c;
  }
  out.push(current);
  return out;
}

/** A header value with its line breaks kept as folding, so no line of it can start a header of its own. */
function unfoldSafe(value: string): string {
  return value
    .split(/\r\n|\r|\n/)
    .map((line, i) => (i === 0 || /^[ \t]/.test(line) ? line : ` ${line}`))
    .join("\r\n");
}

function base64Lines(bytes: Uint8Array): string {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += 76) lines.push(text.slice(i, i + 76));
  return lines.join("\r\n");
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
