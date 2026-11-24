// Sender pictures through the server (docs/contract-avatars.md): an organisation's own icon on its threads and
// messages only when the mailbox provider's checker proved the From domain, the sender is let in and the thread isn't
// screened; never for a forged From, a person, a mailbox provider's domain, a screened or blocked sender. Fetched once
// a domain is wanted, at a random moment within six hours, one at a time; looked at again only when new mail comes
// after 30 days; forgotten after 180 days without mail. A fake site source and a made-up suffix list; no network.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { MailEvent, Thread } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { avatarSites, threads } from "../src/db/index.ts";
import { brandMail, FakeSites, icon, TEST_SUFFIXES } from "./avatar-hosts.ts";
import { pngFile } from "./avatar-pictures.ts";
import { at, DAY, HOUR, listen, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
let sites: FakeSites;
afterEach(() => t?.close());

async function start(): Promise<void> {
  sites = new FakeSites();
  t = await makeServer({ avatars: { suffixes: TEST_SUFFIXES, backfill: false }, siteIcons: sites });
}

const site = (domain: string) => t.host.db.select().from(avatarSites).where(eq(avatarSites.domain, domain)).get();
const changedThreads = (events: MailEvent[]) => events.flatMap((e) => (e.type === "thread.changed" ? [e.thread] : []));
const PICTURE = /^\/v1\/avatars\/[0-9a-f]{32}$/;

describe("an organisation's picture", () => {
  test("shows for its let-in, proved mail once its site gave one, within six hours, with a higher version", async () => {
    await start();
    const { inbox } = await t.connect({ address: "me@inbox.example", history: [brandMail("Weekly news", { date: at(-DAY), seen: true })] });
    const before = await t.threadBySubject("Weekly news");
    assert.equal(before.avatar, undefined, "nothing until the site is fetched");
    const queued = await site("brand.example");
    assert.equal(queued?.state, "queued");
    assert.ok(queued!.dueAt! > t.clock.now() - 1 && queued!.dueAt! <= t.clock.now() + 6 * HOUR, "at a random moment within six hours");
    assert.deepEqual(sites.asked, [], "not when the mail arrives");

    sites.icons.set("brand.example", icon(64, "inset"));
    const heard = listen(t);
    await t.tick(6 * HOUR);
    assert.deepEqual(sites.asked, ["brand.example"], "its registrable domain, once");
    const after = await t.threadBySubject("Weekly news");
    assert.match(after.avatar?.picture ?? "", PICTURE);
    assert.deepEqual({ fit: after.avatar!.fit, size: after.avatar!.size }, { fit: "inset", size: 64 });
    assert.ok(after.version > before.version);
    assert.deepEqual(changedThreads(heard.events).at(-1)?.avatar, after.avatar);

    const id = after.avatar!.picture.split("/").at(-1)!;
    const picture = await t.server.fetchAvatar(t.person, id);
    assert.equal(picture.mimeType, "image/png");
    assert.deepEqual(picture.data, pngFile(64, 64));
    const detail = await t.server.thread(t.person, after.id);
    assert.deepEqual(detail.messages[0]!.avatar, after.avatar, "its message shows it too");

    const agent = await t.agent([inbox.id]);
    await assert.rejects(t.server.fetchAvatar(agent.caller, id), { code: "needs_person" });
    await assert.rejects(t.server.fetchAvatar(t.person, "0".repeat(32)), { code: "not_found" });
    await assert.rejects(t.server.fetchAvatar(t.person, "../etc"), { code: "not_found" });
  });

  test("a caller limited to some inboxes gets a picture only when it shows in one of them", async () => {
    await start();
    sites.icons.set("brand.example", icon());
    const { inbox } = await t.connect({ address: "me@inbox.example", history: [brandMail("Weekly news", { date: at(-DAY) })] });
    const other = await t.connect({ address: "me@other.example" });
    await t.tick(6 * HOUR);
    const id = (await t.threadBySubject("Weekly news")).avatar!.picture.split("/").at(-1)!;
    // No device that may load pictures is limited today (a person's sees every inbox; agents are refused), so the
    // limit is checked with a made-up one.
    const limitedTo = (ids: string[]) => ({ ...t.person, inboxIds: ids });
    assert.equal((await t.server.fetchAvatar(limitedTo([inbox.id]), id)).mimeType, "image/png");
    await assert.rejects(t.server.fetchAvatar(limitedTo([other.inbox.id]), id), { code: "not_found" });
    await assert.rejects(t.server.fetchAvatar(limitedTo([]), id), { code: "not_found" });
  });

  test("a message's picture counts for a limited caller too, though its thread's is another", async () => {
    await start();
    sites.icons.set("brand.example", icon());
    const { inbox } = await t.connect({ address: "me@inbox.example", history: [brandMail("Weekly news", { date: at(-2 * DAY) })] });
    const other = await t.connect({
      address: "me@other.example",
      history: [
        { from: { name: "Ada", email: "ada@people.example" }, subject: "Look at this", text: "Hi", date: at(-DAY), threadKey: "fw" },
        { ...brandMail("Re: Look at this"), date: at(-DAY + HOUR), threadKey: "fw" },
      ],
    });
    await t.tick(6 * HOUR);
    const id = (await t.threadBySubject("Weekly news")).avatar!.picture.split("/").at(-1)!;
    const detail = await t.server.thread(t.person, (await t.threadBySubject("Look at this")).id);
    assert.equal(detail.thread.avatar, undefined, "a person started it");
    assert.ok(detail.messages.some((m) => m.avatar?.picture.endsWith(id)), "the brand's message in it shows the picture");
    assert.equal((await t.server.fetchAvatar({ ...t.person, inboxIds: [other.inbox.id] }, id)).mimeType, "image/png");
    void inbox;
  });

  test("one fetch serves every sender and inbox at the brand", async () => {
    await start();
    sites.icons.set("brand.example", icon());
    await t.connect({ address: "me@inbox.example", history: [brandMail("One", { date: at(-DAY) })] });
    await t.connect({
      address: "me@other.example",
      history: [brandMail("Two", { date: at(-DAY), from: { email: "receipts@brand.example" }, fromCheck: { result: "verified", domain: "brand.example" } })],
    });
    await t.tick(6 * HOUR);
    assert.deepEqual(sites.asked, ["brand.example"]);
    assert.equal((await t.threadBySubject("One")).avatar?.picture, (await t.threadBySubject("Two")).avatar?.picture);
  });
});

describe("never a picture", () => {
  test("for a screened stranger: nothing is fetched until they are let in", async () => {
    await start();
    sites.icons.set("brand.example", icon());
    const { inbox } = await t.connect({ address: "me@inbox.example" });
    const thread = await t.receive(inbox, brandMail("Hello stranger"));
    assert.equal(thread.screened, true);
    await t.tick(DAY);
    assert.equal(await site("brand.example"), undefined, "no fetch, not even queued");
    assert.equal((await t.threadBySubject("Hello stranger")).avatar, undefined);
    assert.equal((await t.server.thread(t.person, thread.id)).messages[0]!.avatar, undefined);

    await t.server.act(t.person, { threadIds: [thread.id], action: { kind: "allow_sender" } });
    await t.tick(6 * HOUR);
    assert.deepEqual(sites.asked, ["brand.example"], "letting them in wants it");
    assert.match((await t.threadBySubject("Hello stranger")).avatar?.picture ?? "", PICTURE);
  });

  test("for a blocked sender: it goes, with a higher version", async () => {
    await start();
    sites.icons.set("brand.example", icon());
    await t.connect({ address: "me@inbox.example", history: [brandMail("Weekly news", { date: at(-DAY) })] });
    await t.tick(6 * HOUR);
    const shown = await t.threadBySubject("Weekly news");
    assert.ok(shown.avatar);
    const heard = listen(t);
    await t.server.act(t.person, { threadIds: [shown.id], action: { kind: "block_sender" } });
    await t.server.whenIdle();
    const now = await t.threadBySubject("Weekly news");
    assert.equal(now.avatar, undefined);
    assert.ok(now.version > shown.version);
    assert.equal(changedThreads(heard.events).filter((thread) => thread.id === shown.id).at(-1)?.avatar, undefined);
    assert.equal((await t.server.thread(t.person, shown.id)).messages[0]!.avatar, undefined);
  });

  test("for a forged From: the same let-in address, its domain not proved", async () => {
    await start();
    sites.icons.set("brand.example", icon());
    const { inbox } = await t.connect({ address: "me@inbox.example", history: [brandMail("Weekly news", { date: at(-DAY) })] });
    await t.tick(6 * HOUR);
    assert.ok((await t.threadBySubject("Weekly news")).avatar, "the real one shows it");
    for (const [subject, fromCheck] of [["Forged fail", { result: "unverified" }], ["Forged none", { result: "no_header" }], ["Forged other", { result: "other_checker" }]] as const) {
      const forged = await t.receive(inbox, brandMail(subject, { fromCheck }));
      assert.equal(forged.avatar, undefined, subject);
      assert.equal((await t.server.thread(t.person, forged.id)).messages[0]!.avatar, undefined, subject);
    }
    const noCheck = await t.receive(inbox, brandMail("Never asked", { fromCheck: undefined }));
    assert.equal(noCheck.avatar, undefined);
    // A proved domain that isn't the address's own counts for nothing either.
    const other = await t.receive(inbox, brandMail("Other domain", { fromCheck: { result: "verified", domain: "evil.example" } }));
    assert.equal(other.avatar, undefined);
    assert.equal(await site("evil.example"), undefined, "nor wanted");
  });

  test("for a person, or a mailbox provider's domain, and neither is fetched", async () => {
    await start();
    await t.connect({
      address: "me@inbox.example",
      history: [
        brandMail("From a person", { from: { name: "Ada", email: "ada@brand.example" }, automated: false, listId: undefined, fromCheck: { result: "verified", domain: "brand.example" }, date: at(-DAY) }),
        brandMail("Newsletter from a webmail address", { from: { email: "club@yahoo.example" }, fromCheck: { result: "verified", domain: "yahoo.example" }, date: at(-DAY) }),
        brandMail("From Gmail", { from: { email: "club@gmail.com" }, fromCheck: { result: "verified", domain: "gmail.com" }, date: at(-DAY) }),
      ],
    });
    await t.tick(7 * HOUR);
    assert.deepEqual(sites.asked, []);
    assert.deepEqual(await t.host.db.select().from(avatarSites), []);
  });

  test("on the inbox's own mail", async () => {
    await start();
    sites.icons.set("brand.example", icon());
    const { inbox } = await t.connect({ address: "me@inbox.example", history: [brandMail("Weekly news", { date: at(-DAY) })] });
    await t.tick(6 * HOUR);
    const thread = await t.threadBySubject("Weekly news");
    const mailbox = t.mailboxes.get(inbox.address)!;
    mailbox.deliver({ ...brandMail("Re: Weekly news"), threadKey: (mailbox.messages()[0]!).threadKey, from: { email: inbox.address }, outgoing: true, fromCheck: { result: "verified", domain: "inbox.example" } });
    await t.sync(inbox);
    const detail = await t.server.thread(t.person, thread.id);
    assert.ok(detail.messages.some((m) => m.outgoing && m.avatar === undefined));
    // Mail the inbox sent from a let-in brand address (an alias, say), proved: still the inbox's own.
    mailbox.deliver({ ...brandMail("Sent as the brand"), threadKey: (mailbox.messages()[0]!).threadKey, outgoing: true });
    await t.sync(inbox);
    const again = await t.server.thread(t.person, thread.id);
    const sent = again.messages.filter((m) => m.outgoing);
    assert.ok(sent.length >= 2 && sent.every((m) => m.avatar === undefined));
    assert.ok(again.messages.some((m) => !m.outgoing && m.avatar), "the brand's own message still shows it");
  });

  test("for a stranger a rule sorts, though not screened: nothing is wanted", async () => {
    await start();
    sites.icons.set("brand.example", icon());
    const { inbox } = await t.connect({ address: "me@inbox.example" });
    await t.server.createRule(t.person, { inboxId: inbox.id, text: "Brand's news", match: { domain: "mail.brand.example" }, then: [{ kind: "categorize", category: "newsletter" }] });
    const thread = await t.receive(inbox, brandMail("Ruled news"));
    assert.equal(thread.screened, false);
    await t.tick(7 * HOUR);
    assert.equal(await site("brand.example"), undefined);
    assert.equal((await t.threadBySubject("Ruled news")).avatar, undefined);
  });

  test("for a let-in sender's thread the mailbox filed under Screening: none kept, though the brand's other thread shows it", async () => {
    await start();
    sites.icons.set("brand.example", icon());
    await t.connect({
      address: "me@inbox.example",
      history: [brandMail("Weekly news", { date: at(-2 * DAY) }), brandMail("Filed under Screening", { date: at(-DAY), placement: { screened: true } })],
    });
    await t.tick(6 * HOUR);
    assert.ok((await t.threadBySubject("Weekly news")).avatar);
    const filed = await t.threadBySubject("Filed under Screening");
    assert.equal(filed.screened, true);
    const row = await t.host.db.select({ avatar: threads.avatar }).from(threads).where(eq(threads.id, filed.id)).get();
    assert.equal(row?.avatar, null, "not even kept on the row");
    const messages = (await t.server.thread(t.person, filed.id)).messages;
    assert.ok(messages.length > 0 && messages.every((m) => m.avatar === undefined), "nor on its messages");
  });

  test("without the Public Suffix List: nothing is fetched or shown, and providers aren't asked", async () => {
    sites = new FakeSites();
    t = await makeServer({ avatars: { suffixes: null }, siteIcons: sites });
    sites.icons.set("brand.example", icon());
    await t.connect({ address: "me@inbox.example", history: [brandMail("Weekly news", { date: at(-DAY) })] });
    await t.tick(7 * HOUR);
    assert.deepEqual(sites.asked, []);
    assert.equal((await t.threadBySubject("Weekly news")).avatar, undefined);
  });
});

describe("when a site is looked at again", () => {
  test("only when new mail comes and the last look is more than 30 days old; a new picture gets a new id", async () => {
    await start();
    sites.icons.set("brand.example", icon(64));
    const { inbox } = await t.connect({ address: "me@inbox.example", history: [brandMail("Weekly news", { date: at(-DAY) })] });
    await t.tick(6 * HOUR);
    const first = (await t.threadBySubject("Weekly news")).avatar!;
    await t.receive(inbox, brandMail("Mail within 30 days"));
    await t.tick(7 * HOUR);
    assert.equal(sites.asked.length, 1, "not looked at again within 30 days");
    await t.tick(31 * DAY);
    assert.equal(sites.asked.length, 1, "never on a timer of its own");
    const weekly = await t.threadBySubject("Weekly news");
    await t.server.act(t.person, { threadIds: [weekly.id], action: { kind: "block_sender" } });
    await t.server.act(t.person, { threadIds: [weekly.id], action: { kind: "allow_sender" } });
    await t.tick(7 * HOUR);
    assert.equal(sites.asked.length, 1, "nor when a sender is let in again: only new mail looks again");
    sites.icons.set("brand.example", icon(128, "fill"));
    await t.receive(inbox, brandMail("Mail after 30 days"));
    await t.tick(6 * HOUR);
    assert.equal(sites.asked.length, 2);
    const second = (await t.threadBySubject("Weekly news")).avatar!;
    assert.notEqual(second.picture, first.picture);
    assert.deepEqual({ fit: second.fit, size: second.size }, { fit: "fill", size: 128 });
    await assert.rejects(t.server.fetchAvatar(t.person, first.picture.split("/").at(-1)!), { code: "not_found" }, "the old one is gone");
  });

  test("a look again that fails keeps the picture", async () => {
    await start();
    sites.icons.set("brand.example", icon());
    const { inbox } = await t.connect({ address: "me@inbox.example", history: [brandMail("Weekly news", { date: at(-DAY) })] });
    await t.tick(6 * HOUR);
    const shown = (await t.threadBySubject("Weekly news")).avatar;
    assert.ok(shown);
    await t.tick(31 * DAY);
    sites.icons.set("brand.example", { found: false, kind: "failed", reason: "its site couldn't be reached" });
    await t.receive(inbox, brandMail("After 30 days"));
    await t.tick(6 * HOUR);
    assert.equal(sites.asked.length, 2);
    assert.deepEqual((await t.threadBySubject("Weekly news")).avatar, shown);
    const picture = await t.server.fetchAvatar(t.person, shown.picture.split("/").at(-1)!);
    assert.equal(picture.mimeType, "image/png", "and still serves it");
  });

  test("a site that fails is tried after ten minutes and a day, then left until new mail after 30 days", async () => {
    await start();
    sites.icons.set("brand.example", { found: false, kind: "failed", reason: "its site couldn't be reached" });
    const { inbox } = await t.connect({ address: "me@inbox.example", history: [brandMail("Weekly news", { date: at(-DAY) })] });
    await t.tick(6 * HOUR);
    assert.equal(sites.asked.length, 1);
    await t.tick(10 * 60_000);
    assert.equal(sites.asked.length, 2);
    await t.tick(DAY);
    assert.equal(sites.asked.length, 3);
    await t.tick(10 * DAY);
    assert.equal(sites.asked.length, 3, "a third failure is final");
    await t.receive(inbox, brandMail("Within 30 days"));
    await t.tick(7 * HOUR);
    assert.equal(sites.asked.length, 3);
    await t.tick(21 * DAY);
    sites.icons.set("brand.example", icon());
    await t.receive(inbox, brandMail("After 30 days"));
    await t.tick(6 * HOUR);
    assert.equal(sites.asked.length, 4);
    assert.ok((await t.threadBySubject("Weekly news")).avatar);
  });

  test("a site with no icon is remembered, not asked on every view or mail", async () => {
    await start();
    const { inbox } = await t.connect({ address: "me@inbox.example", history: [brandMail("Weekly news", { date: at(-DAY) })] });
    await t.tick(6 * HOUR);
    await t.receive(inbox, brandMail("More"));
    await t.server.thread(t.person, (await t.threadBySubject("More")).id);
    await t.tick(7 * HOUR);
    assert.deepEqual(sites.asked, ["brand.example"]);
    assert.equal((await site("brand.example"))?.state, "none");
  });

  test("a domain no mail wants for 180 days is forgotten, its picture with it", async () => {
    await start();
    sites.icons.set("brand.example", icon());
    await t.connect({ address: "me@inbox.example", history: [brandMail("Weekly news", { date: at(-DAY) })] });
    await t.tick(6 * HOUR);
    const shown = await t.threadBySubject("Weekly news");
    assert.ok(shown.avatar);
    for (let day = 0; day < 181; day += 10) await t.tick(10 * DAY);
    const now: Thread = await t.threadBySubject("Weekly news");
    assert.equal(now.avatar, undefined);
    assert.ok(now.version > shown.version);
    assert.equal(await site("brand.example"), undefined);
  });
});
