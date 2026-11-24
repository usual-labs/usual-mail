// Matching names, words and domains without LIKE (docs/agents/decisions.md, 2026-11-21): a Durable Object's SQLite
// refuses a LIKE or GLOB pattern over 50 bytes, and test/parameters.ts fails any here. `contains` and `endsWith`
// (src/db/match.ts) match exactly as the escaped LIKE did, for long and non-ASCII text too: search's who-wrote filters
// and the people it finds, and sender pictures for a long domain. Made-up names and domains.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { sql } from "drizzle-orm";
import { contains, endsWith } from "../src/db/match.ts";
import { openDatabase } from "../src/node/db.ts";
import type { DeliverInput } from "../src/testing/index.ts";
import { brandMail, FakeSites, icon, TEST_SUFFIXES } from "./avatar-hosts.ts";
import { at, DAY, HOUR, makeServer, type TestServer } from "./helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A 20-character CJK name: 60 bytes in UTF-8, past the 50 a pattern may have. */
const LONG_NAME = "山田花子株式会社東京本社営業企画部国際課長";
/** A registrable domain of 57 characters. */
const LONG_DOMAIN = "organisation-with-a-rather-long-name-for-pictures.example";

describe("contains and endsWith match as an escaped LIKE did", () => {
  test("ASCII in either case, other letters exactly, wildcards and backslashes literally, NULL as NULL", async () => {
    const store = await openDatabase(":memory:");
    try {
      const escape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
      const values = ["Dana Whitfield", "dana", "Éva Ébert", "éva", "STRASSE", "straße", "a_c", "abc", "a%c", "back\\slash", "x📬y", "", null];
      const texts = ["dana", "DANA", "éva", "Éva", "ße", "SSE", "_", "a_c", "%", "\\", "📬y", "y", ""];
      for (const value of values) {
        for (const text of texts) {
          const row = await store.db.get<{ inLike: number | null; inNew: number | null; endLike: number | null; endNew: number | null }>(sql`
            SELECT ${value} LIKE ${`%${escape(text)}%`} ESCAPE '\\' AS inLike, ${contains(sql`${value}`, text)} AS inNew,
              ${value} LIKE ${`%${escape(text)}`} ESCAPE '\\' AS endLike, ${endsWith(sql`${value}`, text)} AS endNew`);
          assert.equal(row!.inNew, row!.inLike, `${JSON.stringify(value)} contains ${JSON.stringify(text)}`);
          assert.equal(row!.endNew, row!.endLike, `${JSON.stringify(value)} ends with ${JSON.stringify(text)}`);
        }
      }
      const long = await store.db.get<{ found: number; ends: number }>(sql`
        SELECT ${contains(sql`${` ${LONG_NAME} 2026`}`, ` ${LONG_NAME}`)} AS found, ${endsWith(sql`${`news@MAIL.${LONG_DOMAIN}`}`, `.${LONG_DOMAIN}`)} AS ends`);
      assert.deepEqual({ ...long }, { found: 1, ends: 1 }, "past 50 bytes too");
    } finally {
      store.close();
    }
  });
});

describe("search with long and non-ASCII terms", () => {
  test("a 60-byte CJK name in from: and to:, and the people a search finds", async () => {
    t = await makeServer();
    const writer = { name: LONG_NAME, email: "hanako@tokyo.example" };
    const { inbox } = await t.connect({ address: "me@inbox.example", history: [
      { from: writer, to: [{ name: "Ken", email: "ken@team.example" }], subject: "Quarterly plan", text: "The plan.", date: at(-DAY) },
      { from: { name: "Other Sender", email: "other@tokyo.example" }, to: [writer], subject: "Reply to Hanako", text: "Thanks.", date: at(-DAY + HOUR) },
    ] });
    const subjects = async (query: { from?: string; to?: string; q?: string }) =>
      (await t!.server.search(t!.person, { ...query, inboxIds: [inbox.id] })).items.map((hit) => hit.subject);
    assert.deepEqual(await subjects({ from: LONG_NAME }), ["Quarterly plan"]);
    assert.deepEqual(await subjects({ to: LONG_NAME }), ["Reply to Hanako"]);
    assert.deepEqual(await subjects({ from: LONG_NAME.slice(0, 18) }), ["Quarterly plan"], "the start of a word");
    assert.deepEqual(await subjects({ from: LONG_NAME.slice(2) }), [], "not the middle of one");
    const people = await t.server.search(t.person, { q: LONG_NAME });
    assert.deepEqual(people.people?.map((p) => [p.email, p.name]), [[writer.email, LONG_NAME]]);
  });

  test("a long domain and its subdomains, never a look-alike, and wildcards taken literally", async () => {
    t = await makeServer();
    const mail = (email: string, subject: string): DeliverInput => ({ from: { email }, subject, text: "Hello.", date: at(-DAY) });
    const { inbox } = await t.connect({ address: "me@inbox.example", history: [
      mail(`billing@${LONG_DOMAIN}`, "Exact domain"),
      mail(`news@mail.${LONG_DOMAIN}`, "Subdomain"),
      mail(`ann@not${LONG_DOMAIN}`, "Look-alike"),
      mail("dana@example.example", "Plain example"),
    ] });
    const subjects = async (from: string) =>
      (await t!.server.search(t!.person, { from, inboxIds: [inbox.id] })).items.map((hit) => hit.subject).sort();
    assert.deepEqual(await subjects(`@${LONG_DOMAIN.toUpperCase()}`), ["Exact domain", "Subdomain"]);
    assert.deepEqual(await subjects(LONG_DOMAIN), ["Exact domain", "Subdomain"]);
    assert.deepEqual(await subjects("@exampl_.example"), [], "_ is a character, not any");
    assert.deepEqual(await subjects("@%.example"), [], "% is a character, not any run");
    assert.deepEqual(await subjects("@example.example"), ["Plain example"]);
  });
});

describe("sender pictures for a long domain", () => {
  test("its threads show its picture, and a caller limited to its inbox may load it", async () => {
    const sites = new FakeSites();
    sites.icons.set(LONG_DOMAIN, icon());
    t = await makeServer({ avatars: { suffixes: TEST_SUFFIXES, backfill: false, queue: { gapMs: 0 } }, siteIcons: sites });
    const { inbox } = await t.connect({ address: "me@inbox.example", history: [brandMail("Long news", {
      from: { name: "Long Org", email: `news@mail.${LONG_DOMAIN}` },
      listId: `<weekly.${LONG_DOMAIN}>`,
      fromCheck: { result: "verified", domain: `mail.${LONG_DOMAIN}` },
      date: at(-DAY),
    })] });
    const other = await t.connect({ address: "me@other.example" });
    await t.tick(6 * HOUR);
    assert.deepEqual(sites.asked, [LONG_DOMAIN]);
    const thread = await t.threadBySubject("Long news");
    assert.match(thread.avatar?.picture ?? "", /^\/v1\/avatars\/[0-9a-f]{32}$/);
    const id = thread.avatar!.picture.split("/").at(-1)!;
    const limitedTo = (ids: string[]) => ({ ...t!.person, inboxIds: ids });
    assert.equal((await t.server.fetchAvatar(limitedTo([inbox.id]), id)).mimeType, "image/png");
    await assert.rejects(t.server.fetchAvatar(limitedTo([other.inbox.id]), id), { code: "not_found" });
  });
});
