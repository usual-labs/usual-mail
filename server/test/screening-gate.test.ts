// The server's own check at the screening gate (src/ai/gate.ts, gate-evidence.ts; docs/contract-ai.md, "Mail is
// untrusted input to a model"): for each kind of mail that may skip Screening, mail that passes, and look-alikes that
// don't: a From domain the provider's checker didn't prove, mail written by a person, a public mail domain or a shared
// platform, no link, no evidence, and a kind the AI's category can't be. Pure: no server.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SCREENING_PASS_CATEGORIES, skippedScreeningLine, type DecidedCategory, type ScreeningPass } from "@usualmail/core";
import { SHIPPED_SUFFIXES } from "../src/avatars/shipped.ts";
import { askableKinds, mayPass, screeningPass, worthAsking, type GateMessage } from "../src/ai/gate.ts";
import { acceptPass, NO_PASS, passRequest } from "../src/ai/pass-prompt.ts";

const SUFFIXES = SHIPPED_SUFFIXES!;

/** Machine-sent mail from a service whose domain the provider's checker proved. */
function mail(subject: string, text: string, extra: Partial<GateMessage> = {}): GateMessage {
  return { subject, text, html: null, automated: true, from: { email: "no-reply@service.example" }, fromVerified: "service.example", ...extra };
}

/** One example of each kind that passes. */
const PASSING: Record<ScreeningPass, { category: DecidedCategory; message: GateMessage }> = {
  code: { category: "otp", message: mail("Your sign-in code", "Your code is 482913. It expires in 10 minutes.") },
  sign_in: { category: "otp", message: mail("Sign in to Quillpad", "Click to sign in: https://service.example/magic/abc") },
  email_confirmation: { category: "otp", message: mail("Confirm your email address", "Confirm your email: https://service.example/confirm?t=1") },
  security: { category: "notification", message: mail("New sign-in to your account", "We noticed a new sign-in from Firefox on Linux. Was this you?") },
  account: { category: "notification", message: mail("Reset your password", "Reset your password here: https://service.example/reset") },
  order: { category: "receipt", message: mail("Your order has shipped", "Order #112-3456789 is on its way. Tracking: 1Z999AA10123456784") },
  booking: { category: "notification", message: mail("Your booking is confirmed", "Booking reference: K9XQ2B. Flight from Berlin, 3 Dec at 10:30.") },
  payment: { category: "notification", message: mail("Payment declined", "Your card ending in 4242 was declined for €12.50.") },
};

describe("each kind passes with the proof, machine-sent mail and its evidence", () => {
  for (const [kind, { category, message }] of Object.entries(PASSING) as Array<[ScreeningPass, (typeof PASSING)[ScreeningPass]]>) {
    test(kind, () => {
      assert.equal(mayPass(kind, message, SUFFIXES), true);
      const chosen = kind === "code" ? null : kind;
      assert.equal(screeningPass(category, chosen, message, SUFFIXES), kind);
      assert.ok(SCREENING_PASS_CATEGORIES[kind].includes(category));
    });
  }

  test("the line an interface shows", () => {
    assert.equal(skippedScreeningLine("sign_in"), "Skipped Screening: a sign-in link");
    assert.equal(skippedScreeningLine("code"), "Skipped Screening: a one-time code");
  });

  test("a link counts among the HTML's own links too", () => {
    const html = mail("Sign in", "", { text: null, html: `<p>Hi,</p><a href="https://service.example/login">Sign in</a>` });
    assert.equal(mayPass("sign_in", html, SUFFIXES), true);
  });

  test("words with a hyphen or none between them: sign-in, signin, log-in, login", () => {
    for (const word of ["sign-in", "signin", "log-in", "login"]) {
      assert.equal(mayPass("sign_in", mail("Hello", `Your ${word} link: https://service.example/x`), SUFFIXES), true, word);
    }
  });
});

describe("look-alikes stay screened", () => {
  test("a From domain the provider's checker didn't prove", () => {
    for (const [kind, { category, message }] of Object.entries(PASSING) as Array<[ScreeningPass, (typeof PASSING)[ScreeningPass]]>) {
      const unproved = { ...message, fromVerified: null };
      assert.equal(mayPass(kind, unproved, SUFFIXES), false, kind);
      assert.equal(screeningPass(category, kind === "code" ? null : kind, unproved, SUFFIXES), null, kind);
      assert.equal(worthAsking(category, unproved, SUFFIXES), false, `${kind}: not even asked`);
    }
  });

  test("a proved domain that isn't the From address's own", () => {
    const other = mail("New sign-in", "A new sign-in. Was this you?", { fromVerified: "mailer.example" });
    assert.equal(mayPass("security", other, SUFFIXES), false);
  });

  test("mail that looks written by a person", () => {
    for (const [kind, { message }] of Object.entries(PASSING) as Array<[ScreeningPass, (typeof PASSING)[ScreeningPass]]>) {
      assert.equal(mayPass(kind, { ...message, automated: false }, SUFFIXES), false, kind);
    }
  });

  test("a public mail domain or a shared platform, even proved and machine-sent", () => {
    const webmail = mail("New sign-in", "A new sign-in. Was this you?", { from: { email: "no-reply@yahoo.example" }, fromVerified: "yahoo.example" });
    assert.equal(mayPass("security", webmail, SUFFIXES), false, "anyone can sign up to it");
    const platform = mail("New sign-in", "A new sign-in. Was this you?", { from: { email: "writer@substack.com" }, fromVerified: "substack.com" });
    assert.equal(mayPass("security", platform, SUFFIXES), false, "its customers share its domain");
  });

  test("a server without the Public Suffix List proves nothing", () => {
    assert.equal(mayPass("code", PASSING.code.message, null), false);
    assert.equal(screeningPass("otp", null, PASSING.code.message, null), null);
  });

  test("a sign-in, confirmation or reset without a link", () => {
    assert.equal(mayPass("sign_in", mail("Sign in to Quillpad", "Open the app to sign in."), SUFFIXES), false);
    assert.equal(mayPass("email_confirmation", mail("Confirm your email", "Please confirm your email address."), SUFFIXES), false);
    assert.equal(mayPass("account", mail("Reset your password", "Reset your password in the app."), SUFFIXES), false);
  });

  test("words that name no kind's evidence", () => {
    const sale = mail("Black Friday: 40% off everything", "Our biggest sale. Shop now at https://service.example/sale");
    for (const kind of ["sign_in", "email_confirmation", "security", "account", "order", "booking", "payment"] as const) {
      assert.equal(mayPass(kind, sale, SUFFIXES), false, kind);
    }
    assert.equal(mayPass("order", mail("Your order", "Thanks for shopping with us."), SUFFIXES), false, "an order with no number or amount");
    assert.equal(mayPass("payment", mail("Payment", "About your payment."), SUFFIXES), false, "a payment with no amount or card");
    assert.equal(mayPass("booking", mail("Your booking", "Thanks for booking with us."), SUFFIXES), false, "a booking with no reference, amount or day");
    assert.equal(mayPass("code", mail("Your code", "Your code is 4821."), SUFFIXES), false, "four digits isn't a code");
  });

  test("an ordinary word isn't a reference: it needs a digit and capitals", () => {
    assert.equal(mayPass("order", mail("Order update", "Your order confirmation follows soon."), SUFFIXES), false);
    assert.equal(mayPass("order", mail("Order update", "Your order ab12345 is ready."), SUFFIXES), false, "lower case");
  });

  test("a kind the category can't be: never an invoice, and a sign-in link the AI called a newsletter", () => {
    assert.equal(screeningPass("invoice", "payment", mail("Payment due", "Pay €120.00 by 3 Dec."), SUFFIXES), null);
    assert.equal(screeningPass("newsletter", "sign_in", PASSING.sign_in.message, SUFFIXES), null);
    assert.equal(screeningPass("receipt", "security", PASSING.security.message, SUFFIXES), null);
    assert.deepEqual(askableKinds("invoice"), []);
    assert.deepEqual(askableKinds("newsletter"), []);
    assert.deepEqual(askableKinds("conversation"), []);
  });

  test("the model's kind must pass the check too: a security alert with no security words isn't one", () => {
    assert.equal(screeningPass("notification", "security", PASSING.order.message, SUFFIXES), null);
  });
});

describe("whether the question is worth asking", () => {
  test("a code that passes needs no question; a category no kind may be is never asked about", () => {
    assert.equal(worthAsking("otp", PASSING.code.message, SUFFIXES), false);
    assert.equal(worthAsking("newsletter", PASSING.security.message, SUFFIXES), false);
  });

  test("asked when one of the category's kinds shows its evidence", () => {
    assert.equal(worthAsking("otp", PASSING.sign_in.message, SUFFIXES), true);
    assert.equal(worthAsking("notification", PASSING.security.message, SUFFIXES), true);
    assert.equal(worthAsking("receipt", PASSING.order.message, SUFFIXES), true);
  });

  test("not asked when no kind of the category shows evidence", () => {
    assert.equal(worthAsking("notification", mail("Weekly update", "Here is what happened this week."), SUFFIXES), false);
  });
});

describe("the question", () => {
  const input = { subject: "Sign in", from: { name: "Quillpad", email: "no-reply@service.example" }, listId: null, automated: true, text: "Sign in: https://service.example/x", html: null };

  test("offers the category's kinds, then none, with exactly what categorizing sent", () => {
    const request = passRequest("fake/categorize", input, "otp", "abc")!;
    assert.deepEqual(request.options.map((option) => option.value), ["sign_in", "email_confirmation", "account", NO_PASS]);
    assert.match(request.data, /"machineSent":true/);
    assert.equal(passRequest("fake/categorize", input, "newsletter", "abc"), null);
  });

  test("accepts only one of its own options, and none is no kind", () => {
    const request = passRequest("fake/categorize", input, "otp", "abc")!;
    assert.equal(acceptPass("sign_in", request), "sign_in");
    assert.equal(acceptPass(NO_PASS, request), null);
    assert.equal(acceptPass("security", request), null, "not offered for a one-time code");
    assert.equal(acceptPass("code", request), null);
    assert.equal(acceptPass(null, request), null);
  });
});
