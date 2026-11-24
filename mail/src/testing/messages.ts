/**
 * Small builders for raw test messages. Addresses end in .example; nothing here is real mail.
 */
import { randomUUID } from "node:crypto";

export interface TestMessage {
  from: string;
  to: string;
  subject: string;
  body?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  date?: Date;
  headers?: Record<string, string>;
}

export function newMessageId(domain = "test.example"): string {
  return `${randomUUID()}@${domain}`;
}

function headerBlock(message: TestMessage, messageId: string): string[] {
  const lines = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${(message.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
  ];
  if (message.inReplyTo) lines.push(`In-Reply-To: <${message.inReplyTo}>`);
  if (message.references?.length) lines.push(`References: ${message.references.map((id) => `<${id}>`).join(" ")}`);
  for (const [name, value] of Object.entries(message.headers ?? {})) lines.push(`${name}: ${value}`);
  return lines;
}

/** A plain text message. Returns the raw text (CRLF line ends) and its Message-ID. */
export function plainMessage(message: TestMessage): { raw: string; messageId: string } {
  const messageId = message.messageId ?? newMessageId();
  const lines = [...headerBlock(message, messageId), "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", message.body ?? "Hello."];
  return { raw: lines.join("\r\n") + "\r\n", messageId };
}

export interface TestAttachment {
  filename: string;
  mimeType: string;
  content: Uint8Array;
  contentId?: string;
}

/** A message with an HTML body, a text body, and attachments; parts with a Content-ID are inline pictures. */
export function messageWithAttachments(message: TestMessage, attachments: TestAttachment[]): { raw: string; messageId: string } {
  const messageId = message.messageId ?? newMessageId();
  const mixed = `mixed-${randomUUID()}`;
  const related = `related-${randomUUID()}`;
  const inline = attachments.filter((a) => a.contentId);
  const attached = attachments.filter((a) => !a.contentId);
  const images = inline.map((a) => `<img src="cid:${a.contentId}" alt="${a.filename}">`).join("");
  const lines = [...headerBlock(message, messageId), `Content-Type: multipart/mixed; boundary="${mixed}"`, "", `--${mixed}`];
  lines.push(`Content-Type: multipart/related; boundary="${related}"`, "", `--${related}`);
  lines.push("Content-Type: text/html; charset=utf-8", "", `<p>${message.body ?? "Hello."}</p>${images}`);
  for (const part of inline) {
    lines.push(`--${related}`, ...partHeaders(part, "inline"), "", ...base64Lines(part.content));
  }
  lines.push(`--${related}--`);
  for (const part of attached) {
    lines.push(`--${mixed}`, ...partHeaders(part, "attachment"), "", ...base64Lines(part.content));
  }
  lines.push(`--${mixed}--`, "");
  return { raw: lines.join("\r\n"), messageId };
}

function partHeaders(part: TestAttachment, disposition: string): string[] {
  const headers = [
    `Content-Type: ${part.mimeType}; name="${part.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${disposition}; filename="${part.filename}"`,
  ];
  if (part.contentId) headers.push(`Content-ID: <${part.contentId}>`);
  return headers;
}

function base64Lines(content: Uint8Array): string[] {
  const text = Buffer.from(content).toString("base64");
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 76) out.push(text.slice(i, i + 76));
  return out;
}

/** Every byte value, several times over, so attachment round trips can't hide an encoding slip. */
export function everyByte(repeat = 4): Uint8Array {
  const out = new Uint8Array(256 * repeat);
  for (let i = 0; i < out.length; i++) out[i] = i % 256;
  return out;
}

/** A 1×1 PNG. */
export const TINY_PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);
