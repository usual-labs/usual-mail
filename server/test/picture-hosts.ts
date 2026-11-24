// Fake picture hosts for the picture tests: small web servers on the loopback addresses, recording every request
// they get, and made-up pictures. Nothing here reaches the real network; the names are `.example` ones that a fake
// resolver hands out.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedAddress } from "../src/node/pictures/fetch.ts";

export interface SeenRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
}

export interface FakeHost {
  /** The port it listens on. */
  port: number;
  /** Every request it got, in order. */
  requests: SeenRequest[];
  /** Every connection it accepted, whether or not a request followed. */
  connections: number;
  close(): Promise<void>;
}

export type Handler = (request: IncomingMessage, response: ServerResponse, host: FakeHost) => void;

async function listen(server: Server, address: string, port: number, handler: Handler): Promise<FakeHost> {
  const host: FakeHost = {
    port: 0,
    requests: [],
    connections: 0,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
  server.on("connection", () => void host.connections++);
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    host.requests.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers });
    handler(request, response, host);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => resolve());
  });
  host.port = (server.address() as AddressInfo).port;
  return host;
}

/** An http host on `address` (127.0.0.1 unless given), on a free port unless one is given. */
export function fakeHost(handler: Handler, options: { address?: string; port?: number } = {}): Promise<FakeHost> {
  return listen(createHttpServer(), options.address ?? "127.0.0.1", options.port ?? 0, handler);
}

/** An https host with the given certificate. */
export function fakeTlsHost(handler: Handler, tls: { key: string; cert: string }, options: { address?: string } = {}): Promise<FakeHost> {
  return listen(createHttpsServer(tls), options.address ?? "127.0.0.1", 0, handler);
}

/**
 * A certificate and key for `pictures.example`, made with the system's openssl in a temporary folder that is removed
 * at once, so no key is ever kept in the repository. Null when there is no openssl.
 */
export function makeCertificate(name = "pictures.example"): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "usual-mail-picture-cert-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
      "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`,
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A resolver that knows only the names it is given, and counts how often it is asked. */
export function fakeResolver(names: Record<string, ResolvedAddress[] | (() => ResolvedAddress[])>) {
  const asked: string[] = [];
  const resolve = async (hostname: string): Promise<ResolvedAddress[]> => {
    asked.push(hostname);
    const found = names[hostname];
    if (!found) throw Object.assign(new Error(`${hostname} is not a fake name`), { code: "ENOTFOUND" });
    return typeof found === "function" ? found() : found;
  };
  return { asked, resolve };
}

export const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
export const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

// --- Made-up pictures ------------------------------------------------------------------------------------------

/** A PNG header of the given size (enough for the server to read it; no pixel data). */
export function png(width: number, height: number, extra = 64): Uint8Array {
  const out = new Uint8Array(33 + extra);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
}

/**
 * A GIF: a logical screen of the given size and frames (each its own size and place; by default one frame filling
 * the screen), each with one empty data block, then the trailer.
 */
export function gif(width: number, height: number, frames: Array<{ left?: number; top?: number; width: number; height: number }> = [{ width, height }]): Uint8Array {
  const bytes: number[] = [...new TextEncoder().encode("GIF89a"), width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0];
  // A graphic control extension, as animated GIFs carry before each frame.
  for (const frame of frames) {
    bytes.push(0x21, 0xf9, 4, 0, 0, 0, 0, 0);
    const { left = 0, top = 0 } = frame;
    bytes.push(0x2c, left & 0xff, left >> 8, top & 0xff, top >> 8, frame.width & 0xff, frame.width >> 8, frame.height & 0xff, frame.height >> 8, 0);
    bytes.push(2, 1, 0x44, 0); // the LZW code size, one data block, the block terminator
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

/** A JPEG with an application segment before its start of frame. */
export function jpeg(width: number, height: number): Uint8Array {
  const out = new Uint8Array(64);
  out.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new TextEncoder().encode("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const at = 2 + 2 + 16;
  out.set([0xff, 0xc0, 0x00, 0x11, 0x08], at);
  new DataView(out.buffer).setUint16(at + 5, height);
  new DataView(out.buffer).setUint16(at + 7, width);
  return out;
}

/** A lossy WebP of the given size. */
export function webp(width: number, height: number): Uint8Array {
  const out = new Uint8Array(40);
  out.set([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);
  out.set([0x9d, 0x01, 0x2a], 23);
  new DataView(out.buffer).setUint16(26, width, true);
  new DataView(out.buffer).setUint16(28, height, true);
  return out;
}

/** An ISO media box: its size, its type and its content. */
function box(type: string, ...content: Uint8Array[]): Uint8Array {
  const size = 8 + content.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const part of content) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const u32 = (...values: number[]) => {
  const out = new Uint8Array(values.length * 4);
  values.forEach((value, i) => new DataView(out.buffer).setUint32(i * 4, value));
  return out;
};

/**
 * An AVIF as decoders read it: the file type box (`decoy` puts "ispe" among its compatible brands), then the meta
 * box holding the item properties with one image spatial extents property per size given.
 */
export function avif(width: number, height: number, more: Array<[number, number]> = [], decoy = false, brand = "avif", movie = false): Uint8Array {
  const brands = new TextEncoder().encode(decoy ? "avifispe" : "avifmif1");
  const ftyp = box("ftyp", new TextEncoder().encode(brand), u32(0), brands);
  const ispe = [[width, height], ...more].map(([w, h]) => box("ispe", u32(0, w!, h!)));
  const meta = box("meta", u32(0), box("iprp", box("ipco", ...ispe)));
  // A movie box, as an image sequence has, with a track header claiming a big frame.
  const moov = movie ? box("moov", box("trak", box("tkhd", new Uint8Array(84)))) : new Uint8Array();
  const out = new Uint8Array(ftyp.length + meta.length + moov.length);
  out.set(ftyp);
  out.set(meta, ftyp.length);
  out.set(moov, ftyp.length + meta.length);
  return out;
}

/** Sends `body` with the type the fake site claims. */
export function serve(body: Uint8Array | string, type = "image/png", headers: Record<string, string> = {}): Handler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": type, ...headers });
    response.end(body);
  };
}
