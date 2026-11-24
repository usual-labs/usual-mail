// Serving an attachment's bytes, and a picture from the web a message shows. Files are sandboxed and only pictures
// and PDFs open inline, so an HTML or SVG attachment can't run script on the server's origin.

import type { ServedPicture, WebPicture } from "../host.ts";
import type { AttachmentFile } from "../service/server.ts";

const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|heic|avif)|application\/pdf)$/;

export function attachmentResponse(file: AttachmentFile): Response {
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType) ? file.mimeType.toLowerCase() : "application/octet-stream";
  const disposition = INLINE_TYPES.test(type) ? "inline" : "attachment";
  const ascii = file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_") || "attachment";
  const bytes = new Uint8Array(file.data);
  return new Response(bytes, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** Bytes as a response's body, without a copy when they are an ordinary array buffer's (they always are here). */
function bodyOf(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data);
}

/**
 * A picture from the web, as the picture source gave it: its type is the one read from its bytes (never an SVG),
 * shown inline, sandboxed and never sniffed again. A kept picture a host streams from its store goes out as it is read,
 * a part at a time.
 */
export function pictureResponse(picture: ServedPicture): Response {
  const streamed = "stream" in picture;
  return new Response(streamed ? picture.stream : bodyOf(picture.data), {
    headers: {
      "Content-Type": picture.mimeType,
      "Content-Length": String(streamed ? picture.size : picture.data.byteLength),
      "Content-Disposition": 'inline; filename="picture"',
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, max-age=86400",
    },
  });
}

/**
 * A sender picture the server keeps: always a PNG, JPEG or WebP read from its bytes, under an id that changes with the
 * picture, so it may be kept for good. Inline, sandboxed and never sniffed again.
 */
export function avatarResponse(picture: WebPicture): Response {
  return new Response(bodyOf(picture.data), {
    headers: {
      "Content-Type": picture.mimeType,
      "Content-Length": String(picture.data.byteLength),
      "Content-Disposition": 'inline; filename="avatar"',
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
