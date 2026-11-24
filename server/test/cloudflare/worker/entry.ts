// The test entry: the deployed Worker and object with hooks only tests need. Never deployed: wrangler.jsonc's `main` is
// server/src/cloudflare/worker.ts, and the tests build this file in its place (harness.ts). bundle.test.ts checks
// that none of this is in the deployable bundle.
//
// - POST /__test/sql {"query", "params"}: runs one statement on the object's SQLite and answers its rows, as the
//   Cloudflare dashboard's Data Studio reads and writes every table.
// - POST /__test/evict: resets the object (`ctx.abort`), as an eviction or a deploy would; its memory and timers go.
// - GET /__test/alarm: when the object's alarm is due (null when none is set), and the time now.
// - GET /__test/kv: every entry of the object's key-value storage (Data Studio's _cf_KV table).
// - POST /__test/throw: the object's fetch throws, as a failing object would, for the front Worker's error answer.
// - The start faults, limits and web hooks of hooks.ts (the start, limits and pictures tests).
// - The alarm's backstop is 1.5 s instead of a minute, and the Gmail provider's quota is lifted, so a sync of 150
//   messages takes seconds; everything else is the deployed object's.

import { CLOUDFLARE_GMAIL } from "../../../src/cloudflare/parts.ts";
import { UsualMailServer as Deployed, type ObjectOptions } from "../../../src/cloudflare/object.ts";
import { testHooks, testLimits, testMigrate } from "./hooks.ts";

export { default } from "../../../src/cloudflare/worker.ts";

// Only handlers and classes may be exported from a Worker's main module.
const TEST_BACKSTOP_MS = 1500;

export class UsualMailServer extends Deployed {
  protected override objectOptions(): ObjectOptions {
    // Start faults and limits a test set (hooks.ts): the deployed migrations and limits otherwise.
    return { backstopMs: TEST_BACKSTOP_MS, gmail: { ...CLOUDFLARE_GMAIL, quotaPerSecond: 1_000_000 }, migrate: testMigrate, limits: testLimits(this.ctx.storage.kv) };
  }

  override async fetch(request: Request): Promise<Response> {
    const hooked = await testHooks(this.ctx, request);
    if (hooked) return hooked;
    const path = new URL(request.url).pathname;
    if (path === "/__test/sql" && request.method === "POST") {
      const { query, params = [] } = await request.json<{ query: string; params?: unknown[] }>();
      try {
        return Response.json(this.ctx.storage.sql.exec(query, ...params).toArray());
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    if (path === "/__test/alarm") {
      return Response.json({ alarm: await this.ctx.storage.getAlarm(), now: Date.now() });
    }
    if (path === "/__test/evict" && request.method === "POST") {
      this.ctx.abort("Reset by a test");
    }
    if (path === "/__test/kv") {
      // The object's key-value storage, as Data Studio shows its _cf_KV table.
      return Response.json([...this.ctx.storage.kv.list()]);
    }
    if (path === "/__test/throw" && request.method === "POST") {
      throw new Error("A test's own failure inside the object, with a detail no answer may show: test-internal-detail");
    }
    return super.fetch(request);
  }
}
