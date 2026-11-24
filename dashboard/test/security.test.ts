// Cross-site request protection on every form, strict headers, escaping of hostile text, secrets kept out of
// pages, and the structural accessibility checks a test can make without a browser.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formToken } from "../src/http/session.ts";
import { CONTENT_SECURITY_POLICY } from "../src/http/headers.ts";
import { FakeService } from "./fake-service.ts";
import { PAGES, PERSON_TOKEN, setup } from "./helpers.ts";

/** Every form a signed-in page can post to, with fields that would make it act. */
const POST_ROUTES: Array<[string, Record<string, string | string[]>]> = [
  ["/sign-out", {}],
  ["/inboxes", { provider: "gmail", name: "X", color: "#285fcd", clientId: "a", clientSecret: "bbbb", refreshToken: "cccc" }],
  ["/inboxes/inb_northwind/name", { name: "Renamed", color: "#a9356c" }],
  ["/inboxes/inb_northwind/trust", { trust: "act_silently" }],
  ["/inboxes/inb_northwind/agents", { agentAccess: "off" }],
  ["/inboxes/inb_northwind/guide", { guide: "changed" }],
  ["/inboxes/inb_northwind/pause", { paused: "yes" }],
  ["/inboxes/inb_northwind/sync", {}],
  ["/inboxes/inb_northwind/remove", {}],
  ["/inboxes/inb_northwind/reconnect", { clientId: "a", clientSecret: "bbbb", refreshToken: "cccc" }],
  ["/inboxes/inb_northwind/place", { icon: "globe", position: "2" }],
  ["/inboxes/google", { name: "Ana", color: "#277a40" }],
  ["/inboxes/inb_northwind/google", {}],
  ["/ai/key", { service: "gateway:vercel", apiKey: "vck_new-key-1234" }],
  ["/ai/models", { categorize: "example/decision-2", summarize: "" }],
  ["/ai/history", { historyDays: "14" }],
  ["/ai/pause", { paused: "yes" }],
  ["/ai/test", {}],
  ["/ai/remove", {}],
  ["/inboxes/inb_northwind/rules", { text: "t", from: "a@b.example", read: "on" }],
  ["/rules/rul_1/enable", { enabled: "off", inbox: "inb_northwind" }],
  ["/rules/rul_1/delete", { inbox: "inb_northwind" }],
  ["/devices/pair-app", {}],
  ["/devices/pair-agent", { inboxIds: "inb_northwind" }],
  ["/devices/dev_agent_1/revoke", {}],
  ["/handled/approve", { ids: "act_4" }],
  ["/handled/reject", { ids: "act_4" }],
  ["/handled/act_1/undo", {}],
  ["/teach/tch_1", { accept: "yes" }],
];

/** The route a form action belongs to, with ids replaced, to compare with POST_ROUTES. */
const shape = (path: string) =>
  path
    .replace(/^\/inboxes\/[^/]+(?=\/)/, "/inboxes/:id")
    .replace(/^\/(rules|devices|handled|teach)\/(?!pair-|approve|reject)[^/]+/, "/$1/:id");

async function allPages(app: ReturnType<typeof setup>) {
  const pages: Array<[string, string]> = [];
  for (const path of PAGES) pages.push([path, (await app.page(path)).body]);
  pages.push(["/sign-in", (await app.page("/sign-in", { token: null })).body]);
  return pages;
}

describe("cross-site request protection", () => {
  test("every form on every page is in the list below and carries this session's form token", async () => {
    const app = setup();
    const expected = await formToken(PERSON_TOKEN);
    const known = new Set(POST_ROUTES.map(([path]) => shape(path)).concat("/sign-in"));
    let forms = 0;
    for (const [path, body] of await allPages(app)) {
      for (const [, action, inner] of body.matchAll(/<form method="post" action="([^"]*)"[^>]*>(.*?)<\/form>/gs)) {
        forms += 1;
        assert.ok(known.has(shape(action!)), `${path}: form to ${action} is not covered by the tests`);
        const token = /<input type="hidden" name="_csrf" value="([^"]*)">/.exec(inner!)?.[1];
        if (action === "/sign-in") assert.match(token ?? "", /^[A-Za-z0-9_-]{32}$/);
        else assert.equal(token, expected, `${path}: form to ${action}`);
      }
      assert.doesNotMatch(body, /<form(?![^>]*method="post")/, `${path}: every form posts`);
    }
    assert.ok(forms > 40, `found ${forms} forms`);
  });

  for (const [path, fields] of POST_ROUTES) {
    test(`${path} refuses a missing or wrong token and a cross-site post, and changes nothing`, async () => {
      const app = setup();
      const attempts = [
        app.post(path, { ...fields, _csrf: "" }),
        app.post(path, { ...fields, _csrf: await formToken("someone-elses-token") }),
        app.post(path, fields, { headers: { "sec-fetch-site": "cross-site" } }),
        app.post(path, fields, { headers: { "sec-fetch-site": "same-site" } }),
      ];
      for (const res of await Promise.all(attempts)) {
        assert.equal(res.status, 403);
        assert.match(await res.text(), /Form not accepted/);
      }
      assert.deepEqual(app.fake.methods(), [], "no service call");
    });
  }

  test("without fetch metadata, Origin decides: another site or null is refused, this site is let through", async () => {
    for (const origin of ["https://evil.example", "null"]) {
      const app = setup();
      const res = await app.handler(
        new Request("http://localhost:8484/inboxes/inb_northwind/trust", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", cookie: app.sessionCookie(PERSON_TOKEN), origin },
          body: new URLSearchParams({ _csrf: await formToken(PERSON_TOKEN), trust: "act_silently" }),
        }),
      );
      assert.equal(res.status, 403, origin);
      assert.deepEqual(app.fake.methods(), []);
    }
    const app = setup();
    const res = await app.handler(
      new Request("http://localhost:8484/inboxes/inb_northwind/trust", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: app.sessionCookie(PERSON_TOKEN), origin: "http://localhost:8484" },
        body: new URLSearchParams({ _csrf: await formToken(PERSON_TOKEN), trust: "act_silently" }),
      }),
    );
    assert.equal(res.status, 303);
  });

  test("a JSON body is not a form and is refused", async () => {
    const app = setup();
    const res = await app.handler(
      new Request("http://localhost:8484/handled/approve", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: app.sessionCookie(PERSON_TOKEN), "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ _csrf: await formToken(PERSON_TOKEN), ids: ["act_4"] }),
      }),
    );
    assert.equal(res.status, 403);
    assert.deepEqual(app.fake.methods(), []);
  });

  test("an oversized form is refused before it is read", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_northwind/guide", { guide: "x".repeat(300 * 1024) });
    assert.equal(res.status, 413);
    assert.deepEqual(app.fake.methods(), []);
  });
});

describe("headers", () => {
  test("every kind of response carries the strict headers", async () => {
    const app = setup();
    const responses = {
      page: await app.get("/inboxes"),
      redirect: await app.get("/inboxes", { token: null }),
      signIn: await app.get("/sign-in", { token: null }),
      notFound: await app.get("/nothing-here"),
      refused: await app.post("/handled/approve", { _csrf: "", ids: "act_4" }),
      asset: await app.get(new URL((await app.page("/")).body.match(/href="(\/assets\/app\.[^"]+)"/)![1]!, "http://x").pathname, { token: null }),
    };
    for (const [kind, res] of Object.entries(responses)) {
      const h = res.headers;
      assert.equal(h.get("content-security-policy"), CONTENT_SECURITY_POLICY, kind);
      assert.equal(h.get("x-content-type-options"), "nosniff", kind);
      assert.equal(h.get("x-frame-options"), "DENY", kind);
      assert.equal(h.get("referrer-policy"), "same-origin", kind);
      assert.equal(h.get("cross-origin-opener-policy"), "same-origin", kind);
      assert.equal(h.get("cache-control"), kind === "asset" ? "public, max-age=31536000, immutable" : "no-store", kind);
    }
    assert.match(CONTENT_SECURITY_POLICY, /script-src 'none'/);
    assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
    assert.match(CONTENT_SECURITY_POLICY, /form-action 'self'/);
    assert.match(CONTENT_SECURITY_POLICY, /base-uri 'none'/);
    assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe/);
  });

  test("pages have no scripts, no inline styles and no event handlers, so the policy holds", async () => {
    for (const [path, body] of await allPages(setup())) {
      assert.doesNotMatch(body, /<script/i, path);
      assert.doesNotMatch(body, /<style/i, path);
      assert.doesNotMatch(body, /\sstyle="/i, path);
      assert.doesNotMatch(body, /\son[a-z]+="/i, path);
    }
  });
});

const HOSTILE = `<script>alert("x")</script>"><img src=x onerror=alert(1)>' onmouseover='y`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39; onmouseover=&#39;y";

function makeHostile(fake: FakeService): void {
  for (const inbox of fake.inboxes) {
    inbox.name = `${inbox.name} ${HOSTILE}`;
    inbox.address = `${HOSTILE}@x.example`;
    inbox.guide = `${HOSTILE}</textarea>`;
    inbox.statusDetail = HOSTILE;
    inbox.status = "needs_attention";
  }
  for (const thread of fake.threads) thread.subject = HOSTILE;
  for (const record of fake.actions) {
    record.reason = HOSTILE;
    record.error = HOSTILE;
    // Notes and errors come from mail providers: data, escaped like everything else.
    record.note = HOSTILE;
    if (record.actor.kind === "agent") record.actor.name = HOSTILE;
  }
  fake.actions.find((record) => record.id === "act_3")!.state = "failed";
  for (const draft of fake.drafts) {
    Object.assign(draft, { state: "failed", error: HOSTILE, subject: HOSTILE, to: [{ name: HOSTILE, email: `${HOSTILE}@x.example` }] });
  }
  for (const rule of fake.rules) {
    rule.text = HOSTILE;
    rule.match = { ...rule.match, subjectContains: HOSTILE };
  }
  for (const device of fake.devices) device.name = HOSTILE;
  fake.rules[0]!.id = `rul_"><b>x`;
  // What the AI service said, and the model ids a person may type, are shown as text too.
  fake.aiState = { ...fake.aiState, state: "key_refused", detail: HOSTILE };
  for (const job of fake.ai.jobs) job.model = HOSTILE;
  for (const record of fake.actions) if (record.actor.kind === "ai") record.actor.model = HOSTILE;
}

describe("escaping", () => {
  test("hostile names, addresses, subjects, reasons, guides, rules and device names come out as text", async () => {
    const app = setup();
    makeHostile(app.fake);
    for (const path of PAGES) {
      const { body, status } = await app.page(path);
      assert.equal(status, 200, path);
      assert.doesNotMatch(body, /<script|<img|<b>x/i, path);
      assert.ok(!body.includes(HOSTILE), path);
      assert.doesNotMatch(body, /<\/textarea>[^\n]*<\/textarea>/, `${path}: the guide can't close its text area`);
    }
    const inboxes = (await app.page("/inboxes")).body;
    assert.ok(inboxes.includes(ESCAPED), "the text is still shown, escaped");
    const handled = (await app.page("/handled")).body;
    assert.ok(handled.includes(ESCAPED));
    const rules = (await app.page("/inboxes/inb_northwind/rules")).body;
    assert.match(rules, /action="\/rules\/rul_%22%3E%3Cb%3Ex\/enable"/, "ids in paths are encoded");
    const guide = (await app.page("/inboxes/inb_northwind")).body;
    assert.ok(guide.includes(`${ESCAPED}&lt;/textarea&gt;</textarea>`));
  });

  test("hostile text in a teach question and in a service error is escaped", async () => {
    const app = setup();
    app.fake.teachOnUndo = {
      id: "tch_1",
      question: HOSTILE,
      rule: { inboxId: "inb_northwind", text: HOSTILE, match: { from: HOSTILE }, then: [{ kind: "categorize", category: "conversation" }] },
      fromActionId: "act_1",
      expiresAt: "2026-11-17T09:30:00Z",
    };
    const asked = await (await app.post("/handled/act_1/undo", { return: "/handled" })).text();
    assert.doesNotMatch(asked, /<script|<img/);
    assert.ok(asked.includes(ESCAPED));
    const { ServiceError } = await import("@usualmail/core");
    app.fake.failNext("syncInbox", new ServiceError("provider_error", HOSTILE));
    const failed = await (await app.post("/inboxes/inb_northwind/sync")).text();
    assert.doesNotMatch(failed, /<script|<img/);
    // The provider's answer to new credentials is shown in words: escaped.
    app.fake.failNext("updateInbox", new ServiceError("provider_error", HOSTILE));
    const refused = await (await app.post("/inboxes/inb_northwind/reconnect", { clientId: "a", clientSecret: "bbbb", refreshToken: "cccc" })).text();
    assert.doesNotMatch(refused, /<script|<img/);
    assert.ok(refused.includes(ESCAPED));
  });

  test("hostile notes, errors and failed drafts on Home and in Handled come out as text", async () => {
    const app = setup();
    makeHostile(app.fake);
    for (const path of ["/", "/handled", "/handled?silent=1"]) {
      const { body } = await app.page(path);
      assert.doesNotMatch(body, /<script|<img/i, path);
      assert.ok(!body.includes(HOSTILE), path);
      assert.ok(body.includes(`Note from the provider: ${ESCAPED}`), `${path}: the note is shown, escaped`);
    }
    const home = (await app.page("/")).body;
    assert.ok(home.includes(`It didn't send: ${ESCAPED}`), "a failed draft's error is shown, escaped");
  });

  test("query parameters on Handled come back only as escaped, encoded links", async () => {
    const app = setup();
    const { body, status } = await app.page(`/handled?silent=1&cursor=${encodeURIComponent('"><script>x</script>')}`);
    assert.equal(status, 200);
    assert.doesNotMatch(body, /<script/);
  });
});

describe("secrets", () => {
  test("the session token never appears in a page", async () => {
    for (const [path, body] of await allPages(setup())) assert.ok(!body.includes(PERSON_TOKEN), path);
  });

  test("the AI key never appears in a page, and the key field is never filled in", async () => {
    const app = setup();
    for (const [path, body] of await allPages(app)) {
      assert.ok(!body.includes("sample-key-never-shown"), path);
      assert.doesNotMatch(body, /name="apiKey" value="[^"]/, `${path}: the key field starts empty`);
    }
  });
});

describe("structure for assistive technology", () => {
  test("each page has one h1, a language, and a label for every field", async () => {
    for (const [path, body] of await allPages(setup())) {
      assert.match(body, /<html lang="en">/, path);
      assert.equal((body.match(/<h1[ >]/g) ?? []).length, 1, `${path}: one h1`);
      const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
      assert.equal(new Set(ids).size, ids.length, `${path}: ids are unique`);
      const fields = [...body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)].filter(
        ([, , attrs]) => !/type="(hidden|submit)"/.test(attrs!),
      );
      for (const [tag, , attrs] of fields) {
        const id = /\bid="([^"]+)"/.exec(attrs!)?.[1];
        assert.ok(id, `${path}: ${tag} without an id`);
        assert.ok(body.includes(`<label for="${id}"`) || body.includes(`for="${id}">`), `${path}: no label for ${id}`);
      }
      assert.match(body, /<a class="skip" href="#main">/, path);
      assert.match(body, /<main id="main"/, path);
    }
  });
});
