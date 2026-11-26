// The server's own check at the screening gate (src/ai/gate.ts, gate-shape.ts, gate-evidence.ts; docs/contract-ai.md,
// "A model's answer at the screening gate"): for each kind of mail that may skip Screening, mail that passes, and
// look-alikes that don't: a From domain the provider's checker didn't prove, mail written by a person, a public mail
// domain or a shared platform, no link, no evidence, a kind the AI's category can't be; and the shape of mail sent to
// this person by that organisation alone (no List-Id, Reply-To at home, addressed to the inbox, no tenant platform),
// which a platform carrying someone else's words or a replayed alert doesn't have. IMAP's codes pass without proof.
// Every pattern stays fast on a 1 MB body. Pure: no server.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SCREENING_PASS_CATEGORIES, skippedScreeningLine, type DecidedCategory, type ScreeningPass } from "@usualmail/core";
import { SHIPPED_SUFFIXES } from "../src/avatars/shipped.ts";
import { addressedTo, mailboxKey } from "../src/ai/gate-shape.ts";
import { askableKinds, gateCheck, type GateContext, type GateMessage } from "../src/ai/gate.ts";
import { acceptPass, NO_PASS, passRequest } from "../src/ai/pass-prompt.ts";
import { BODIES, within } from "./linear.ts";

const SUFFIXES = SHIPPED_SUFFIXES!;
const INBOX = "me@inbox.example";
const GMAIL: GateContext = { suffixes: SUFFIXES, inbox: { address: INBOX, provider: "gmail" } };
const IMAP: GateContext = { suffixes: SUFFIXES, inbox: { address: INBOX, provider: "imap" } };

/** Machine-sent mail from a service whose domain the provider's checker proved, sent to the inbox alone. */
function mail(subject: string, text: string, extra: Partial<GateMessage> = {}): GateMessage {
  return {
    subject, text, html: null, automated: true, from: { email: "no-reply@service.example" }, fromVerified: "service.example",
    to: [{ email: INBOX }], cc: [], replyTo: null, listId: null, signedRecipients: ["to"], ...extra,
  };
}

const passes = (kind: ScreeningPass, message: GateMessage, context = GMAIL) => gateCheck(message, context).mayPass(kind);

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
const EACH = Object.entries(PASSING) as Array<[ScreeningPass, (typeof PASSING)[ScreeningPass]]>;

describe("each kind passes with the proof, machine-sent mail, its shape and its evidence", () => {
  for (const [kind, { category, message }] of EACH) {
    test(kind, () => {
      assert.equal(passes(kind, message), true);
      assert.equal(gateCheck(message, GMAIL).pass(category, kind === "code" ? null : kind), kind);
      assert.ok(SCREENING_PASS_CATEGORIES[kind].includes(category));
    });
  }

  test("the line an interface shows", () => {
    assert.equal(skippedScreeningLine("sign_in"), "Skipped Screening: a sign-in link");
    assert.equal(skippedScreeningLine("code"), "Skipped Screening: a one-time code");
  });

  test("a link counts among the HTML's own links too", () => {
    assert.equal(passes("sign_in", mail("Sign in", "", { text: null, html: `<p>Hi,</p><a href="https://service.example/login">Sign in</a>` })), true);
  });

  test("words with a hyphen or none between them: sign-in, signin, log-in, login", () => {
    for (const word of ["sign-in", "signin", "log-in", "login"]) {
      assert.equal(passes("sign_in", mail("Hello", `Your ${word} link: https://service.example/x`)), true, word);
    }
  });

  test("a payment by a card's last digits alone, a booking by its day alone", () => {
    assert.equal(passes("payment", mail("Card charged", "Your card •••• 4242 was charged.")), true, "no amount, a card");
    assert.equal(passes("booking", mail("Your appointment", "Your appointment is on 3 Dec.")), true, "no reference or amount, a day");
    assert.equal(passes("booking", mail("Your appointment", "Your appointment is at 10:30.")), true, "a time");
  });
});

describe("look-alikes stay screened", () => {
  test("a From domain the provider's checker didn't prove", () => {
    for (const [kind, { category, message }] of EACH) {
      const unproved = { ...message, fromVerified: null };
      assert.equal(passes(kind, unproved), false, kind);
      assert.equal(gateCheck(unproved, GMAIL).pass(category, kind === "code" ? null : kind), null, kind);
      assert.equal(gateCheck(unproved, GMAIL).worthAsking(category), false, `${kind}: not even asked`);
    }
  });

  test("a proved domain that isn't the From address's own", () => {
    assert.equal(passes("security", mail("New sign-in", "A new sign-in. Was this you?", { fromVerified: "mailer.example" })), false);
  });

  test("mail that looks written by a person", () => {
    for (const [kind, { message }] of EACH) assert.equal(passes(kind, { ...message, automated: false }), false, kind);
  });

  test("a public mail domain or a shared platform, even proved and machine-sent", () => {
    const webmail = mail("New sign-in", "A new sign-in. Was this you?", { from: { email: "no-reply@yahoo.example" }, fromVerified: "yahoo.example" });
    assert.equal(passes("security", webmail), false, "anyone can sign up to it");
    const platform = mail("New sign-in", "A new sign-in. Was this you?", { from: { email: "no_such_writer@substack.com" }, fromVerified: "substack.com" });
    assert.equal(passes("security", platform), false, "its customers share its domain");
  });

  test("a server without the Public Suffix List proves nothing on Gmail", () => {
    const bare = { ...GMAIL, suffixes: null };
    for (const [kind, { message }] of EACH) assert.equal(passes(kind, message, bare), false, kind);
  });

  test("a sign-in, confirmation or reset without a link", () => {
    assert.equal(passes("sign_in", mail("Sign in to Quillpad", "Open the app to sign in.")), false);
    assert.equal(passes("email_confirmation", mail("Confirm your email", "Please confirm your email address.")), false);
    assert.equal(passes("account", mail("Reset your password", "Reset your password in the app.")), false);
  });

  test("words that name no kind's evidence", () => {
    const sale = mail("Black Friday: 40% off everything", "Our biggest sale. Shop now at https://service.example/sale");
    for (const kind of askableKinds("notification")) assert.equal(passes(kind, sale), false, kind);
    assert.equal(passes("order", mail("Your order", "Thanks for shopping with us.")), false, "an order with no number or amount");
    assert.equal(passes("payment", mail("Payment", "About your payment.")), false, "a payment with no amount or card");
    assert.equal(passes("booking", mail("Your booking", "Thanks for booking with us.")), false, "a booking with no reference, amount or day");
    assert.equal(passes("code", mail("Your code", "Your code is 4821.")), false, "four digits isn't a code");
  });

  test("an ordinary word isn't a reference: it needs a digit and capitals", () => {
    assert.equal(passes("order", mail("Order update", "Your order confirmation follows soon.")), false);
    assert.equal(passes("order", mail("Order update", "Your order ab12345 is ready.")), false, "lower case");
  });

  test("a kind the category can't be: never an invoice, and a sign-in link the AI called a newsletter", () => {
    assert.equal(gateCheck(mail("Payment due", "Pay €120.00 by 3 Dec."), GMAIL).pass("invoice", "payment"), null);
    assert.equal(gateCheck(PASSING.sign_in.message, GMAIL).pass("newsletter", "sign_in"), null);
    assert.equal(gateCheck(PASSING.security.message, GMAIL).pass("receipt", "security"), null);
    for (const category of ["invoice", "newsletter", "conversation"] as const) assert.deepEqual(askableKinds(category), [], category);
  });

  test("the model's kind must pass the check too: an order isn't a security alert", () => {
    assert.equal(gateCheck(PASSING.order.message, GMAIL).pass("notification", "security"), null);
  });
});

describe("the shape of mail sent to this person by that organisation alone (every kind but a code)", () => {
  const ALERT = PASSING.security.message;

  test("(a) a List-Id: a mention in a project's notifications", () => {
    const mention = mail("[acme/app] Security alert: new sign-in (#42)", "@you was this you? A new sign-in on the staging box.", {
      from: { email: "notifications@github.example" }, fromVerified: "github.example", listId: "app.acme.github.example",
    });
    assert.equal(passes("security", mention), false);
    assert.equal(gateCheck(mention, GMAIL).worthAsking("notification"), false, "not even asked");
  });

  test("(b) a Reply-To elsewhere: a comment on a shared document, a money request", () => {
    const comment = mail("New comment on Q4 plan", "Security alert: your account shows suspicious activity, was this you? Reply to me.", {
      from: { email: "comments-noreply@docs.platform.example" }, fromVerified: "docs.platform.example", replyTo: [{ email: "stranger@elsewhere.example" }],
    });
    assert.equal(passes("security", comment), false);
    const request = mail("Sam requested €450.00 from you", "Payment request: €450.00. Note: rent for December, pay today.", {
      from: { email: "service@pay.example" }, fromVerified: "pay.example", replyTo: [{ email: "sam@stranger.example" }],
    });
    assert.equal(passes("payment", request), false);
    const home = { ...ALERT, replyTo: [{ email: "help@support.service.example" }] };
    assert.equal(passes("security", home), true, "a Reply-To at the same organisation's own domain is fine");
  });

  test("(c) not addressed to the inbox: an alert replayed by Bcc, or sent to someone else", () => {
    assert.equal(passes("security", { ...ALERT, to: [{ email: "attacker@elsewhere.example" }] }), false);
    assert.equal(passes("security", { ...ALERT, to: [] }), false, "undisclosed recipients");
    assert.equal(passes("code", { ...PASSING.code.message, to: [{ email: "someone@elsewhere.example" }] }), false, "codes too");
    const inCc = { ...ALERT, to: [{ email: "list@elsewhere.example" }], cc: [{ email: "ME@Inbox.Example" }] };
    assert.equal(passes("security", { ...inCc, signedRecipients: ["to", "cc"] }), true, "in a signed Cc, any case");
  });

  test("(c) on Gmail, only a field the sender's signature vouches for: a replay with a To or Cc added on top", () => {
    const added = { ...ALERT, to: [{ email: "attacker@elsewhere.example" }], cc: [{ email: INBOX }], signedRecipients: ["to"] as const };
    assert.equal(passes("security", added), false, "a Cc added after signing");
    assert.equal(passes("security", { ...ALERT, signedRecipients: [] }), false, "To given twice: nothing vouched for");
    assert.equal(passes("security", { ...ALERT, signedRecipients: null }), false, "not read");
    assert.equal(passes("code", { ...PASSING.code.message, signedRecipients: [] }), false, "codes too");
    assert.equal(passes("code", { ...PASSING.code.message, fromVerified: null, signedRecipients: null }, IMAP), true, "IMAP reads To and Cc as they are");
  });

  test("(c) a +tag is the inbox's own address, and so are dots at gmail.com", () => {
    assert.equal(passes("security", { ...ALERT, to: [{ email: "me+bank@inbox.example" }] }), true);
    assert.equal(mailboxKey("A.b.C+shop@googlemail.com"), "abc@gmail.com");
    assert.equal(mailboxKey("a.b.c@work.example"), "a.b.c@work.example", "dots count elsewhere");
    assert.equal(addressedTo({ to: [{ email: "abc+x@gmail.com" }], cc: [] }, "a.b.c@gmail.com"), true);
    assert.equal(addressedTo({ to: [{ email: "not an address" }], cc: [] }, INBOX), false);
  });

  test("(d) a help desk's or a tool's tenant on its platform", () => {
    for (const platform of ["zendesk.com", "atlassian.net", "freshdesk.com", "helpscoutapp.com", "service-now.com", "intercom-mail.com", "my.salesforce.com", "gitbook.io", "notion.site"]) {
      // "ab--cd" is a reserved DNS label (RFC 5891), so no tenant has it.
      const domain = `ab--cd.${platform}`;
      const desk = mail("New sign-in to your account", "A new sign-in. Was this you?", { from: { email: `no_reply_sample@${domain}` }, fromVerified: domain });
      assert.equal(passes("security", desk), false, domain);
    }
  });

  test("(e) notifiers whose mail carries their users' words, sent to the person, no Reply-To", () => {
    const notice = (email: string, kind: ScreeningPass, subject: string, text: string) => {
      const domain = email.split("@")[1]!;
      return passes(kind, mail(subject, text, { from: { email }, fromVerified: domain }));
    };
    assert.equal(notice("comments-noreply@docs.google.com", "security", "Sam mentioned you", "Security alert: suspicious activity, was this you?"), false, "a document's mention");
    assert.equal(notice("drive-shares-dm-noreply@google.com", "account", "Sam shared a file", "Reset your password here: https://x.example/r"), false, "a file shared");
    assert.equal(notice("calendar-notification@google.com", "booking", "Booking confirmed: call 555 0100", "Your booking is on 3 Dec at 10:30."), false, "an event someone titled");
    assert.equal(notice("service@paypal.com", "payment", "Sam requested €450.00", "Payment request: €450.00, rent."), false, "a money request");
    assert.equal(notice("service@intl.paypal.com", "security", "New sign-in", "A new sign-in. Was this you?"), false, "the same address's alerts too");
    assert.equal(notice("receipts+abc@stripe.com", "order", "Receipt from Sam's shop", "Order #112-3456789: €42.00. Call 555 0100."), false, "a payment service's receipt");
    assert.equal(notice("no-reply@google.com", "security", "Security alert", "A new sign-in. Was this you?"), false, "any other Google notifier");
    assert.equal(notice("no-reply@groups.google.com", "account", "Your plan changed", "Your plan has changed."), false, "a Google subdomain's");
    assert.equal(notice("no-reply@teams.microsoft.com", "security", "New sign-in", "A new sign-in. Was this you?"), false, "a Microsoft product's");
    assert.equal(notice("no-reply@security.google.com", "security", "Security alert", "A new sign-in. Was this you?"), false, "Google's own alerts wait too");
    // Social, messaging and community notifiers quote their users' posts, comments and messages (the final review).
    for (const email of ["notification@facebookmail.com", "messages-noreply@linkedin.com", "info@x.com", "notify@twitter.com", "no-reply@mail.instagram.com", "noreply@discord.com", "feedback@slack.com", "noreply@whatsapp.com", "noreply@telegram.org", "noreply@redditmail.com", "digest-noreply@quora.com", "noreply@medium.com", "info@meetup.com", "notifications@github.com"]) {
      assert.equal(notice(email, "security", "Unusual sign-in: was this you?", "Sam wrote: we noticed an unusual sign-in. Was this you?"), false, email);
    }
    // The allow list: Microsoft's account team, as Microsoft names it.
    assert.equal(notice("account-security-noreply@accountprotection.microsoft.com", "security", "Unusual sign-in activity", "We detected unusual sign-in activity. Was this you?"), true, "Microsoft's account team's alerts pass");
  });

  test("a security alert says so in its subject, not only in the text, which a notifier may quote", () => {
    assert.equal(passes("security", mail("New sign-in to your account", "We noticed a new sign-in. Was this you?")), true);
    assert.equal(passes("security", mail("Sam replied to your post", "Sam wrote: we noticed a new sign-in. Was this you?")), false);
  });

  test("it reads what the model read: the subject's first 1,000 characters and the text's first 4,000", () => {
    const code = (subject: string, text: string) => passes("code", { ...PASSING.code.message, subject, text });
    assert.deepEqual([code(`${"x".repeat(980)} code 482913`, "Hi."), code(`${"x".repeat(1_000)} code 482913`, "Hi.")], [true, false]);
    assert.deepEqual([code("Hi", `${"x ".repeat(1_990)}code 482913`), code("Hi", `${"x ".repeat(2_000)}code 482913`)], [true, false]);
  });

  test("a code needs only the proof, machine-sent mail, the inbox addressed and the code: not the rest of the shape", () => {
    assert.equal(passes("code", { ...PASSING.code.message, listId: "codes.service.example", replyTo: [{ email: "x@elsewhere.example" }] }), true);
  });
});

describe("an inbox whose provider has no checker (IMAP)", () => {
  test("a code passes without proof, as before 2026-11-25: machine-sent, addressed to the inbox, a code", () => {
    const code = { ...PASSING.code.message, fromVerified: null };
    assert.equal(passes("code", code, IMAP), true);
    assert.equal(gateCheck(code, IMAP).pass("otp", null), "code");
    assert.equal(passes("code", { ...code, automated: false }, IMAP), false, "machine-sent");
    assert.equal(passes("code", { ...code, to: [{ email: "x@elsewhere.example" }] }, IMAP), false, "addressed to the inbox");
    assert.equal(passes("code", mail("Your code", "Your code is 4821.", { fromVerified: null }), IMAP), false, "a code");
  });

  test("nothing else passes there, proved or not", () => {
    for (const [kind, { category, message }] of EACH) {
      if (kind === "code") continue;
      assert.equal(passes(kind, message, IMAP), false, kind);
      assert.equal(gateCheck(message, IMAP).worthAsking(category), false, kind);
    }
  });

  test("Gmail's missing or failed proof never falls back", () => {
    assert.equal(passes("code", { ...PASSING.code.message, fromVerified: null }), false);
  });
});

describe("whether the question is worth asking", () => {
  test("a code that passes needs no question; a category no kind may be is never asked about", () => {
    assert.equal(gateCheck(PASSING.code.message, GMAIL).worthAsking("otp"), false);
    assert.equal(gateCheck(PASSING.security.message, GMAIL).worthAsking("newsletter"), false);
  });

  test("asked when one of the category's kinds shows its evidence", () => {
    assert.equal(gateCheck(PASSING.sign_in.message, GMAIL).worthAsking("otp"), true);
    assert.equal(gateCheck(PASSING.security.message, GMAIL).worthAsking("notification"), true);
    assert.equal(gateCheck(PASSING.order.message, GMAIL).worthAsking("receipt"), true);
  });

  test("not asked when no kind of the category shows evidence", () => {
    assert.equal(gateCheck(mail("Weekly update", "Here is what happened this week."), GMAIL).worthAsking("notification"), false);
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

describe("in linear time on a 1 MB body (the check runs under the server's lock)", () => {
  // Each in a worker that is stopped at 10 seconds, so a slow pattern fails rather than hangs the suite (test/linear.ts).
  for (const name of Object.keys(BODIES)) {
    test(name, { timeout: 15_000 }, async () => {
      const took = await within(10_000, "gate", name);
      assert.ok(took < 3_000, `${name}: ${took.toFixed(0)} ms`);
    });
  }
});
