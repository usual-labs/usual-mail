// Test hooks for the start, the host's limits and pictures from the web, used by the test entry (entry.ts) only and never
// deployed (bundle.test.ts checks no `__test/` is in the deployable bundle).
//
// - POST /__test/start-faults {"fail"?, "cut"?}: the next `fail` starts' migrations throw, the next `cut` starts are cut
//   off in the middle of their migrations (the object reset, as the runtime resets one over its CPU or memory limit);
//   GET answers what is left and how many migrations were attempted.
// - POST /__test/limits {...HostLimits}: limits over the deployed ones, for the next instance (a test then evicts).
// - POST /__test/web {"op", ...}: the Worker's fetcher (`fetch`), the picture source over the object's SQLite
//   (`picture`, `forget`; with a clock and caps a test gives, several asks at once of one source, or the inbox forgotten
//   while its picture is fetched) and the server's site icon source (`site`; its own when a test gives limits), run in workerd against
//   the fake hosts behind Miniflare's outbound service.

import { SiteIcons, type SITE_LIMITS } from "../../../src/avatars/site-icons.ts";
import { OwnHosts } from "../../../src/cloudflare/address.ts";
import { migrateStore } from "../../../src/cloudflare/database.ts";
import { CLOUDFLARE_LIMITS } from "../../../src/cloudflare/limits.ts";
import { fetchWebBytes, type WorkerFetchOptions } from "../../../src/cloudflare/web/fetch.ts";
import { createPictureTables, SqlPictureSource } from "../../../src/cloudflare/web/pictures.ts";
import { webSources } from "../../../src/cloudflare/web/sources.ts";
import type { HostLimits, ServedPicture } from "../../../src/host.ts";
import { PictureRefused } from "../../../src/pictures/refused.ts";

const FAULTS = "__test-start-faults";
const LIMITS = "__test-limits";

interface StartFaults {
  fail?: number;
  cut?: number;
  attempts?: number;
}

/** The test entry's migrations: the deployed ones, unless a test asked the next to fail or to be cut off. */
export async function testMigrate(ctx: DurableObjectState): Promise<void> {
  const kv = ctx.storage.kv;
  const faults = kv.get<StartFaults>(FAULTS) ?? {};
  const cut = faults.cut ?? 0;
  const fail = faults.fail ?? 0;
  kv.put(FAULTS, { attempts: (faults.attempts ?? 0) + 1, cut: Math.max(0, cut - 1), fail: cut > 0 ? fail : Math.max(0, fail - 1) });
  // Counted from the log, so a test needn't ask (a request would make a new instance, and start it).
  console.log(`Test migration ${cut > 0 ? "cut off" : fail > 0 ? "failing" : "running"}`);
  if (cut > 0) {
    await ctx.storage.sync();
    ctx.abort("A migration cut off by a test");
  }
  if (fail > 0) throw new Error("A migration failed (a test's own failure)");
  await migrateStore(ctx.storage);
}

/** The limits a test set for this instance, over the deployed ones. */
export function testLimits(kv: SyncKvStorage): HostLimits {
  return { ...CLOUDFLARE_LIMITS, ...kv.get<HostLimits>(LIMITS) };
}

interface PictureOp {
  op: "picture";
  inboxId: string;
  url: string;
  now?: number;
  maxBytes?: number;
  records?: { count: number; maxIdleMs: number };
  options?: WorkerFetchOptions;
  /** Asks this many times at once, of one source. */
  together?: number;
  /** Forgets the inbox while the picture is being fetched, then waits for the fetch. */
  forgetDuring?: boolean;
}

type WebOp =
  | { op: "fetch"; url: string; options?: WorkerFetchOptions; ownHosts?: string[] }
  | PictureOp
  | { op: "forget"; inboxId: string }
  | { op: "site"; domain: string; limits?: Partial<typeof SITE_LIMITS> };

/** A picture as the source gave it: its size, and for a stream the size of each chunk it read out. */
async function read(picture: ServedPicture): Promise<{ mimeType: string; size: number; chunks: number[] | null }> {
  if (!("stream" in picture)) return { mimeType: picture.mimeType, size: picture.data.byteLength, chunks: null };
  const chunks: number[] = [];
  const reader = picture.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value.byteLength);
  }
  return { mimeType: picture.mimeType, size: chunks.reduce((sum, size) => sum + size, 0), chunks };
}

const failure = (error: unknown) =>
  Response.json(error instanceof PictureRefused ? { ok: false, message: error.message, kind: error.kind } : { ok: false, message: String(error), kind: "error" });

async function web(ctx: DurableObjectState, body: WebOp): Promise<Response> {
  createPictureTables(ctx.storage.sql);
  try {
    if (body.op === "fetch") {
      const own = new OwnHosts(null);
      for (const host of body.ownHosts ?? []) own.note(`https://${host}`);
      const got = await fetchWebBytes(body.url, { ...body.options, ownHost: (host) => own.has(host) });
      return Response.json({ ok: true, size: got.bytes.byteLength, url: got.url, text: new TextDecoder().decode(got.bytes.subarray(0, 64)) });
    }
    if (body.op === "picture" || body.op === "forget") {
      const { now, maxBytes, records, options } = body.op === "picture" ? body : ({} as Partial<PictureOp>);
      const source = new SqlPictureSource(ctx.storage, {
        ...(now !== undefined && { now: () => now }),
        ...(maxBytes !== undefined && { maxBytes }),
        ...(records !== undefined && { records }),
        fetch: async (url) => (await fetchWebBytes(url, options)).bytes,
      });
      if (body.op === "forget") {
        await source.forget(body.inboxId);
        return Response.json({ ok: true });
      }
      const asks = Array.from({ length: body.together ?? 1 }, () => source.get(body.inboxId, body.url));
      if (body.forgetDuring) await source.forget(body.inboxId);
      const pictures = await Promise.all((await Promise.all(asks)).map(read));
      const first = pictures[0]!;
      return Response.json({ ok: true, mimeType: first.mimeType, size: first.size, sizes: pictures.map((p) => p.size), streamed: first.chunks !== null, chunks: first.chunks });
    }
    // The server's own site icon source (web/sources.ts), unless the test gives limits of its own.
    const icons = body.limits ? new SiteIcons((url, request) => fetchWebBytes(url, request), { limits: body.limits }) : webSources(ctx.storage, () => false).siteIcons;
    const icon = await icons.fetch(body.domain);
    return Response.json(icon.found ? { ok: true, found: true, mimeType: icon.mimeType, fit: icon.fit } : { ok: true, ...icon });
  } catch (error) {
    return failure(error);
  }
}

/** The hooks' answer, or null for any other request. */
export async function testHooks(ctx: DurableObjectState, request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/__test/start-faults") {
    if (request.method === "POST") ctx.storage.kv.put(FAULTS, { ...ctx.storage.kv.get<StartFaults>(FAULTS), ...await request.json<StartFaults>() });
    return Response.json(ctx.storage.kv.get<StartFaults>(FAULTS) ?? {});
  }
  if (path === "/__test/limits" && request.method === "POST") {
    ctx.storage.kv.put(LIMITS, await request.json<HostLimits>());
    return Response.json({ ok: true });
  }
  if (path === "/__test/web" && request.method === "POST") return web(ctx, await request.json<WebOp>());
  return null;
}
