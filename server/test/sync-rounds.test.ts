// A sync takes at most so many batches (`ServiceOptions.syncRounds`, 10,000), then hands over to the next. A first sync
// longer than that (250,000 messages in batches of 25 on Cloudflare) is done only once the provider has sent all of it:
// until then the next sync is queued at once, and every message of it stays history, never screened as new mail. The
// next sync is queued after the write-backs held while the inbox was paused and the repair, so they don't wait for it.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { MailProvider, ProviderOp } from "@usualmail/core";
import { sql } from "drizzle-orm";
import { at, HOUR, KNOWN, makeServer } from "./helpers.ts";

test("a first sync longer than one sync's rounds goes on at once in the next, and all of it stays history", async () => {
  const t = await makeServer({ limits: { syncBatch: 2 }, syncRounds: 3 });
  try {
    const history = Array.from({ length: 15 }, (_, i) => ({ from: { email: `p${i}@people.example` }, subject: `Old ${i}`, text: `Note ${i}.`, date: at(-(20 - i) * HOUR) }));
    const { inbox } = await t.connect({ address: "me@rounds.example", history });
    const count = async (query: string) => (await t.host.db.all<{ n: number }>(sql.raw(query)))[0]!.n;
    assert.equal(await count("SELECT count(*) AS n FROM messages"), 15, "the whole first sync, over three syncs of three batches");
    assert.equal(await count("SELECT history_done AS n FROM inboxes"), 1);
    for (let i = 0; i < 3; i++) await t.sync(inbox);
    assert.equal(await count("SELECT count(*) AS n FROM messages"), 15);
    assert.equal(await count("SELECT count(*) AS n FROM threads WHERE screened = 1"), 0, "no first-sync mail is screened as new");
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test("a first sync that fits one sync's rounds is done after it, as before", async () => {
  const t = await makeServer({ limits: { syncBatch: 5 }, syncRounds: 3 });
  try {
    const history = Array.from({ length: 15 }, (_, i) => ({ from: { email: `p${i}@people.example` }, subject: `Old ${i}`, text: `Note ${i}.`, date: at(-(20 - i) * HOUR) }));
    await t.connect({ address: "me@rounds.example", history });
    const [{ messages, done }] = (await t.host.db.all<{ messages: number; done: number }>(sql`SELECT (SELECT count(*) FROM messages) AS messages, history_done AS done FROM inboxes`)) as [{ messages: number; done: number }];
    assert.deepEqual({ messages, done }, { messages: 15, done: 1 });
  } finally {
    await t.close();
  }
});

test("when a sync's rounds run out, the write-backs held while paused go out before the next sync, not after it", async () => {
  const t = await makeServer({ limits: { syncBatch: 2 }, syncRounds: 1 });
  try {
    // What reaches the provider, in order: each sync, and each write-back's ops.
    const calls: Array<{ kind: "sync" } | { kind: "apply"; ops: ProviderOp[] }> = [];
    for (const kind of ["imap", "gmail"] as const) {
      const factory = t.providers.get(kind)!;
      t.providers.register(kind, (credentials, options) => {
        const provider = factory(credentials, options) as MailProvider;
        const sync = provider.sync.bind(provider);
        const apply = provider.apply.bind(provider);
        provider.sync = (cursor, syncOptions) => (calls.push({ kind: "sync" }), sync(cursor, syncOptions));
        provider.apply = (ops) => (calls.push({ kind: "apply", ops }), apply(ops));
        return provider;
      });
    }
    const { inbox, mailbox } = await t.connect({ address: "me@rounds.example", history: [{ from: KNOWN, subject: "Earlier", text: "Before.", date: at(-30 * HOUR) }] });
    const earlier = await t.threadBySubject("Earlier");
    const ref = mailbox.messages().find((m) => m.subject === "Earlier")!.ref;
    // Paused, the person reads the thread: the write-back is held. Meanwhile six messages arrive: three syncs of one round.
    await t.server.updateInbox(t.person, inbox.id, { paused: true });
    await t.server.act(t.person, { threadIds: [earlier.id], action: { kind: "read" } });
    await t.server.whenIdle();
    for (let i = 0; i < 6; i++) mailbox.deliver({ from: KNOWN, subject: `New ${i}`, text: `New ${i}.`, date: at(-(10 - i) * HOUR) });
    calls.length = 0;
    await t.server.updateInbox(t.person, inbox.id, { paused: false });
    await t.server.whenIdle();
    const held = calls.findIndex((call) => call.kind === "apply" && call.ops.some((op) => op.op === "seen" && op.ref === ref && op.seen));
    const syncs = calls.map((call, i) => (call.kind === "sync" ? i : -1)).filter((i) => i >= 0);
    assert.ok(held >= 0, "the held read went out");
    assert.ok(syncs.length >= 3, `${syncs.length} syncs`);
    assert.ok(held < syncs[1]!, `the held read went out after the first sync and before the second: ${calls.map((call) => call.kind).join(", ")}`);
    assert.equal((await t.host.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM messages`))[0]!.n, 7);
  } finally {
    await t.close();
  }
});
