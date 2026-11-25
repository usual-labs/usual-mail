// The watch on syncs that stop finishing (sync/watch.ts), after the server review of 0.1.2: a slow batch's warning
// ends when batches come again, a hang that ends in a failure goes straight to provider_error, the watch reads again
// under the store's lock before it says anything, and write-backs count as signs of life.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { Inbox, MailEvent, MailProvider } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { inboxes } from "../src/db/index.ts";
import { Ctx } from "../src/service/context.ts";
import { markNotSyncing } from "../src/sync/status.ts";
import { history, slow } from "./first-sync-helpers.ts";
import { listen, makeServer, type TestServer } from "./helpers.ts";

const MINUTE = 60_000;
let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** inbox.changed events: status and reason. */
const changes = (events: MailEvent[]) =>
  events.flatMap((e) => (e.type === "inbox.changed" ? [[e.inbox.status, e.inbox.statusReason ?? null]] : []));
const listed = async (s: TestServer): Promise<Inbox> => (await s.server.listInboxes(s.person))[0]!;
/** Lets queued work run without waiting for idle, which a held sync never reaches. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};
/** Time passing a minute at a time, the server's own work running between. */
const minutes = async (s: TestServer, n: number) => {
  for (let i = 0; i < n; i++) {
    s.clock.advance(MINUTE);
    await settle();
  }
};

describe("a sync that stops finishing, then goes on", () => {
  test("a first sync's batch that takes twenty minutes is said, and the next batch stored ends it", async () => {
    t = await makeServer({ limits: { syncBatch: 2 } });
    const s = t;
    slow(s, async (call, options) => {
      // Only the first sync's batches are slow; the third alone takes twenty minutes and says nothing meanwhile.
      if (!options?.onProgress) return;
      await minutes(s, call === 3 ? 20 : 1);
    });
    const heard = listen(s);
    await s.connect({ address: "me@slow.example", history: history(10) });
    heard.stop();
    const said = changes(heard.events);
    const silent = said.findIndex(([, reason]) => reason === "not_syncing");
    assert.ok(silent >= 0, "the long batch was said");
    // The batch after it ended the warning, while the first sync still ran (`connecting`, not yet a good sync).
    assert.deepEqual(said[silent + 1], ["connecting", null]);
    assert.deepEqual(said.at(-1), ["ok", null]);
    assert.equal((await listed(s)).statusReason, undefined);
  });

  test("a hang that ends in a failure goes straight to provider_error, never back to ok between", async () => {
    t = await makeServer();
    const s = t;
    let hold = false;
    let release = () => {};
    slow(s, async () => {
      if (hold) await new Promise<void>((resolve) => (release = resolve));
    });
    const { mailbox } = await s.connect({ address: "me@acme.example" });
    const heard = listen(s);
    hold = true;
    await minutes(s, 22);
    assert.equal((await listed(s)).statusReason, "not_syncing");
    mailbox.failSync = "Connection reset";
    hold = false;
    release();
    await s.server.whenIdle();
    heard.stop();
    assert.deepEqual(changes(heard.events), [["needs_attention", "not_syncing"], ["needs_attention", "provider_error"]]);
    assert.equal((await listed(s)).statusDetail, "Connection reset");
  });
});

describe("what the watch says, and when", () => {
  test("it reads again under the store's lock: nothing for an inbox that has shown life, is paused or needs more", async () => {
    t = await makeServer();
    const s = t;
    const { inbox } = await s.connect({ address: "me@acme.example" });
    const ctx = new Ctx(s.host, s.providers, s.models, {});
    const said: string[] = [];
    const watch = (silent: boolean) => ({ afterMs: 15 * MINUTE, isSilent: () => silent, said: (id: string) => said.push(id) });
    // A sync finished, or a reconnect opened it again, since the watch looked: no longer silent.
    await markNotSyncing(ctx, [inbox.id], watch(false));
    assert.deepEqual([(await listed(s)).status, said], ["ok", []]);
    // A refused sign-in says more than "not syncing": it stays.
    await s.host.db.update(inboxes).set({ status: "needs_attention", statusReason: "needs_sign_in", statusDetail: "Refused." })
      .where(eq(inboxes.id, inbox.id));
    await markNotSyncing(ctx, [inbox.id], watch(true));
    assert.deepEqual([(await listed(s)).statusReason, said], ["needs_sign_in", []]);
    // Silent still, and fine otherwise: said, and the watch told so its next sign of life ends it.
    await s.host.db.update(inboxes).set({ status: "ok", statusReason: null, statusDetail: null }).where(eq(inboxes.id, inbox.id));
    await markNotSyncing(ctx, [inbox.id], watch(true));
    assert.deepEqual([(await listed(s)).statusReason, said], ["not_syncing", [inbox.id]]);
  });

  test("write-backs count as signs of life: a long backlog ahead of the next sync isn't a sync that stopped", async () => {
    const SUBJECTS = ["One", "Two", "Three", "Four", "Five", "Six"];
    t = await makeServer();
    const s = t;
    let slowApply = false;
    for (const kind of ["imap", "gmail"] as const) {
      const factory = s.providers.get(kind)!;
      s.providers.register(kind, (credentials, options) => {
        const provider = factory(credentials, options) as MailProvider;
        const apply = provider.apply.bind(provider);
        provider.apply = async (ops) => {
          // Each write-back takes six minutes; after the first (and a poll's sync behind it), five hold the queue for 30.
          if (slowApply) await minutes(s, 6);
          return apply(ops);
        };
        return provider;
      });
    }
    await s.connect({
      address: "me@acme.example",
      history: SUBJECTS.map((subject, i) => ({ from: { email: `p${i}@people.example` }, subject, text: "Hi." })),
    });
    const heard = listen(s);
    slowApply = true;
    for (const subject of SUBJECTS) {
      await s.server.act(s.person, { threadIds: [(await s.threadBySubject(subject)).id], action: { kind: "done" } });
    }
    await s.server.whenIdle();
    heard.stop();
    assert.ok(!changes(heard.events).some(([, reason]) => reason === "not_syncing"), "nothing said it stopped syncing");
    assert.equal((await listed(s)).status, "ok");
  });
});
