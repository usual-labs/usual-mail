// Which notifications tell of the same thing (docs/contract-ai.md, "Notification groups"; the owner's "Yes, build it"
// of 2026-11-19): the reference a mail prints, kept only when written in the mail and shaped like one; appointments by
// what they are about and their day; mail joining takes a status and its moment together. Pure.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { appointmentLike, groupKey } from "../src/ai/event-group.ts";
import { checkReference } from "../src/ai/event-reference.ts";
import { checkEvent, combineEvent } from "../src/ai/event.ts";

const TEXT = "Your parcel PW-4471-2093 from Fernhill Books is out for delivery. Order no. 10-55821. Customer 4711. Call +49 30 1234567.";

describe("a reference", () => {
  test("is kept when the mail writes it, separators and case aside, as its letters and digits in capitals", () => {
    assert.deepEqual(checkReference("PW 4471 2093", TEXT), { reference: "PW44712093" });
    assert.deepEqual(checkReference("pw44712093", TEXT), { reference: "PW44712093" });
    assert.deepEqual(checkReference("#10-55821", TEXT), { reference: "1055821" });
    assert.deepEqual(checkReference("Order 10/55821", "Bestellung 10.55821 versandt."), { reference: "1055821" }, "a label before it is taken off");
    assert.deepEqual(checkReference("Tracking number: PW 4471 2093", TEXT), { reference: "PW44712093" });
    assert.deepEqual(checkReference("Sendungsnummer PW-4471-2093", TEXT), { reference: "PW44712093" });
  });

  test("is dropped, with a reason, when it isn't written, isn't shaped like one, or is something else", () => {
    const cases: Array<[string, string, string]> = [
      ["PW44712094", TEXT, "not_in_text"],
      ["W-4471-2093", TEXT, "not_in_text"],
      ["4711", TEXT, "length"],
      ["A".repeat(41) + "1", "x", "length"],
      ["FERNHILL", "FERNHILL", "no_digit"],
      ["orders1@[address]", "x", "address"],
      ["track.parcelway.example/PW1", "x", "url"],
      ["https://parcelway.example/t/PW44712093", "x", "url"],
      ["+49 30 1234567", TEXT, "phone"],
      ["2026-11-19", "Sent on 2026-11-19.", "date"],
      ["19.11.2026", "Sent on 19.11.2026.", "date"],
      ["1,249.00", "Total 1,249.00", "amount"],
      ["49,90 €", "Total 49,90 €", "amount"],
      ["EUR 120.50", "EUR 120.50", "amount"],
      ["<b>PW1234</b>", "PW1234", "markup"],
      ["PW 44*71", "PW 44*71", "shape"],
    ];
    for (const [given, text, reason] of cases) assert.deepEqual(checkReference(given, text), { dropped: reason }, given);
  });

  test("comes with the event's other facts, and never alone makes an event", () => {
    const text = "Your parcel PW-4471-2093 arrives on 21 November.";
    const at = Date.parse("2026-11-19T12:00:00Z");
    const answer = { summary: null, status: "Arriving", about: null, date: "2026-11-21", time: null, endTime: null, reference: "PW 4471 2093" };
    const checked = checkEvent(answer, text, [{ text, at }], "Parcelway");
    assert.deepEqual([checked.reference, checked.event], ["PW44712093", { status: "Arriving", about: null, when: { date: "2026-11-21", time: null, endTime: null } }]);
    const dropped = checkEvent({ ...answer, reference: "PW 12" }, text, [{ text, at }], "Parcelway");
    assert.deepEqual([dropped.reference, dropped.drops], [null, [{ field: "reference", reason: "length" }]]);
  });
});

describe("an appointment", () => {
  test("is known by its status's words: appointment, reservation, booking", () => {
    for (const status of ["Appointment confirmed", "Appointment moved", "Appointment cancelled", "Reservation confirmed", "Booking cancelled", "Your appointments"]) {
      assert.equal(appointmentLike(status), true, status);
    }
    for (const status of [null, "Reminder", "Delivered", "Payment failed", "Consent needed", "Rebooking fee"]) assert.equal(appointmentLike(status), false, String(status));
  });
});

describe("a group's key", () => {
  test("is opaque, the same for the same inbox, sender and parts, and differs when any of them does", async () => {
    const key = await groupKey("r", "inb_a", "parcelway.example", ["PW44712093"]);
    assert.match(key, /^r[0-9a-f]{24}$/);
    assert.equal(await groupKey("r", "inb_a", "parcelway.example", ["PW44712093"]), key);
    for (const other of [
      await groupKey("r", "inb_b", "parcelway.example", ["PW44712093"]),
      await groupKey("r", "inb_a", "fernhill.example", ["PW44712093"]),
      await groupKey("r", "inb_a", "parcelway.example", ["PW44712094"]),
      await groupKey("a", "inb_a", "parcelway.example", ["PW44712093"]),
    ]) assert.notEqual(other, key);
    assert.ok(!key.includes("4471"), "the reference can't be read from it");
  });
});

describe("mail joining", () => {
  const window = { status: "Out for delivery", about: "Parcel 7", when: { date: "2026-11-18", time: "15:15", endTime: "18:15" } };

  test("takes a status and its moment together; a status with no date leaves none; about stays when the answer has none", () => {
    assert.deepEqual(combineEvent(window, { status: "Delivered", about: null, when: null }), { status: "Delivered", about: "Parcel 7", when: null });
    assert.deepEqual(combineEvent(window, { status: "Delivered", about: "Parcel 7b", when: { date: "2026-11-18", time: null, endTime: null } }),
      { status: "Delivered", about: "Parcel 7b", when: { date: "2026-11-18", time: null, endTime: null } });
  });

  test("an answer with no status keeps the pair; an empty one keeps all; a thread with none takes what there is", () => {
    assert.deepEqual(combineEvent(window, { status: null, about: "Parcel 8", when: { date: "2026-11-20", time: null, endTime: null } }), { ...window, about: "Parcel 8" });
    assert.deepEqual(combineEvent(window, { status: null, about: null, when: null }), window);
    assert.deepEqual(combineEvent(null, { status: null, about: null, when: null }), { status: null, about: null, when: null });
    assert.deepEqual(combineEvent(window, { ...window, status: "Delivered", group: "x" } as never), { ...window, status: "Delivered" }, "a group never comes from an answer");
  });
});
