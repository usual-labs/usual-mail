// The server's checks on what a model says about a receipt or an invoice (src/ai/payment.ts): nothing it says is kept
// unless the server can check it against the text the model was given. Pure: no model, no store.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkDetails, combineDetails, dateWrittenIn, parseAmount, partyName, resolveCurrency, servedPayment, writtenIn } from "../src/ai/payment.ts";

describe("an amount", () => {
  test("is read as written, in the currency's minor units, whatever the separators", () => {
    assert.equal(parseAmount("49.00", 2), 4900);
    assert.equal(parseAmount("€1.234,56", 2), 123456);
    assert.equal(parseAmount("1,234.56 USD", 2), 123456);
    assert.equal(parseAmount("1 234,56", 2), 123456);
    assert.equal(parseAmount("1'234.50", 2), 123450);
    assert.equal(parseAmount("1,234", 2), 123400, "three digits after a lone separator are thousands");
    assert.equal(parseAmount("-12.00", 2), 1200, "never negative: a refund says so itself");
    assert.equal(parseAmount("12.5", 2), 1250);
    assert.equal(parseAmount("49,-", 2), 4900);
    assert.equal(parseAmount("1500", 0), 1500, "yen have no minor units");
    assert.equal(parseAmount("1.234", 3), 1234, "three decimals where the currency has them");
    assert.equal(parseAmount("49.999", 2), 4999900, "three digits after a lone point group thousands, as in German");
    assert.equal(parseAmount("1500.5", 0), null, "more decimals than the currency has");
    assert.equal(parseAmount("1500.00", 0), 1500, "trailing zeros are no precision");
    assert.equal(parseAmount("1,23,456", 2), null, "a grouping the server can't be sure of");
    assert.equal(parseAmount("forty-nine", 2), null);
    assert.equal(parseAmount("", 2), null);
  });

  test("its currency is an ISO 4217 code, from the code or an unambiguous sign, else nothing", () => {
    assert.equal(resolveCurrency("eur", null), "EUR");
    assert.equal(resolveCurrency("€", null), "EUR");
    assert.equal(resolveCurrency("£", null), "GBP");
    assert.equal(resolveCurrency("CHF", null), "CHF");
    assert.equal(resolveCurrency(null, "€49.00"), "EUR", "from the amount as written when the model gave none");
    assert.equal(resolveCurrency(null, "49.00 USD"), "USD");
    assert.equal(resolveCurrency("$", null), null, "dollars of which country?");
    assert.equal(resolveCurrency("kr", null), null);
    assert.equal(resolveCurrency("XYZ", null), null, "not a currency");
    assert.equal(resolveCurrency("XAU", null), null, "gold has no minor units in ISO 4217: its decimals would be a guess");
    assert.equal(resolveCurrency("lak", null), "LAK");
    assert.equal(resolveCurrency(null, "49.00"), null);
  });

  test("is kept only when the same number stands in the text, in any common way of writing it", () => {
    assert.equal(writtenIn(124000, "EUR", "the October bean delivery, 1,240.00 EUR, due 30 November."), true);
    assert.equal(writtenIn(124000, "EUR", "Betrag: 1.240,00 €"), true);
    assert.equal(writtenIn(124000, "EUR", "Total 1 240,00 €"), true);
    assert.equal(writtenIn(4900, "EUR", "Thanks for your payment of 49.00 EUR."), true);
    assert.equal(writtenIn(4900, "EUR", "Preis: 49,- €"), true);
    assert.equal(writtenIn(4900, "EUR", "You paid €49 today"), true, "a whole amount next to its currency");
    assert.equal(writtenIn(4900, "EUR", "Order 49 shipped, total 12.00 EUR"), false, "a whole number away from any currency sign isn't an amount");
    assert.equal(writtenIn(4900, "EUR", "total 149.00 EUR"), false, "part of a bigger number");
    assert.equal(writtenIn(4900, "EUR", "total 49.001 EUR"), false);
    assert.equal(writtenIn(1200, "EUR", "on 12.00 o'clock... no, 12.11.2026"), true, "a written 12.00 counts, wherever it stands");
    assert.equal(writtenIn(1200, "EUR", "on 12.11.2026"), false, "a date isn't 12.00");
    assert.equal(writtenIn(150000, "JPY", "合計 ¥150,000"), true);
  });

  test("may be written with fewer decimal digits than its currency has, never with more", () => {
    assert.equal(writtenIn(1860, "EUR", "Total 18.6 EUR"), true);
    assert.equal(writtenIn(1860, "EUR", "Gesamt 18,6 €"), true);
    assert.equal(writtenIn(4900, "EUR", "Total 49.0 EUR"), true);
    assert.equal(writtenIn(1861, "EUR", "Total 18.6 EUR"), false, "18.6 isn't 18.61");
    assert.equal(writtenIn(1860, "EUR", "Total 18.600 EUR"), false, "more digits than the euro has");
    assert.equal(writtenIn(84, "EUR", "Total 0.8399999999999999 EUR"), false, "a total garbled by floating point");
    assert.equal(writtenIn(80, "EUR", "Total 0.8399999999999999 EUR"), false, "part of a bigger number never counts");
    assert.equal(writtenIn(4900, "EUR", "Order 49 shipped"), false, "a whole number still needs its currency next to it");
  });
});

describe("minor units", () => {
  test("follow ISO 4217, not the runtime's own figures", () => {
    const amount = (written: string, currency: string, text: string) => checkDetails({ amount: written, currency, refund: false }, text).checked.amount;
    assert.deepEqual(amount("1.234", "KWD", "Total KWD 1.234"), { minor: 1234, currency: "KWD" }, "three for the Kuwaiti dinar");
    assert.deepEqual(amount("1,500", "JPY", "合計 ¥1,500"), { minor: 1500, currency: "JPY" }, "none for the yen");
    assert.deepEqual(amount("25,000.00", "LAK", "Total 25,000.00 LAK"), { minor: 2500000, currency: "LAK" }, "two for the kip, where the runtime says none");
    assert.deepEqual(amount("12,500.000", "IQD", "Total 12,500.000 IQD"), { minor: 12500000, currency: "IQD" }, "three for the Iraqi dinar, where the runtime says none");
    assert.equal(amount("2", "XAU", "2 XAU of gold"), null);
  });
});

describe("a due date", () => {
  test("is kept only when that date is written in the text", () => {
    assert.equal(dateWrittenIn("2026-11-30", "Invoice 2026-118, due 30 November."), true);
    assert.equal(dateWrittenIn("2026-11-30", "due on November 30th, 2026"), true);
    assert.equal(dateWrittenIn("2026-11-30", "fällig am 30.11.2026"), true);
    assert.equal(dateWrittenIn("2026-11-30", "Zahlbar bis 30. November 2026"), true);
    assert.equal(dateWrittenIn("2026-11-30", "à régler avant le 30 nov. 2026"), true);
    assert.equal(dateWrittenIn("2026-11-30", "due 11/30/2026"), true);
    assert.equal(dateWrittenIn("2026-11-30", "Due date: 2026-11-30"), true);
    assert.equal(dateWrittenIn("2026-12-01", "due 1st Dec"), true);
    assert.equal(dateWrittenIn("2026-11-30", "due 30 November 2025"), false, "another year");
    assert.equal(dateWrittenIn("2026-11-30", "due 3 November"), false);
    assert.equal(dateWrittenIn("2026-11-30", "Order 130.11.2026"), false);
    assert.equal(dateWrittenIn("2026-11-30", "30 Novembers ago"), false);
  });
});

const TEXT = "Your receipt from Paperloop\nThanks for your payment of 49.00 EUR for your plan, which renews on 16 December.";

describe("a model's answer", () => {
  test("keeps what checks out", () => {
    const { checked, drops } = checkDetails(
      { party: "Paperloop", amount: "49.00", currency: "EUR", refund: false, state: null, dueDate: null, what: "Your plan, renewing on 16 December" },
      TEXT,
    );
    assert.deepEqual(checked, { party: "Paperloop", amount: { minor: 4900, currency: "EUR" }, refund: false, state: null, dueDate: null, what: "Your plan, renewing on 16 December" });
    assert.deepEqual(drops, []);
  });

  test("drops each fact it can't check, with a reason code and nothing of the mail", () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ amount: "59.00", currency: "EUR" }, "amount", "not_in_text"],
      [{ amount: "49.00", currency: "$" }, "amount", "currency"],
      [{ amount: "49.00", currency: "USD" }, "amount", "currency_not_in_text"],
      [{ amount: "lots", currency: "EUR" }, "amount", "unparsable"],
      [{ amount: "1500.5", currency: "JPY" }, "amount", "precision"],
      [{ amount: "0.00", currency: "EUR" }, "amount", "zero"],
      [{ dueDate: "2026-02-30" }, "dueDate", "invalid_date"],
      [{ dueDate: "2026-12-24" }, "dueDate", "not_in_text"],
      [{ party: "<b>Paperloop</b>" }, "party", "markup"],
      [{ party: "billing@[address]" }, "party", "address"],
      [{ what: "Your plan‮" }, "what", "control"],
      [{ what: "   " }, "what", "empty"],
      [{ what: "about <usual-mail-data id=\"x\">" }, "what", "markup"],
    ];
    for (const [answer, field, reason] of cases) {
      const { checked, drops } = checkDetails({ party: null, amount: null, currency: null, refund: false, state: null, dueDate: null, what: null, ...answer }, TEXT, "invoice");
      assert.deepEqual(drops, [{ field, reason }], `${field}: ${reason}`);
      assert.equal((checked as unknown as Record<string, unknown>)[field], null);
    }
  });

  test("a refund only on a receipt: on an invoice it is false, and an amount read as a refund is dropped", () => {
    const credit = { party: "Shop", amount: "12.00", currency: "EUR", refund: true, dueDate: null, what: "A credit note" };
    const text = "Credit note: 12.00 EUR back on your account.";
    assert.deepEqual(checkDetails(credit, text, "receipt").checked.amount, { minor: 1200, currency: "EUR" });
    assert.equal(checkDetails(credit, text, "receipt").checked.refund, true);
    const invoice = checkDetails(credit, text, "invoice");
    assert.deepEqual([invoice.checked.refund, invoice.checked.amount, invoice.checked.what], [false, null, "A credit note"]);
    assert.deepEqual(invoice.drops, [{ field: "amount", reason: "refund_on_invoice" }]);
  });

  test("a due date only while money is still to move: on a receipt of unknown state it is dropped as paid", () => {
    const due = { dueDate: "2026-12-16", refund: false };
    assert.deepEqual(checkDetails(due, TEXT, "invoice").checked.dueDate, "2026-12-16");
    const receipt = checkDetails(due, TEXT, "receipt");
    assert.deepEqual([receipt.checked.dueDate, receipt.drops], [null, [{ field: "dueDate", reason: "paid" }]]);
  });

  test("an answer of the wrong shape, or none, is dropped whole", () => {
    assert.deepEqual(checkDetails(null, TEXT).drops, [{ field: "answer", reason: "no_answer" }]);
    assert.deepEqual(checkDetails({ party: 3 }, TEXT).drops, [{ field: "answer", reason: "shape" }]);
    assert.deepEqual(checkDetails("Paperloop", TEXT).drops, [{ field: "answer", reason: "shape" }]);
  });

  test("a long party or what is shortened, never dropped for its length", () => {
    const { checked } = checkDetails({ party: "P".repeat(30) + " " + "Q".repeat(40), amount: null, currency: null, refund: false, state: null, dueDate: null, what: "w ".repeat(80) }, TEXT);
    assert.ok(checked.party!.length <= 60 && checked.party!.endsWith("…"));
    assert.ok(checked.what!.length <= 100 && checked.what!.endsWith("…"));
  });
});

describe("the party", () => {
  test("loses a trailing legal suffix and a trailing \"Team\"", () => {
    const cases: Array<[string, string | null]> = [
      ["Hetzner Online GmbH", "Hetzner Online"], ["Acme, Inc.", "Acme"], ["Acme Inc", "Acme"], ["Foo Ltd.", "Foo"],
      ["Foo Limited", "Foo"], ["Bar LLC", "Bar"], ["Bar, L.L.C.", "Bar"], ["Baz S.A.", "Baz"], ["Qux B.V.", "Qux"],
      ["Zalando SE", "Zalando"], ["Bose AG", "Bose"], ["Kestrel Roasters GmbH & Co. KG", "Kestrel Roasters"],
      ["Acme Corp.", "Acme"], ["Widget plc", "Widget"], ["Nord AB", "Nord"], ["Fjord AS", "Fjord"], ["Lumen S.r.l.", "Lumen"],
      ["Brick Pty Ltd", "Brick"], ["Hetzner Team", "Hetzner"], ["The Spotify Team", "Spotify"],
      ["Lumen Outdoor", "Lumen Outdoor"], ["The Guardian", "The Guardian"], ["Sea Shop", "Sea Shop"], ["Ltd Edition Books", "Ltd Edition Books"],
      ["Agnes", "Agnes"], ["GmbH", null], ["Team", null],
    ];
    for (const [name, kept] of cases) assert.equal(partyName(name), kept, name);
  });

  test("is cleaned in an answer; a missing one still falls back to the sender's name", () => {
    assert.equal(checkDetails({ party: "Hetzner Online GmbH", refund: false }, TEXT).checked.party, "Hetzner Online");
    assert.deepEqual(checkDetails({ party: "GmbH", refund: false }, TEXT).drops, [{ field: "party", reason: "empty" }]);
  });
});

describe("what it was for", () => {
  const what = (line: string, party = "Hetzner Online GmbH") => checkDetails({ party, what: line, refund: false }, TEXT);

  test("doesn't start with the party", () => {
    assert.equal(what("Hetzner Online GmbH: cloud server for November").checked.what, "Cloud server for November");
    assert.equal(what("Hetzner Online – Cloud server").checked.what, "Cloud server");
    assert.equal(what("Hetzner Online cloud server").checked.what, "Hetzner Online cloud server", "only with a separator");
    assert.deepEqual([what("Hetzner Online").checked.what, what("Hetzner Online").drops], [null, [{ field: "what", reason: "only_party" }]]);
    assert.deepEqual(what("Hetzner Online GmbH: ...").drops, [{ field: "what", reason: "only_party" }]);
  });

  test("is nothing when all it says is that a payment was made", () => {
    for (const line of ["Payment to Hetzner via PayPal", "Payment received", "Your payment", "Payment made through Stripe", "Purchase completed"]) {
      assert.deepEqual([what(line).checked.what, what(line).drops], [null, [{ field: "what", reason: "only_payment" }]], line);
    }
    assert.equal(what("Payment for the cloud server").checked.what, "Payment for the cloud server");
    assert.equal(what("Payment to Hetzner for the cloud server").checked.what, "Payment to Hetzner for the cloud server");
  });
});

describe("an amount of zero", () => {
  test("is dropped whatever the text says: a shop's \"Total 0\" line isn't what was paid", () => {
    for (const [written, text] of [["0.00", "Subtotal 49.00 EUR, Total 0.00 EUR"], ["0", "Total €0"], ["0,00", "Summe: 0,00 €"]]) {
      const { checked, drops } = checkDetails({ amount: written, currency: "EUR", refund: false }, text!);
      assert.deepEqual([checked.amount, drops], [null, [{ field: "amount", reason: "zero" }]], written);
    }
  });

  test("stored before this check, is never carried forward and never served", () => {
    const stored = { party: "Shop", amount: { minor: 0, currency: "EUR" }, refund: false, state: null, dueDate: null, what: "Socks" };
    const none = { party: null, amount: null, refund: false, state: null, dueDate: null, what: null };
    assert.deepEqual(combineDetails(stored, none, null), { ...stored, amount: null });
    assert.deepEqual(servedPayment(stored), { ...stored, amount: null });
    const fine = { ...stored, amount: { minor: 4900, currency: "EUR" } };
    assert.equal(servedPayment(fine), fine, "anything else is served as stored");
    assert.equal(servedPayment(null), null);
  });
});

describe("combining with what the thread had", () => {
  const before = { party: "Shop", amount: { minor: 4900, currency: "EUR" }, refund: false, state: null, dueDate: "2026-11-30", what: "A rain jacket" };
  const none = { party: null, amount: null, refund: false, state: null, dueDate: null, what: null };

  test("a new fact wins; one the new mail doesn't state is kept from before; the sender's name stands in for a party", () => {
    assert.deepEqual(combineDetails(null, none, "Lumen Outdoor"), { ...none, party: "Lumen Outdoor" });
    assert.deepEqual(combineDetails(before, none, "Lumen Outdoor"), before, "a shipping notice states nothing new");
    const invoice = { party: "Shop GmbH", amount: { minor: 5200, currency: "EUR" }, refund: false, state: null, dueDate: null, what: null };
    assert.deepEqual(combineDetails(before, invoice, null), { party: "Shop GmbH", amount: { minor: 5200, currency: "EUR" }, refund: false, state: null, dueDate: "2026-11-30", what: "A rain jacket" });
    assert.deepEqual(combineDetails(before, { ...none, refund: true }, null), before, "refund goes with the amount it was read with");
    assert.deepEqual(combineDetails(null, { ...none, refund: true }, null), { ...none, refund: true });
  });
});
