// Where the money stands (`PaymentDetails.state`, the owner's decision of 2026-11-19), and the last follow-ups to one
// name per sender: what the server keeps of a model's state, how it settles the due date with it, how a once-more
// answer fills what was missing without overwriting, a display text cut to a district, and which senders share a name.
// Pure: no model, no store.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PaymentDetails } from "@usualmail/core";
import { cutDisplayText } from "../src/ai/payment-party.ts";
import { senderKey } from "../src/ai/payment-store.ts";
import { checkDetails, combineDetails, fillDetails, servedPayment, settleDetails } from "../src/ai/payment.ts";
import { SuffixList } from "../src/avatars/suffixes.ts";

const TEXT = "Invoice 12: 49.00 EUR. Please pay by 30 November 2026. Paid? Your card will be charged on 30 November 2026.";
const details = (fields: Partial<PaymentDetails>): PaymentDetails => ({ party: null, amount: null, refund: false, state: null, dueDate: null, what: null, ...fields });

describe("the state a model gives", () => {
  test("is one of paid, scheduled or due, in any case, else nothing", () => {
    for (const [given, kept] of [["paid", "paid"], [" Scheduled ", "scheduled"], ["DUE", "due"], [null, null]] as const) {
      const { checked, drops } = checkDetails({ state: given, refund: false }, TEXT, "invoice");
      assert.deepEqual([checked.state, drops], [kept, []], String(given));
    }
    const { checked, drops } = checkDetails({ state: "overdue", refund: false }, TEXT, "invoice");
    assert.deepEqual([checked.state, drops], [null, [{ field: "state", reason: "unknown_state" }]]);
  });

  test("a refund is paid, whatever the model says, and carries no date", () => {
    const { checked, drops } = checkDetails({ state: "due", refund: true, dueDate: "2026-11-30" }, TEXT, "receipt");
    assert.deepEqual([checked.state, checked.refund, checked.dueDate, drops], ["paid", true, null, [{ field: "dueDate", reason: "paid" }]]);
  });

  test("a date only while money is still to move: dropped when paid, kept when scheduled or due, on either category", () => {
    const date = (state: string | null, category: "receipt" | "invoice") => checkDetails({ state, refund: false, dueDate: "2026-11-30" }, TEXT, category);
    assert.deepEqual([date("paid", "invoice").checked.dueDate, date("paid", "invoice").drops], [null, [{ field: "dueDate", reason: "paid" }]]);
    assert.equal(date("due", "receipt").checked.dueDate, "2026-11-30", "an order bought on invoice, filed as a receipt");
    assert.equal(date("scheduled", "receipt").checked.dueDate, "2026-11-30");
    assert.equal(date("scheduled", "invoice").checked.dueDate, "2026-11-30");
    assert.equal(date(null, "invoice").checked.dueDate, "2026-11-30", "an invoice's unknown state reads as to be paid");
    assert.deepEqual(date(null, "receipt").drops, [{ field: "dueDate", reason: "paid" }], "a receipt's unknown state reads as paid");
    assert.equal(date("paid", "invoice").checked.state, "paid", "an invoice already charged stays filed as an invoice");
  });
});

describe("settling and combining", () => {
  test("a new state wins, a missing one keeps the old, and a paid state takes the date away", () => {
    const before = details({ party: "Shop", state: "due", dueDate: "2026-11-30" });
    assert.deepEqual(combineDetails(before, details({}), null), before);
    assert.deepEqual(settleDetails(combineDetails(before, details({ state: "paid" }), null), "invoice"), { ...before, state: "paid", dueDate: null });
    assert.deepEqual(settleDetails(details({ refund: true, state: "due", dueDate: "2026-11-30" }), "receipt"), details({ refund: true, state: "paid" }));
  });

  test("an older row without a state is served with none", () => {
    const old = { party: "Shop", amount: null, refund: false, dueDate: null, what: null } as unknown as PaymentDetails;
    assert.deepEqual(servedPayment(old), details({ party: "Shop" }));
  });
});

describe("asked once more for the state, an answer fills what is missing and overwrites nothing", () => {
  const stored = details({ party: "Lumen Outdoor", what: "Winter boots" });

  test("the state comes from the answer; a missing amount is filled; a party or what already there stays", () => {
    const answer = details({ party: "Lumen Outdoor Shop", amount: { minor: 4900, currency: "EUR" }, state: "due", what: "Boots" });
    assert.deepEqual(fillDetails(stored, answer), details({ party: "Lumen Outdoor", amount: { minor: 4900, currency: "EUR" }, state: "due", what: "Winter boots" }));
  });

  test("a date follows the new state: filled when it is due, never kept when it is paid", () => {
    assert.equal(settleDetails(fillDetails(stored, details({ state: "due", dueDate: "2026-11-30" })), "receipt").dueDate, "2026-11-30");
    const dated = details({ ...stored, dueDate: "2026-11-30" });
    assert.equal(settleDetails(fillDetails(dated, details({ state: "paid" })), "invoice").dueDate, null);
    assert.equal(settleDetails(fillDetails(dated, details({ state: "scheduled", dueDate: "2026-12-02" })), "invoice").dueDate, "2026-11-30", "a date already there stays");
  });

  test("an amount already there stays, with its refund", () => {
    const refunded = details({ amount: { minor: 1200, currency: "EUR" }, refund: true, state: "paid" });
    assert.deepEqual(fillDetails(refunded, details({ amount: { minor: 5000, currency: "EUR" }, state: "due" })).amount, { minor: 1200, currency: "EUR" });
  });
});

describe("a display text cut to a single lowercase word", () => {
  test("is a district, not a name: the sender's name stands in", () => {
    assert.equal(cutDisplayText("nordend – Frischmarkt"), null);
    assert.equal(cutDisplayText("altstadt | Bäckerei Korn"), null);
    assert.equal(cutDisplayText("Frischmarkt – nordend"), "Frischmarkt");
    assert.equal(cutDisplayText("Nordend Markt | Rechnung"), "Nordend Markt");
    assert.equal(cutDisplayText("frischmarkt"), "frischmarkt", "without a separator a name stands as it is");
  });
});

describe("which senders share a name", () => {
  const list = new SuffixList({ icann: ["example", "co.example"], private: [] });

  test("by the domain after the @, by its registrable domain when the server has the list", () => {
    assert.equal(senderKey("orders@shop.example", null), "shop.example");
    assert.equal(senderKey("billing@mail.shop.example", null), "mail.shop.example", "without the list, the exact domain");
    assert.equal(senderKey("billing@mail.shop.example", list), "shop.example");
    assert.equal(senderKey("billing@mail.shop.co.example", list), "shop.co.example");
  });

  test("a free mailbox's or a shared platform's senders are people, each on their own address", () => {
    assert.equal(senderKey("anna@gmail.com", null), "anna@gmail.com");
    assert.equal(senderKey("shop@outlook.de", list), "shop@outlook.de");
    assert.equal(senderKey("news@writer.substack.com", null), "news@writer.substack.com");
  });

  test("a payment service's mail shares no name", () => {
    assert.equal(senderKey("service@paypal.example", null), null);
  });
});
