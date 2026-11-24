// The first sync's window (docs/contract-sync.md, "Sync"; `GET` and `PATCH /v1/first-sync`): a person reads it and,
// where the host keeps settings and the environment didn't set it, changes it while the server runs. A new inbox takes
// the new window; a first sync in progress narrows to a smaller one (in e2e-first-sync-window.test.ts); a larger one
// changes no inbox already connected.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createApp } from "../src/rest/app.ts";
import { DAY, historyFromKnown, KNOWN, makeServer, START, type MakeOptions, type TestServer } from "./helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const saved: number[] = [];
async function server(options: MakeOptions = {}): Promise<TestServer> {
  saved.length = 0;
  t = await makeServer(options);
  return t;
}
const keeping = { syncWindowDays: 30, syncWindowSetBy: "settings" as const, saveSyncWindowDays: async (days: number) => void saved.push(days) };
const ago = (ms: number) => new Date(Date.parse(START) - ms).toISOString();

describe("reading it", () => {
  test("a person reads the days, where they came from and whether they can be changed here; an agent can't", async () => {
    const s = await server(keeping);
    assert.deepEqual(await s.server.firstSyncWindow(s.person), { days: 30, setBy: "settings", changeable: true });
    const { inbox } = await s.connect({ address: "me@window.example", history: [historyFromKnown] });
    await s.server.updateInbox(s.person, inbox.id, { agentAccess: true });
    const agent = await s.agent([inbox.id]);
    await assert.rejects(s.server.firstSyncWindow(agent.caller), { code: "needs_person" });
    const app = createApp(s.server, { scheduler: s.clock, log: s.host.log });
    const asAgent = await app.request("/v1/first-sync", { headers: { authorization: `Bearer ${agent.token}` } });
    assert.equal(asAgent.status, 403);
    const asPerson = await app.request("/v1/first-sync", { headers: { authorization: `Bearer ${s.personToken}` } });
    assert.deepEqual(await asPerson.json(), { days: 30, setBy: "settings", changeable: true });
  });

  test("set by the environment, or where the host keeps no settings, it can't be changed here", async () => {
    let s = await server({ syncWindowDays: 14, syncWindowSetBy: "environment", saveSyncWindowDays: keeping.saveSyncWindowDays });
    assert.deepEqual(await s.server.firstSyncWindow(s.person), { days: 14, setBy: "environment", changeable: false });
    await assert.rejects(s.server.updateFirstSyncWindow(s.person, { days: 7 }), (error: { code: string; message: string }) => {
      assert.equal(error.code, "conflict");
      assert.match(error.message, /USUAL_MAIL_SYNC_DAYS sets the first sync's window where this server starts/);
      return true;
    });
    await s.close();
    s = await server();
    assert.deepEqual(await s.server.firstSyncWindow(s.person), { days: 30, setBy: "default", changeable: false });
    await assert.rejects(s.server.updateFirstSyncWindow(s.person, { days: 7 }), { code: "conflict" });
    assert.deepEqual(saved, []);
  });
});

describe("changing it", () => {
  test("whole days from 1 to 36,500 only, a person's, kept by the host; the same number keeps nothing again", async () => {
    const s = await server(keeping);
    for (const days of [0, 36_501, 1.5, -3]) await assert.rejects(s.server.updateFirstSyncWindow(s.person, { days }), { code: "invalid" });
    for (const body of [{ days: "7" }, {}, { days: 7, more: true }]) {
      await assert.rejects(s.server.updateFirstSyncWindow(s.person, body as never), { code: "invalid" });
    }
    assert.deepEqual(await s.server.updateFirstSyncWindow(s.person, { days: 30 }), { days: 30, setBy: "settings", changeable: true });
    assert.deepEqual(saved, [], "the same number changes nothing");
    assert.deepEqual(await s.server.updateFirstSyncWindow(s.person, { days: 7 }), { days: 7, setBy: "settings", changeable: true });
    assert.deepEqual(saved, [7]);
    assert.equal((await s.server.firstSyncWindow(s.person)).days, 7, "at once, with no restart");
    const { inbox } = await s.connect({ address: "me@window.example", history: [historyFromKnown] });
    await s.server.updateInbox(s.person, inbox.id, { agentAccess: true });
    const agent = await s.agent([inbox.id]);
    await assert.rejects(s.server.updateFirstSyncWindow(agent.caller, { days: 3 }), { code: "needs_person" });
    const app = createApp(s.server, { scheduler: s.clock, log: s.host.log });
    const patched = await app.request("/v1/first-sync", {
      method: "PATCH",
      headers: { authorization: `Bearer ${s.personToken}`, "content-type": "application/json" },
      body: JSON.stringify({ days: 3 }),
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(saved, [7, 3]);
  });

  test("from the default, a change is kept and then reads as the settings'", async () => {
    const s = await server({ saveSyncWindowDays: keeping.saveSyncWindowDays });
    assert.deepEqual(await s.server.firstSyncWindow(s.person), { days: 30, setBy: "default", changeable: true });
    assert.deepEqual(await s.server.updateFirstSyncWindow(s.person, { days: 30 }), { days: 30, setBy: "settings", changeable: true });
    assert.deepEqual(saved, [30], "the default's own number is kept, so it holds if the default changes");
  });

  test("an inbox connected afterwards takes the new window; one connected before keeps what it has", async () => {
    const s = await server(keeping);
    const mail = [
      historyFromKnown,
      { from: KNOWN, subject: "Twenty days old", date: ago(20 * DAY), placement: { inInbox: true } },
      { from: KNOWN, subject: "Five days old", date: ago(5 * DAY), placement: { inInbox: true } },
    ];
    await s.connect({ address: "before@window.example", history: mail });
    await s.server.updateFirstSyncWindow(s.person, { days: 7 });
    await s.connect({ address: "after@window.example", history: mail });
    const where = async (subject: string) =>
      (await s.server.search(s.person, { q: subject, limit: 50 })).items.map((thread) => thread.inboxId).sort();
    const inboxes = await s.server.listInboxes(s.person);
    const before = inboxes.find((inbox) => inbox.address === "before@window.example")!.id;
    const after = inboxes.find((inbox) => inbox.address === "after@window.example")!.id;
    assert.deepEqual(await where("Five days old"), [after, before].sort());
    assert.deepEqual(await where("Twenty days old"), [before], "older than the new 7 days: not fetched for the new inbox");
    await s.server.updateFirstSyncWindow(s.person, { days: 60 });
    await s.sync(inboxes.find((inbox) => inbox.id === after)!);
    assert.deepEqual(await where("Twenty days old"), [before], "a larger window fetches nothing more for an inbox already connected");
  });
});
