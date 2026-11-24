/**
 * Gmail's full form for the fake: the raw message split into MIME parts shaped as Google's reference describes the
 * MessagePart resource (read 2026-11-21): `partId`, `mimeType`, `filename`, the part's own `headers`, and a `body`
 * with `size` (the bytes once the transfer encoding is undone) and either `data` (those bytes, base64url) or an
 * `attachmentId` for `users.messages.attachments.get`.
 *
 * What Google doesn't document, the fake decides plainly: a part with a filename comes as an `attachmentId`, and so
 * does any other part over `bodyDataLimit` bytes (default: never); header values are as written, unfolded (the line
 * break removed, the folding whitespace kept); a message/rfc822 part that isn't base64 or quoted-printable is expanded
 * into one child, the forwarded message, and has an `attachmentId` for its bytes as well (Gmail shows such a part
 * as an attachment).
 */

export interface FakePartBody {
  size: number;
  data?: string;
  attachmentId?: string;
}

export interface FakePart {
  partId: string;
  mimeType: string;
  filename: string;
  headers: Array<{ name: string; value: string }>;
  body: FakePartBody;
  parts?: FakePart[];
}

export interface FullFormOptions {
  /** An attachment id standing for these bytes. */
  leaveOut: (bytes: Buffer) => string;
  /** Parts without a filename over this many bytes come as an attachment id too. */
  bodyDataLimit: number;
}

const MAX_DEPTH = 64;

export function fullPayload(raw: Buffer, options: FullFormOptions): FakePart {
  return partOf(raw, "", undefined, options, 0);
}

function partOf(bytes: Buffer, partId: string, parentMultipart: string | undefined, options: FullFormOptions, depth: number): FakePart {
  const { headers, body } = splitHead(bytes);
  const contentType = headerValue(headers, "content-type");
  const type = contentType?.split(";")[0]?.trim().toLowerCase() || (parentMultipart === "digest" ? "message/rfc822" : "text/plain");
  const filename = param(headerValue(headers, "content-disposition"), "filename") ?? param(contentType, "name") ?? "";
  const base = { partId, mimeType: type, filename, headers };
  const childId = (i: number) => (partId ? `${partId}.${i}` : String(i));
  if (type.startsWith("multipart/") && depth < MAX_DEPTH) {
    const boundary = param(contentType, "boundary");
    if (boundary) {
      const parts = splitMultipart(body, boundary).map((child, i) => partOf(child, childId(i), type.slice("multipart/".length), options, depth + 1));
      return { ...base, body: { size: 0 }, parts };
    }
  }
  const encoding = (headerValue(headers, "content-transfer-encoding") ?? "").trim().toLowerCase();
  if (type === "message/rfc822" && encoding !== "base64" && encoding !== "quoted-printable" && depth < MAX_DEPTH) {
    const parts = [partOf(body, childId(0), undefined, options, depth + 1)];
    return { ...base, body: { size: body.length, attachmentId: options.leaveOut(body) }, parts };
  }
  const decoded = decode(body, encoding);
  if (filename || decoded.length > options.bodyDataLimit) return { ...base, body: { size: decoded.length, attachmentId: options.leaveOut(decoded) } };
  return { ...base, body: decoded.length ? { size: decoded.length, data: decoded.toString("base64url") } : { size: 0 } };
}

/** The header block (unfolded) and the body after the blank line. */
function splitHead(bytes: Buffer): { headers: Array<{ name: string; value: string }>; body: Buffer } {
  let end = -1;
  let bodyStart = bytes.length;
  for (let lineStart = 0; lineStart < bytes.length; ) {
    const newline = bytes.indexOf(0x0a, lineStart);
    const lineEnd = newline < 0 ? bytes.length : newline > lineStart && bytes[newline - 1] === 0x0d ? newline - 1 : newline;
    if (lineEnd === lineStart) {
      end = lineStart;
      bodyStart = newline < 0 ? bytes.length : newline + 1;
      break;
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  const head = new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
  const headers: Array<{ name: string; value: string }> = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1]!.value += line;
    else if (line.includes(":")) headers.push({ name: line.slice(0, line.indexOf(":")), value: line.slice(line.indexOf(":") + 1) });
  }
  for (const header of headers) header.value = header.value.replace(/^[ \t]+|[ \t]+$/g, "");
  return { headers, body: end < 0 ? Buffer.alloc(0) : bytes.subarray(bodyStart) };
}

/** Each part's bytes: from after its delimiter line to the line break before the next delimiter. */
function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const parts: Buffer[] = [];
  const delimiter = `--${boundary}`;
  let start = -1;
  let lineStart = 0;
  let previousBreak = 0;
  while (lineStart <= body.length) {
    const newline = body.indexOf(0x0a, lineStart);
    const lineEnd = newline < 0 ? body.length : newline > lineStart && body[newline - 1] === 0x0d ? newline - 1 : newline;
    const line = body.subarray(lineStart, lineEnd).toString("latin1");
    if (line.startsWith(delimiter)) {
      const rest = line.slice(delimiter.length).replace(/[ \t]+$/, "");
      if (rest === "" || rest === "--") {
        if (start >= 0) parts.push(body.subarray(start, Math.max(start, previousBreak)));
        if (rest === "--") return parts;
        start = newline < 0 ? body.length : newline + 1;
      }
    }
    if (newline < 0) break;
    previousBreak = lineEnd;
    lineStart = newline + 1;
  }
  if (start >= 0 && start < body.length) parts.push(body.subarray(start));
  return parts;
}

function decode(body: Buffer, encoding: string): Buffer {
  if (encoding === "base64") return Buffer.from(body.toString("latin1"), "base64");
  if (encoding !== "quoted-printable") return body;
  // RFC 2045 6.7: trailing white space goes, a line ending in "=" is a soft break, "=XX" is a byte.
  const out: number[] = [];
  let at = 0;
  while (at <= body.length) {
    const newline = body.indexOf(0x0a, at);
    const breakStart = newline < 0 ? body.length : newline > at && body[newline - 1] === 0x0d ? newline - 1 : newline;
    let line = body.subarray(at, breakStart).toString("latin1").replace(/[ \t]+$/, "");
    const soft = line.endsWith("=");
    if (soft) line = line.slice(0, -1);
    for (let i = 0; i < line.length; i++) {
      const hex = line[i] === "=" ? line.slice(i + 1, i + 3) : "";
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else out.push(line.charCodeAt(i));
    }
    if (newline < 0) break;
    if (!soft) for (const byte of body.subarray(breakStart, newline + 1)) out.push(byte);
    at = newline + 1;
  }
  return Buffer.from(out);
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}

function param(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const match = new RegExp(`;\\s*${name}\\*?\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
  return match ? (match[1] ?? match[2]) : undefined;
}
