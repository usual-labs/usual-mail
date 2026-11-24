// End to end with IMAP: mail a server-side rule filed outside the inbox keeps its filing (a category's folder is that
// category, the Screening folder screens it, archived is done), mail in Junk is ignored, a paused inbox writes
// nothing until it is resumed, and a refused move leaves a later action's change alone. The real server and IMAP
// provider against an IMAP server in this process, through REST only; the mailbox is read with another mail app.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { parts } from "../src/node/parts.ts";
import { rawMail, startMailHost, type MailHost } from "./e2e/imap-server.ts";
import { startWorld, type Json, type World } from "./e2e/world.ts";

let host: MailHost;
let w: World;
beforeEach(async () => {
  host = await startMailHost();
  w = await startWorld({ imap: parts.providers.imap! });
});
afterEach(async () => {
  await w.close();
  await host.close();
  assert.deepEqual(w.errors.filter((line) => !line.includes("Watching")), [], "nothing went wrong in the background");
});

const DANA = "Dana Whitfield <dana@lumen.example>";
let next = 0;
const id = (name: string) => `${name}-${++next}@e2e.example`;
const folderOf = async (subject: string) => (await host.folders()).filter((m) => m.subject === subject).map((m) => m.folder);
const act = (threadId: string, action: Json) => w.ok("POST", "/v1/actions", { body: { threadIds: [threadId], action } });

async function connect(): Promise<Json> {
  host.append("INBOX", rawMail({ from: DANA, subject: "Earlier conversation", messageId: id("earlier") }), ["\\Seen"]);
  const inbox = await w.ok("POST", "/v1/inboxes", { body: { name: "Mail Example", color: "#2F6FED", provider: "imap", credentials: host.credentials(), trust: "act_with_undo" } });
  await w.idle();
  return inbox;
}

describe("IMAP end to end: mail filed outside the inbox", () => {
  test("keeps the filing a server-side rule gave it, with no rules or screening by the gate; mail in Junk is ignored", async () => {
    const inbox = await connect();
    const rule = await w.ok("POST", `/v1/inboxes/${inbox.id}/rules`, {
      body: { text: "Shop mail goes to Receipts", match: { domain: "shop.example" }, then: [{ kind: "categorize", category: "receipt" }] },
    });
    // Folders a person's server-side rules file into: the archive, a category's folder and Screening's, already there.
    await host.otherApp(async (client) => {
      await client.mailboxCreate(["Usual Mail", "Newsletters"]);
      await client.mailboxCreate(["Usual Mail", "Screening"]);
    });
    host.append("Archive", rawMail({ from: "Shop <billing@shop.example>", subject: "Archived by a filter", messageId: id("archived") }));
    host.append("Usual Mail/Newsletters", rawMail({ from: "Tomas <tomas@brightfield.example>", subject: "Filed to Newsletters", messageId: id("news") }));
    host.append("Usual Mail/Screening", rawMail({ from: "Quillpad <no-reply@quillpad.example>", subject: "Filed to Screening", messageId: id("screen") }));
    host.append("Junk", rawMail({ from: "Prize <win@prize.example>", subject: "You won", messageId: id("spam") }));
    await w.sync(inbox.id);

    const archived = await w.thread("Archived by a filter");
    assert.deepEqual([archived.category, archived.categorizedBy, archived.screened, archived.done], ["unknown", undefined, false, true], "the matching rule didn't run");
    const filed = await w.thread("Filed to Newsletters");
    assert.deepEqual([filed.category, filed.categorizedBy, filed.screened, filed.done], ["newsletter", "mailbox", false, false], "its folder is its category; not screened");
    const screening = await w.thread("Filed to Screening");
    assert.deepEqual([screening.category, screening.screened, screening.done], ["unknown", true, false], "the Screening folder screens it");
    assert.equal((await w.call("GET", "/v1/search?q=You%20won")).body.items.length, 0, "mail in Junk is ignored");
    assert.deepEqual((await w.ok("GET", "/v1/categories/newsletter")).items.map((x: Json) => x.id), [filed.id]);
    assert.deepEqual((await w.ok("GET", "/v1/screening")).items.map((x: Json) => x.id), [screening.id]);
    assert.deepEqual((await w.ok("GET", "/v1/triage")).map((item: Json) => item.thread.subject), ["Earlier conversation"], "nothing filed waits in the queue");
    assert.equal((await w.ok("GET", `/v1/inboxes/${inbox.id}/rules`)).find((r: Json) => r.id === rule.id).hits, 0);
    assert.deepEqual([await folderOf("Archived by a filter"), await folderOf("Filed to Newsletters"), await folderOf("Filed to Screening")],
      [["Archive"], ["Usual Mail/Newsletters"], ["Usual Mail/Screening"]], "nothing moved at the mailbox");

    // The same sender writing to the inbox is still screened: the filing let nobody in.
    host.deliver(rawMail({ from: "Tomas <tomas@brightfield.example>", subject: "To the inbox", messageId: id("inbox") }));
    await w.sync(inbox.id);
    assert.equal((await w.thread("To the inbox")).screened, true);
  });
});

describe("IMAP end to end: a paused inbox", () => {
  test("writes nothing while paused; what was done meanwhile goes out once it is resumed", async () => {
    const inbox = await connect();
    host.deliver(rawMail({ from: DANA, subject: "Lumen news", messageId: id("news") }));
    await w.sync(inbox.id);
    const news = await w.thread("Lumen news");
    assert.equal((await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { paused: true } })).status, "paused");
    const moved = await act(news.id, { kind: "categorize", category: "newsletter" });
    assert.equal(moved.threads[0].category, "newsletter");
    await act(news.id, { kind: "read" });
    await w.idle();
    const before = (await host.folders()).find((m) => m.subject === "Lumen news")!;
    assert.deepEqual([before.folder, before.flags.includes("\\Seen")], ["INBOX", false], "nothing written while paused");
    assert.equal((await w.call("POST", `/v1/inboxes/${inbox.id}/sync`)).body.error.code, "conflict");

    assert.equal((await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { paused: false } })).status, "connecting");
    await w.idle();
    const after = (await host.folders()).find((m) => m.subject === "Lumen news")!;
    assert.deepEqual([after.folder, after.flags.includes("\\Seen")], ["Usual Mail/Newsletters", true]);
    assert.equal((await w.ok("GET", "/v1/inboxes"))[0].status, "ok");
  });
});

describe("IMAP end to end: a refused move", () => {
  test("fails its record without undoing a later move of the same thread", async () => {
    const inbox = await connect();
    await w.ok("PATCH", `/v1/inboxes/${inbox.id}`, { body: { agentAccess: true } });
    const agent = await w.agent([inbox.id]);
    host.deliver(rawMail({ from: DANA, subject: "Lumen news", messageId: id("news") }));
    await w.sync(inbox.id);
    const news = await w.thread("Lumen news");
    const refusal = host.refuseOnce("UID MOVE", "[CANNOT] Mailbox is busy");
    const first = await w.ok("POST", "/v1/actions", { token: agent, body: { threadIds: [news.id], action: { kind: "categorize", category: "newsletter" }, reason: "News" } });
    // While the mailbox is still answering the agent's move, the person puts the thread in another category.
    await refusal.reached;
    const second = await act(news.id, { kind: "categorize", category: "receipt" });
    refusal.release();
    await w.idle();
    const failed = (await w.ok("GET", "/v1/handled?attentionOnly=true")).items;
    assert.deepEqual(failed.map((i: Json) => [i.record.id, i.record.state]), [[first.records[0].id, "failed"]]);
    assert.match(failed[0].record.error, /refused to move the message to Usual Mail\/Newsletters/);
    assert.equal((await w.thread("Lumen news")).category, "receipt", "the later change stands");
    assert.deepEqual(await folderOf("Lumen news"), ["Usual Mail/Receipts"]);
    const undone = await w.ok("POST", `/v1/actions/${second.records[0].id}/undo`);
    assert.deepEqual([undone.threads[0].category, undone.threads[0].categorizedBy], ["unknown", "person"], "its undo goes back to before both, and the person decided it");
    await w.idle();
    assert.deepEqual(await folderOf("Lumen news"), ["INBOX"]);
  });
});
