// Mail stored before the server asked Gmail's checker has no proof of its From domain. At each start the server asks
// Gmail again, in the background, only for what matters (each live thread from the last 90 days: its sender's oldest
// and newest message), keeps the answers, settles the threads, and logs the outcomes as counts only: no address, no
// domain. The route serves a kept picture to a person's device only. Made-up domains, memory mailboxes, no network.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { asc, eq } from "drizzle-orm";
import { messages } from "../src/db/index.ts";
import { createApp } from "../src/rest/app.ts";
import { brandMail, connect, FakeSites, icon, personOf, serve, TEST_SUFFIXES, world } from "./avatar-hosts.ts";
import { pngFile } from "./avatar-pictures.ts";
import { DAY, HOUR, START } from "./helpers.ts";

const ago = (ms: number) => new Date(Date.parse(START) - ms).toISOString();

describe("asking Gmail again about stored mail", () => {
  test("asks only for what matters, keeps the answers, shows the pictures and logs counts only", async () => {
    const w = await world();
    const sites = new FakeSites();
    sites.icons.set("brand.example", icon());
    // A server without the list: mail is stored without its checker's word.
    const before = await serve(w, { suffixes: null }, 365);
    const { person, token } = await personOf(before);
    const { mailbox, inbox } = await connect(before, person, w, "me@inbox.example", "gmail");
    mailbox.deliver(brandMail("Weekly news", { date: ago(2 * DAY), threadKey: "weekly" }));
    mailbox.deliver(brandMail("Weekly news", { date: ago(1 * DAY), threadKey: "weekly" }));
    mailbox.deliver(brandMail("Weekly news", { date: ago(HOUR), threadKey: "weekly" }));
    mailbox.deliver(brandMail("Forged", { fromCheck: { result: "unverified" }, date: ago(DAY) }));
    mailbox.deliver(brandMail("No header", { fromCheck: undefined, date: ago(DAY) }));
    mailbox.deliver(brandMail("Forwarded", { fromCheck: { result: "repeated" }, date: ago(DAY) }));
    mailbox.deliver(brandMail("Old", { date: ago(100 * DAY) }));
    const imap = await connect(before, person, w, "me@imap.example", "imap");
    imap.mailbox.deliver(brandMail("Over IMAP", { date: ago(DAY) }));
    await before.syncInbox(person, inbox.id);
    await before.syncInbox(person, imap.inbox.id);
    await before.whenIdle();
    const unchecked = await w.host.db.select({ fromCheck: messages.fromCheck }).from(messages);
    assert.ok(unchecked.every((row) => row.fromCheck === null));
    await before.stop();

    // The next start carries the list: it asks again.
    w.host.siteIcons = sites;
    const after = await serve(w, { suffixes: TEST_SUFFIXES });
    await after.whenIdle();
    assert.equal(mailbox.fromCheckReads.length, 1, "one chunk");
    const asked = mailbox.fromCheckReads[0]!;
    assert.equal(asked.length, 5, "the oldest and newest of the weekly thread, the forged, forwarded and headerless ones; not the old one, not IMAP");
    const line = w.infos.find((m) => m.startsWith("Sender pictures: asked"));
    assert.equal(line, "Sender pictures: asked the mailbox provider again about 5 stored messages: 2 proved, 1 with its own result on top proving nothing, 1 with its own result more than once, 0 with another checker's result on top, 1 with no result at all, 0 no longer there.");
    assert.doesNotMatch(line!, /@|brand|example/, "no address or domain in the log");
    const weekly = await w.host.db.select({ fromCheck: messages.fromCheck, fromVerified: messages.fromVerified }).from(messages)
      .where(eq(messages.subject, "Weekly news")).orderBy(asc(messages.date));
    assert.deepEqual(weekly.map((row) => row.fromCheck), ["verified", null, "verified"], "the middle one isn't asked");
    assert.equal(weekly[0]!.fromVerified, "mail.brand.example");

    w.clock.advance(6 * HOUR);
    await after.whenIdle();
    const me = (await after.authenticate(token))!;
    const page = await after.search(me, { q: "Weekly news", limit: 10 });
    const avatar = page.items[0]!.avatar!;
    assert.ok(avatar, "the proved thread shows its picture");
    assert.equal((await after.search(me, { q: "Forged", limit: 10 })).items[0]!.avatar, undefined);

    // The next start asks nothing again: everything that matters has an answer.
    await after.stop();
    const again = await serve(w, { suffixes: TEST_SUFFIXES });
    await again.whenIdle();
    assert.equal(mailbox.fromCheckReads.length, 1);
    await again.stop();
    w.store.close();
  });
});

describe("the picture route", () => {
  test("serves a kept picture to a person's device, cacheable for good; an agent is refused, an unknown id not found", async () => {
    const w = await world();
    const sites = new FakeSites();
    sites.icons.set("brand.example", icon(64));
    w.host.siteIcons = sites;
    const server = await serve(w, { suffixes: TEST_SUFFIXES, backfill: false });
    const { person, token } = await personOf(server);
    const { mailbox, inbox } = await connect(server, person, w, "me@inbox.example", "gmail");
    mailbox.deliver(brandMail("Weekly news", { date: ago(DAY) }));
    await server.syncInbox(person, inbox.id);
    await server.whenIdle();
    w.clock.advance(6 * HOUR);
    await server.whenIdle();
    const avatar = (await server.search(person, { q: "Weekly", limit: 5 })).items[0]!.avatar!;
    const app = createApp(server, { scheduler: w.clock, log: w.host.log, keepAliveMs: 25_000 });
    const get = (path: string, bearer: string) => app.fetch(new Request(`http://server.example${path}`, { headers: { authorization: `Bearer ${bearer}` } }));
    const ok = await get(avatar.picture, token);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal(ok.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.match(ok.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), pngFile(64, 64));
    const code = await server.createPairingCode(person, { kind: "agent", inboxIds: [inbox.id] });
    const agent = await server.pair({ code: code.code, name: "Agent" });
    assert.equal((await get(avatar.picture, agent.token)).status, 403);
    assert.equal((await get(`/v1/avatars/${"a".repeat(32)}`, token)).status, 404);
    assert.equal((await get("/v1/avatars/nope", token)).status, 404);
    await server.stop();
    w.store.close();
  });
});
