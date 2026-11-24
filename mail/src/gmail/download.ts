/**
 * One part's bytes through `users.messages.attachments.get`, without holding Gmail's whole answer: the JSON is read as
 * a stream and its base64url `data` decoded as it arrives, so an attachment of 20 MB needs about 20 MB, instead of the
 * answer's 27 MB of text, the string parsed out of it and the bytes, all at once.
 */
import { GmailDataError, GmailUnreachable, type GmailClient } from "./client.ts";
import { COST } from "./limits.ts";

/**
 * Gmail's bytes for the part behind `attachmentId` (attachment ids come from the full form of the same message).
 * `expectedSize` (the part's `body.size`) only sizes the buffer: bytes that decoded cleanly are kept whatever their
 * count, and a different count is logged (Google documents `body.size` as the part's byte count, but nothing checks
 * how Gmail counts). Only missing data, or none where the part has a size, is refused.
 */
export async function downloadAttachment(client: GmailClient, messageId: string, attachmentId: string, expectedSize?: number): Promise<Uint8Array> {
  const response = await client.response("GET", `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    cost: COST.attachmentsGet,
  });
  if (!response.body) throw new GmailDataError("Gmail sent no attachment data.");
  const bytes = await base64Field(response.body, "data", expectedSize);
  if (!bytes || (bytes.byteLength === 0 && (expectedSize ?? 0) > 0)) throw new GmailDataError("Gmail sent no attachment data.");
  if (typeof expectedSize === "number" && bytes.byteLength !== expectedSize) {
    console.warn(`Gmail: a part of message ${messageId} came as ${bytes.byteLength} bytes; its size said ${expectedSize}. Kept as it came.`);
  }
  return bytes;
}

/**
 * Reads a JSON object from `stream` and decodes its top-level string field `field` as base64url while it streams.
 * Other fields are skipped, whatever they hold. JSON's escapes are read in the field too (some encoders write `=` as
 * `\u003d`), and anything outside base64's alphabets is dropped before decoding. Undefined when the object has no such
 * field. An answer that breaks off is GmailUnreachable; one that can't be read as JSON is GmailDataError.
 */
export async function base64Field(stream: ReadableStream<Uint8Array>, field: string, expectedSize = 0): Promise<Uint8Array | undefined> {
  const reader = stream.getReader();
  const text = new TextDecoder();
  const out = new Bytes(expectedSize);
  const scanner = new FieldScanner(field, out);
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw new GmailUnreachable(`Gmail's answer broke off: ${(error as Error)?.message ?? String(error)}`);
      }
      if (chunk.done) break;
      scanner.feed(text.decode(chunk.value, { stream: true }));
    }
  } catch (error) {
    // Let the connection go rather than leave the rest of the answer unread.
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  scanner.feed(text.decode());
  scanner.end();
  return scanner.found ? out.take() : undefined;
}

type Phase = "key" | "colon" | "value" | "scalar" | "after";

/** A small JSON reader that tracks strings and nesting, enough to find one top-level field in an object. */
class FieldScanner {
  readonly field: string;
  readonly out: Bytes;
  found = false;
  #depth = 0;
  #phase: Phase = "key";
  #inString = false;
  #escaped = false;
  #key: string | undefined;
  #inTarget = false;
  /** Inside the field: "" just after a backslash, "u" and the hex digits read so far of a \u escape. */
  #escape: string | undefined;
  #pending = "";

  constructor(field: string, out: Bytes) {
    this.field = field;
    this.out = out;
  }

  feed(text: string): void {
    let i = 0;
    while (i < text.length) {
      if (this.#inTarget) {
        if (this.#escape !== undefined) {
          this.#escapeChar(text[i++]!);
          continue;
        }
        STOP.lastIndex = i;
        const stop = STOP.exec(text);
        const end = stop ? stop.index : text.length;
        this.#take(text.slice(i, end));
        if (!stop) return;
        i = end + 1;
        if (stop[0] === "\\") {
          this.#escape = "";
          continue;
        }
        this.#flush(true);
        this.#inTarget = false;
        this.found = true;
        this.#phase = "after";
        continue;
      }
      const c = text[i++]!;
      if (this.#inString) {
        if (this.#escaped) {
          this.#escaped = false;
          if (this.#key !== undefined && this.#phase === "key") this.#key += c;
        } else if (c === "\\") this.#escaped = true;
        else if (c === '"') {
          this.#inString = false;
          if (this.#depth === 1) this.#phase = this.#key !== undefined && this.#phase === "key" ? "colon" : "after";
        } else if (this.#key !== undefined && this.#phase === "key" && this.#key.length < 256) this.#key += c;
        continue;
      }
      if (c === " " || c === "\n" || c === "\r" || c === "\t") continue;
      if (this.#depth === 0) {
        if (c !== "{") throw new GmailDataError("Gmail's answer wasn't a JSON object.");
        this.#depth = 1;
        this.#phase = "key";
        continue;
      }
      if (this.#depth > 1) {
        if (c === '"') this.#inString = true;
        else if (c === "{" || c === "[") this.#depth++;
        else if (c === "}" || c === "]") {
          this.#depth--;
          if (this.#depth === 1) this.#phase = "after";
        }
        continue;
      }
      this.#topLevel(c);
    }
  }

  #topLevel(c: string): void {
    switch (this.#phase) {
      case "key":
        if (c === '"') {
          this.#inString = true;
          this.#key = "";
        } else if (c === "}") this.#depth = 0;
        return;
      case "colon":
        if (c === ":") this.#phase = "value";
        return;
      case "value":
        if (c === '"') {
          if (this.#key === this.field && !this.found) this.#inTarget = true;
          else {
            this.#inString = true;
            this.#key = undefined;
          }
        } else if (c === "{" || c === "[") this.#depth++;
        else this.#phase = "scalar";
        return;
      case "scalar":
      case "after":
        if (c === ",") {
          this.#phase = "key";
          this.#key = undefined;
        } else if (c === "}") this.#depth = 0;
        return;
    }
  }

  /** One character of an escape inside the field. */
  #escapeChar(c: string): void {
    if (this.#escape === "") {
      if (c === "u") {
        this.#escape = "u";
        return;
      }
      this.#escape = undefined;
      if (!(c in SIMPLE_ESCAPES)) throw new GmailDataError("Gmail's answer holds an escape JSON doesn't have.");
      this.#take(SIMPLE_ESCAPES[c]!);
      return;
    }
    const sequence = `${this.#escape ?? "u"}${c}`;
    if (sequence.length < 5) {
      this.#escape = sequence;
      return;
    }
    const hex = sequence.slice(1);
    this.#escape = undefined;
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new GmailDataError("Gmail's answer holds an escape JSON doesn't have.");
    this.#take(String.fromCharCode(parseInt(hex, 16)));
  }

  /** Characters of the field: base64's (either alphabet) and padding kept, anything else dropped. */
  #take(slice: string): void {
    this.#pending += /^[A-Za-z0-9\-_+/=]*$/.test(slice) ? slice : slice.replace(/[^A-Za-z0-9\-_+/=]/g, "");
    if (this.#pending.length >= 65_536) this.#flush(false);
  }

  /** Decodes whole groups of four characters (all that is left at the end). */
  #flush(final: boolean): void {
    const whole = final ? this.#pending.length : this.#pending.length - (this.#pending.length % 4);
    if (!whole) return;
    this.out.push(Buffer.from(this.#pending.slice(0, whole), "base64url"));
    this.#pending = this.#pending.slice(whole);
  }

  end(): void {
    if (this.#inTarget || this.#inString || this.#depth !== 0) throw new GmailDataError("Gmail's answer ended early.");
  }
}

const STOP = /["\\]/g;
const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Bytes written in order into one buffer, sized up front when the size is known. */
class Bytes {
  #buffer: Uint8Array;
  #length = 0;

  constructor(expected: number) {
    this.#buffer = new Uint8Array(Math.max(0, Math.floor(expected)));
  }

  push(chunk: Uint8Array): void {
    if (this.#length + chunk.byteLength > this.#buffer.byteLength) {
      const grown = new Uint8Array(Math.max(this.#length + chunk.byteLength, this.#buffer.byteLength * 2));
      grown.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = grown;
    }
    this.#buffer.set(chunk, this.#length);
    this.#length += chunk.byteLength;
  }

  take(): Uint8Array {
    return this.#length === this.#buffer.byteLength ? this.#buffer : this.#buffer.slice(0, this.#length);
  }
}
