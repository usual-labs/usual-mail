// Sender pictures over more than 100 senders, domains, messages and inboxes, with no statement over 100 parameters
// (test/parameters.ts fails any): 150 senders let in at once, a thread with mail from 120 organisations, a caller limited
// to 111 inboxes, and Gmail asked again about 150 stored threads. Made-up domains, a fake site source, no network.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { isNull } from "drizzle-orm";
import { messages } from "../src/db/index.ts";
import type { DeliverInput } from "../src/testing/index.ts";
import { brandMail, connect, FakeSites, icon, personOf, serve, TEST_SUFFIXES, world } from "./avatar-hosts.ts";
import { at, DAY, HOUR, makeServer, START, type TestServer } from "./helpers.ts";
import { listScans } from "./list-plans.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** Organisation `i`'s mail, its From domain proved by Gmail's checker. */
const orgMail = (i: number, subject: string, extra: Partial<DeliverInput> = {}): DeliverInput => brandMail(subject, {
  from: { name: `Org ${i}`, email: `news@mail.org${i}.example` },
  listId: `<weekly.org${i}.example>`,
  fromCheck: { result: "verified", domain: `mail.org${i}.example` },
  ...extra,
});
const PICTURE = /^\/v1\/avatars\/[0-9a-f]{32}$/;

async function start(domains: number): Promise<{ t: TestServer; sites: FakeSites }> {
  const sites = new FakeSites();
  for (let i = 0; i < domains; i++) sites.icons.set(`org${i}.example`, icon());
  t = await makeServer({ avatars: { suffixes: TEST_SUFFIXES, backfill: false, queue: { gapMs: 0 } }, siteIcons: sites });
  return { t, sites };
}

describe("sender pictures for more than 100 at once", () => {
  test("150 screened organisations let in by one draft: each wanted and each thread shows its picture", async () => {
    const { t, sites } = await start(150);
    const { inbox, mailbox } = await t.connect({ address: "me@inbox.example" });
    for (let i = 0; i < 150; i++) mailbox.deliver(orgMail(i, `News ${i}`));
    await t.sync(inbox);
    assert.equal((await t.server.screening(t.person, { limit: 200 })).items.length, 150);
    const draft = await t.server.saveDraft(t.person, {
      inboxId: inbox.id,
      to: Array.from({ length: 100 }, (_, i) => ({ email: `news@mail.org${i}.example` })),
      cc: Array.from({ length: 50 }, (_, i) => ({ email: `news@mail.org${100 + i}.example` })),
      subject: "Subscribed", body: "Thanks.",
    });
    await t.server.sendDraft(t.person, draft.id);
    await t.tick(6 * HOUR);
    assert.equal(new Set(sites.asked).size, 150, "every domain wanted once its sender was let in");
    const home = await t.server.home(t.person, { limit: 200 });
    assert.equal(home.items.length, 150);
    assert.ok(home.items.every((thread) => PICTURE.test(thread.avatar?.picture ?? "")));
    assert.equal(new Set(home.items.map((thread) => thread.avatar!.picture)).size, 150, "each its own organisation's");
  });

  test("a thread with mail from 120 organisations shows each message's own picture, and a caller limited to 111 inboxes", async () => {
    const { t } = await start(120);
    // Each organisation's own newsletter wants its picture; the digest carries mail from all of them.
    const history = Array.from({ length: 120 }, (_, i) => orgMail(i, `Weekly ${i}`, { date: at(-2 * DAY) }));
    history.push(...Array.from({ length: 120 }, (_, i) => orgMail(i, "Joint digest", { threadKey: "digest", date: at(-DAY + i * 60_000) })));
    const { inbox } = await t.connect({ address: "me@inbox.example", history });
    await t.tick(6 * HOUR);
    const digest = await t.threadBySubject("Joint digest");
    const detail = await t.server.thread(t.person, digest.id);
    assert.equal(detail.messages.length, 120);
    assert.ok(detail.messages.every((m) => PICTURE.test(m.avatar?.picture ?? "")), "every message its sender's picture");
    assert.equal(new Set(detail.messages.map((m) => m.avatar!.picture)).size, 120);

    const others: string[] = [];
    for (let i = 0; i < 110; i++) others.push((await t.connect({ address: `me${i}@many.example` })).inbox.id);
    const id = detail.messages[0]!.avatar!.picture.split("/").at(-1)!;
    // No device that may load pictures is limited today, so the limit is checked with a made-up one.
    const limitedTo = (ids: string[]) => ({ ...t.person, inboxIds: ids });
    assert.equal((await t.server.fetchAvatar(limitedTo([...others, inbox.id]), id)).mimeType, "image/png");
    await assert.rejects(t.server.fetchAvatar(limitedTo(others), id), { code: "not_found" });
  });

  test("Gmail is asked again about 150 stored threads at a start", async () => {
    const w = await world();
    const before = await serve(w, { suffixes: null }, 365);
    const { person } = await personOf(before);
    const { mailbox, inbox } = await connect(before, person, w, "me@inbox.example", "gmail");
    for (let i = 0; i < 150; i++) mailbox.deliver(orgMail(i, `News ${i}`, { date: new Date(Date.parse(START) - DAY + i * 60_000).toISOString() }));
    await before.syncInbox(person, inbox.id);
    await before.whenIdle();
    await before.stop();
    assert.equal((await w.host.db.select({ id: messages.id }).from(messages).where(isNull(messages.fromCheck))).length, 150, "stored unchecked");

    const after = await serve(w, { suffixes: TEST_SUFFIXES });
    try {
      await after.whenIdle();
      assert.equal(mailbox.fromCheckReads.length, 3, "in chunks of 50");
      assert.ok(w.infos.includes("Sender pictures: asked the mailbox provider again about 150 stored messages: 150 proved, 0 with its own result on top proving nothing, 0 with its own result more than once, 0 with another checker's result on top, 0 with no result at all, 0 no longer there."));
      assert.deepEqual(await w.host.db.select({ id: messages.id }).from(messages).where(isNull(messages.fromCheck)), []);
    } finally {
      await after.stop();
      w.store.close();
    }
  });
});

describe("query plans", () => {
  test("every list this file bound as JSON is read through an index, never a scan", async (t) => {
    const { statements, scans } = await listScans();
    if (statements === 0) return t.skip("no list was bound: the tests above didn't run");
    assert.deepEqual(scans, []);
  });
});
