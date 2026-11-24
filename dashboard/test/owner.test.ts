// The owner's password on the dashboard: an unclaimed server sends its first visitor to set it up (with Google's
// proof when the host named the owner's email), the sign-in page asks for the password once there is one, a
// recovery code is asked for without showing it, and the Account page sets the password.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GOOD_PROOF } from "./fake-owner.ts";
import { cookies, hiddenValue, setup } from "./helpers.ts";

type App = ReturnType<typeof setup>;

/** Opens a page that carries the sign-in form's token, and returns it with its cookie. */
async function openForm(app: App, path: string) {
  const res = await app.get(path, { token: null });
  const body = await res.text();
  const cookie = [...cookies(res).values()].find((line) => line.includes("usual-mail-sign-in="))!;
  return { body, status: res.status, formToken: hiddenValue(body, "_csrf")!, cookie: cookie.slice(0, cookie.indexOf(";")) };
}

async function postOpen(app: App, path: string, from: string, fields: Record<string, string>) {
  const form = await openForm(app, from);
  return app.post(path, { _csrf: form.formToken, ...fields }, { token: null, headers: { cookie: form.cookie } });
}

/** A server nobody has paired with or claimed. */
function unclaimed(claim: "password" | "google" = "password"): App {
  const app = setup();
  app.fake.devices = [];
  app.fake.ownerFake.claim = claim;
  return app;
}

describe("setting up an unclaimed server", () => {
  test("the sign-in page sends the first visitor to set it up; the claim signs this browser in", async () => {
    const app = unclaimed();
    const away = await app.get("/sign-in", { token: null });
    assert.equal(away.status, 303);
    assert.equal(away.headers.get("location"), "/claim");

    const form = await openForm(app, "/claim");
    assert.match(form.body, /Nobody owns this server yet/);
    assert.match(form.body, /type="password" id="password"[^>]*autocomplete="new-password"/);

    const differ = await postOpen(app, "/claim", "/claim", { password: "correct horse battery", passwordAgain: "correct horse batteries", name: "Browser" });
    assert.equal(differ.status, 400);
    assert.match(await differ.text(), /The two passwords aren&#39;t the same/);

    const short = await postOpen(app, "/claim", "/claim", { password: "short", passwordAgain: "short", name: "Browser" });
    assert.equal(short.status, 400);
    assert.match(await short.text(), /at least 12 characters/);

    const done = await postOpen(app, "/claim", "/claim", { password: "correct horse battery", passwordAgain: "correct horse battery", email: "me@example.org", name: "Browser" });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get("location"), "/?done=claimed");
    assert.match(cookies(done).get("usual-mail-session")!, /^usual-mail-session=umt_issued_/);
    assert.equal(app.fake.ownerFake.email, "me@example.org");

    // Claimed: the claim page goes to signing in, which now asks for the password.
    assert.equal((await app.get("/claim", { token: null })).headers.get("location"), "/sign-in");
  });

  test("with the host's owner email: Google first, then the password, with the proof", async () => {
    const app = unclaimed("google");
    const form = await openForm(app, "/claim");
    assert.match(form.body, /Sign in with Google as that address/);
    assert.doesNotMatch(form.body, /id="password"/);
    const google = await postOpen(app, "/claim/google", "/claim", {});
    assert.equal(google.status, 200);
    assert.match(await google.text(), /href="https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?scope=openid\+email&amp;state=claim"/);

    const proven = await openForm(app, `/claim?proof=${GOOD_PROOF}`);
    assert.equal(hiddenValue(proven.body, "proof"), GOOD_PROOF);
    assert.doesNotMatch(proven.body, /id="email"/, "the email is Google's");
    const done = await app.post("/claim", { _csrf: proven.formToken, proof: GOOD_PROOF, password: "correct horse battery", passwordAgain: "correct horse battery", name: "Browser" }, { token: null, headers: { cookie: proven.cookie } });
    assert.equal(done.status, 303);
    assert.equal(app.fake.ownerFake.email, "owner@example.org");
  });
});

describe("signing in with the password", () => {
  test("once there is a password, the sign-in page asks for it, and a pairing code is one link away", async () => {
    const app = setup();
    app.fake.ownerFake.password = "correct horse battery";
    const form = await openForm(app, "/sign-in");
    assert.match(form.body, /type="password" id="password"[^>]*autocomplete="current-password"/);
    assert.match(form.body, /href="\/forgot"/);
    assert.match(form.body, /href="\/sign-in\?with=code"/);
    const codePage = await openForm(app, "/sign-in?with=code");
    assert.match(codePage.body, /id="code"/);
    assert.match(codePage.body, /Sign in with your password/);

    const wrong = await postOpen(app, "/sign-in", "/sign-in", { password: "not the password", name: "Browser" });
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /That password is wrong\./);
    const right = await postOpen(app, "/sign-in", "/sign-in", { password: "correct horse battery", name: "Browser", next: "/devices" });
    assert.equal(right.status, 303);
    assert.equal(right.headers.get("location"), "/devices");
    assert.ok(app.fake.devices.some((device) => device.name === "Browser" && device.kind === "person"));
  });

  test("without a password the sign-in page is the pairing code's, as before", async () => {
    const form = await openForm(setup(), "/sign-in");
    assert.match(form.body, /id="code"/);
    assert.doesNotMatch(form.body, /Sign in with your password/);
  });
});

describe("forgot the password", () => {
  test("a recovery code is made without being shown, and the page says where it waits and how long", async () => {
    const app = setup({ ownerCodeWhere: "keeps it in Data Studio" });
    const form = await openForm(app, "/forgot");
    assert.match(form.body, /it keeps it in Data Studio/);
    const res = await postOpen(app, "/forgot", "/forgot", {});
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /A recovery code works once, until 16 Nov 2026, 10:00 UTC\./);
    assert.match(body, /href="\/sign-in\?with=code&amp;next=%2Faccount"/);
    assert.ok(app.fake.calls.some((call) => call.method === "requestRecoveryCode"));
  });

  test("a form from another site, or without its token, does nothing", async () => {
    const app = setup();
    const foreign = await app.post("/forgot", {}, { token: null, headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(foreign.status, 403);
    const tokenless = await app.post("/forgot", { _csrf: "" }, { token: null });
    assert.equal(tokenless.status, 403);
    assert.ok(!app.fake.calls.some((call) => call.method === "requestRecoveryCode"));
  });
});

describe("the Account page", () => {
  test("shows the owner and sets the password, the two fields agreeing", async () => {
    const app = setup();
    const page = await app.page("/account");
    assert.equal(page.status, 200);
    assert.match(page.body, /This server has no password yet/);
    assert.match(page.body, /aria-current="page"[^>]*>[\s\S]*?Account/);

    const differ = await app.post("/account/password", { password: "a whole new passphrase", passwordAgain: "something else entirely" });
    assert.equal(differ.status, 400);
    const set = await app.post("/account/password", { password: "a whole new passphrase", passwordAgain: "a whole new passphrase" });
    assert.equal(set.status, 303);
    assert.equal(set.headers.get("location"), "/account?done=password-set");
    assert.equal(app.fake.ownerFake.password, "a whole new passphrase");
    assert.match((await app.page("/account?done=password-set")).body, /Sign in with the new password from now on/);
  });

  test("needs a session", async () => {
    const res = await setup().get("/account", { token: null });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/sign-in?next=%2Faccount");
  });
});
