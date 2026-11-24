// The sender picture queue's caps: one site at a time, never two at once, a gap between two fetches, at most so many a
// day; a source that throws is recorded as failed rather than asked again at once; nothing is fetched without a
// source. Small limits so the test is quick; the defaults (5 seconds, 500 a day) are the same code.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { avatarSites } from "../src/db/index.ts";
import type { SiteIcon } from "../src/avatars/sites.ts";
import { AvatarQueue, QUEUE_LIMITS } from "../src/avatars/queue.ts";
import { FakeModels } from "../src/index.ts";
import { Ctx } from "../src/service/context.ts";
import { FakeSites, serve, TEST_SUFFIXES, world } from "./avatar-hosts.ts";
import { DAY } from "./helpers.ts";

async function withDue(domains: string[]) {
  const w = await world();
  const now = w.clock.now();
  await w.host.db.insert(avatarSites).values(domains.map((domain) => ({ domain, state: "queued" as const, dueAt: now, wantedAt: now, createdAt: now })));
  return w;
}

describe("the fetch queue", () => {
  test("fetches one site at a time, a gap apart, at most the day's cap", async () => {
    const w = await withDue(["a.example", "b.example", "c.example", "d.example", "e.example"]);
    const sites = new FakeSites();
    w.host.siteIcons = sites;
    const server = await serve(w, { suffixes: TEST_SUFFIXES, backfill: false, queue: { gapMs: 1_000, perDay: 3 } });
    await server.whenIdle();
    assert.equal(sites.asked.length, 1, "one at the start");
    w.clock.advance(999);
    await server.whenIdle();
    assert.equal(sites.asked.length, 1, "not before the gap");
    w.clock.advance(1);
    await server.whenIdle();
    assert.equal(sites.asked.length, 2);
    w.clock.advance(1_000);
    await server.whenIdle();
    assert.equal(sites.asked.length, 3);
    w.clock.advance(60 * 60_000);
    await server.whenIdle();
    assert.equal(sites.asked.length, 3, "the day's cap");
    w.clock.advance(DAY);
    await server.whenIdle();
    assert.ok(sites.asked.length >= 4, "the next day goes on");
    assert.equal(sites.most, 1, "never two at once");
    assert.deepEqual(new Set(sites.asked).size, sites.asked.length, "each once");
    await server.stop();
    w.store.close();
  });

  test("never overlaps a fetch still running, however long it takes", async () => {
    const w = await withDue(["a.example", "b.example"]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const asked: string[] = [];
    let running = 0;
    let most = 0;
    w.host.siteIcons = {
      async fetch(domain): Promise<SiteIcon> {
        asked.push(domain);
        most = Math.max(most, ++running);
        await held;
        running--;
        return { found: false, kind: "none", reason: "nothing" };
      },
    };
    const server = await serve(w, { suffixes: TEST_SUFFIXES, backfill: false, queue: { gapMs: 10 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    w.clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(asked, ["a.example"]);
    release();
    await server.whenIdle();
    w.clock.advance(60_000);
    await server.whenIdle();
    assert.deepEqual(asked, ["a.example", "b.example"]);
    assert.equal(most, 1);
    await server.stop();
    w.store.close();
  });

  test("waking it while a fetch runs never starts a second one", async () => {
    const w = await withDue(["a.example", "b.example", "c.example"]);
    const ctx = new Ctx(w.host, w.providers, new FakeModels(), {});
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const asked: string[] = [];
    let running = 0;
    let most = 0;
    const work: Promise<unknown>[] = [];
    const queue = new AvatarQueue(ctx, {
      async fetch(domain): Promise<SiteIcon> {
        asked.push(domain);
        most = Math.max(most, ++running);
        await held;
        running--;
        return { found: false, kind: "none", reason: "nothing" };
      },
    }, (promise) => void work.push(promise), { gapMs: 0 });
    queue.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let i = 0; i < 5; i++) queue.wake();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(asked, ["a.example"]);
    release();
    for (let seen = -1; seen !== work.length;) {
      seen = work.length;
      await Promise.all(work);
    }
    assert.deepEqual(asked, ["a.example", "b.example", "c.example"]);
    assert.equal(most, 1);
    queue.stop();
    w.store.close();
  });

  test("a source that throws is recorded as failed, not asked again at once", async () => {
    const w = await withDue(["a.example"]);
    let calls = 0;
    w.host.siteIcons = { fetch: async () => (calls++, Promise.reject(new Error("boom"))) };
    const server = await serve(w, { suffixes: TEST_SUFFIXES, backfill: false });
    await server.whenIdle();
    w.clock.advance(QUEUE_LIMITS.gapMs * 10);
    await server.whenIdle();
    assert.equal(calls, 1);
    const row = await w.host.db.select().from(avatarSites).get();
    assert.equal(row?.state, "failed");
    assert.equal(row?.dueAt, w.clock.now() - QUEUE_LIMITS.gapMs * 10 + 10 * 60_000, "tried again after ten minutes");
    await server.stop();
    w.store.close();
  });

  test("nothing is fetched without a source", async () => {
    const w = await withDue(["a.example"]);
    const server = await serve(w, { suffixes: TEST_SUFFIXES, backfill: false });
    w.clock.advance(DAY);
    await server.whenIdle();
    assert.equal((await w.host.db.select().from(avatarSites).get())?.state, "queued");
    await server.stop();
    w.store.close();
  });
});
