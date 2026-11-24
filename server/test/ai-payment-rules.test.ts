// The payment details' rules of 2026-11-19's last round (src/ai/payment-dates.ts, payment-party.ts,
// payment-services.ts): a due date read the wrong way round, display text as a party, one name per sender, and the
// payment services' one list. Pure: no model, no store.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkDueDate, dateOrder, DUE_TOLERANCE_DAYS } from "../src/ai/payment-dates.ts";
import { canonicalParty, cutDisplayText, isOneLowercaseWord, orSenderName, samePartyForm } from "../src/ai/payment-party.ts";
import { isPaymentService, PAYMENT_SERVICE_LIST } from "../src/ai/payment-services.ts";
import { checkDetails, combineDetails, senderParty } from "../src/ai/payment.ts";
import { PAYMENT_SERVICES } from "../src/ai/prompt.ts";

const at = (iso: string) => Date.parse(`${iso}T10:00:00Z`);
const one = (text: string, sent: string) => [{ text, at: at(sent) }];

describe("a due date and the message it was read from", () => {
  test("is kept when it doesn't lie before its message", () => {
    const text = "Rechnung vom 05.11.2026, zahlbar bis 30.11.2026.";
    assert.deepEqual(checkDueDate("2026-11-30", text, one(text, "2026-11-05")), { dueDate: "2026-11-30", swapped: false });
  });

  test("read day and month the other way round when the model's reading lies before its message", () => {
    const text = "Bestellung vom 05.11.2026. Bitte zahlen Sie bis 07/11/2026.";
    assert.deepEqual(checkDueDate("2026-07-11", text, one(text, "2026-11-05")), { dueDate: "2026-11-07", swapped: true });
  });

  test("dropped when neither reading lies after its message", () => {
    const text = "Your invoice was due on 15/10/2026. Please pay now.";
    assert.deepEqual(checkDueDate("2026-10-15", text, one(text, "2026-11-05")), { dropped: "before_message" });
    const both = "Overdue since 03/04/2026.";
    assert.deepEqual(checkDueDate("2026-03-04", both, one(both, "2026-11-05")), { dropped: "before_message" }, "4 March and 3 April are both past");
  });

  test(`a tolerance of ${DUE_TOLERANCE_DAYS} days: due today or yesterday stands, three days before doesn't`, () => {
    const text = "Payment was due on 2026-11-04.";
    assert.deepEqual(checkDueDate("2026-11-04", text, one(text, "2026-11-05")), { dueDate: "2026-11-04", swapped: false });
    const late = "Payment was due on 2026-11-02.";
    assert.deepEqual(checkDueDate("2026-11-02", late, one(late, "2026-11-05")), { dropped: "before_message" });
  });

  test("when both readings are ahead, the one that follows the mail's other dates; without any, the model's", () => {
    const dayFirst = "Rechnungsdatum 21.10.2026. Fällig am 03/12/2026.";
    assert.deepEqual(checkDueDate("2026-03-12", dayFirst, one(dayFirst, "2026-01-05")), { dueDate: "2026-12-03", swapped: true });
    const named = "Invoice of 21 Oct 2026, due 03/12/2026.";
    assert.deepEqual(checkDueDate("2026-03-12", named, one(named, "2026-01-05")), { dueDate: "2026-12-03", swapped: true });
    const monthFirst = "Invoice date 10/21/2026, due 03/12/2026.";
    assert.deepEqual(checkDueDate("2026-12-03", monthFirst, one(monthFirst, "2026-01-05")), { dueDate: "2026-03-12", swapped: true });
    const neither = "Due 03/12/2026.";
    assert.deepEqual(checkDueDate("2026-03-12", neither, one(neither, "2026-01-05")), { dueDate: "2026-03-12", swapped: false });
  });

  test("the message it was read from is the earliest that writes it; the subject carries the thread's first date", () => {
    const sources = [{ text: "Invoice due 30 November", at: at("2026-11-01") }, { text: "Reminder: still open.", at: at("2026-12-10") }];
    assert.deepEqual(checkDueDate("2026-11-30", sources.map((s) => s.text).join("\n"), sources), { dueDate: "2026-11-30", swapped: false });
  });

  test("the mail's way of writing dates", () => {
    assert.deepEqual(["21.11.2026", "11/21/2026", "21 Nov", "Nov 21st", "03/04/2026", "21.11.2026 and Nov 3"].map(dateOrder), ["day", "month", "day", "month", null, null]);
  });

  test("checkDetails uses it when it has the messages' dates", () => {
    const text = "Bitte zahlen Sie bis 07/11/2026.";
    const answer = { dueDate: "2026-07-11", refund: false };
    assert.equal(checkDetails(answer, text, "invoice").checked.dueDate, "2026-07-11", "without dates, as before");
    const checked = checkDetails(answer, text, "invoice", one(text, "2026-11-05"));
    assert.deepEqual([checked.checked.dueDate, checked.swapped, checked.drops], ["2026-11-07", true, []]);
  });
});

describe("a party that is display text", () => {
  test("is cut at the first separator when two letters are left, else falls back to the sender's name", () => {
    assert.equal(cutDisplayText("Hetzner Online | Rechnung"), "Hetzner Online");
    assert.equal(cutDisplayText("Spotify — Premium · Family"), "Spotify");
    assert.equal(cutDisplayText("X | Invoice"), null);
    assert.equal(cutDisplayText("Rhein-Main Energie"), "Rhein-Main Energie", "a hyphen inside a name isn't a separator");
    const { checked, drops } = checkDetails({ party: "X – Your invoice", refund: false }, "text");
    assert.deepEqual([checked.party, drops], [null, [{ field: "party", reason: "display_text" }]]);
    assert.equal(checkDetails({ party: "Hetzner Online GmbH | Rechnung", refund: false }, "text").checked.party, "Hetzner Online");
    assert.equal(senderParty("Lumen Outdoor GmbH – Kundenservice"), "Lumen Outdoor", "the sender's name is cleaned the same way");
  });
});

describe("a party that is one lowercase word (a district left from an earlier cut, 2026-11-19)", () => {
  test("is one word in lower case only", () => {
    for (const name of ["nordend", "altstadt", "e-bike", "zalando", "straße"]) assert.equal(isOneLowercaseWord(name), true, name);
    for (const name of ["Nordend", "nord end", "nordend GmbH", "NORDEND", "x1", "", "a"]) assert.equal(isOneLowercaseWord(name), false, name);
  });

  test("gives way to the sender's display name, cleaned the same way; stays when there is none", () => {
    assert.equal(orSenderName("nordend", senderParty("Frischmarkt Nordend GmbH – Kundenservice")), "Frischmarkt Nordend");
    assert.equal(orSenderName("nordend", null), "nordend", "no usable name: as it is, never blank");
    assert.equal(orSenderName("nordend", senderParty("nordend | Shop")), "nordend", "a sender's name that is itself display text is no name");
    assert.equal(orSenderName("Fernsafe", "Other Name"), "Fernsafe", "a real name stays");
  });

  test("a brand that writes itself in lower case, whose sender's name is the same word, stays: no loop, no blank", () => {
    const name = senderParty("zalando");
    assert.equal(name, "zalando");
    assert.equal(orSenderName("zalando", name), "zalando");
    assert.equal(orSenderName(orSenderName("zalando", name), name), "zalando");
  });

  test("an answer's party that is one lowercase word takes the sender's name when the details are combined", () => {
    const checked = { party: "nordend", amount: null, refund: false, state: null, dueDate: null, what: null };
    assert.equal(combineDetails(null, checked, "Frischmarkt Nordend").party, "Frischmarkt Nordend");
    assert.equal(combineDetails(null, checked, null).party, "nordend");
    assert.equal(combineDetails({ ...checked, party: "altstadt" }, { ...checked, party: null }, "Frischmarkt").party, "Frischmarkt", "an earlier one too");
  });
});

describe("one name per sender", () => {
  test("names differing only by a domain ending become the form without it; a name's start at a word boundary wins", () => {
    assert.equal(samePartyForm("Amazon.de", "Amazon"), "Amazon");
    assert.equal(samePartyForm("Amazon", "amazon.de"), "Amazon");
    assert.equal(samePartyForm("Amazon.de", "Amazon.com"), "Amazon");
    assert.equal(samePartyForm("Fernsafe Digital", "Fernsafe"), "Fernsafe");
    assert.equal(samePartyForm("Fernsafe", "Fernsafer"), null, "not at a word boundary");
    assert.equal(samePartyForm("Lumen Outdoor", "Kestrel Roasters"), null);
    assert.equal(samePartyForm("A", "A Shop"), null, "too short to stand for a name");
    assert.equal(canonicalParty("Fernsafe Digital", ["Amazon", "Fernsafe"]), "Fernsafe");
    assert.equal(canonicalParty("Hetzner", ["Hetzner Online"]), "Hetzner");
  });
});

describe("payment services", () => {
  test("one list for the request's words and the server's rules", () => {
    const names = PAYMENT_SERVICE_LIST.map((service) => service.name);
    assert.ok(names.includes("Paddle") && names.includes("FastSpring"));
    assert.equal(PAYMENT_SERVICES, `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);
  });

  test("their senders are known by their domains' labels", () => {
    for (const address of ["service@paypal.de", "receipts@stripe.com", "noreply@email.apple.com", "billing@paddle.com", "orders@fastspring.com"]) {
      assert.equal(isPaymentService(address), true, address);
    }
    for (const address of ["orders@shop.example", "mail@notpaypal.example", "info@paddlesports.example"]) assert.equal(isPaymentService(address), false, address);
  });
});
