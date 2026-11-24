// What the server keeps of a notification's event (src/ai/event.ts; the owner's request of 2026-11-19): a status and
// what it is about as safe plain lines, and a moment only when the mail supports it, written or said relative to the
// mail's own date. Pure: no model, no store.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkEvent, EVENT_RANGE_DAYS, relativeDates, timesIn } from "../src/ai/event.ts";
import { EVENT_SCHEMA, eventInstructions } from "../src/ai/prompt.ts";

const at = (iso: string) => Date.parse(iso);
const one = (text: string, sent: string) => [{ text, at: at(sent) }];
const answer = (fields: Record<string, unknown>) => ({ summary: null, status: null, about: null, date: null, time: null, endTime: null, ...fields });
const check = (fields: Record<string, unknown>, text: string, sent = "2026-11-16T07:05:00Z", sender: string | null = "Parcelway") =>
  checkEvent(answer(fields), text, one(text, sent), sender);

describe("status and about", () => {
  test("pass a summary's checks, are shortened, never carry an address, and about is never just the sender", () => {
    const text = "Your parcel is out for delivery today.";
    assert.deepEqual(check({ status: "Out for delivery", about: "Parcel from Fernhill Books" }, text).event,
      { status: "Out for delivery", about: "Parcel from Fernhill Books", when: null });
    assert.ok(check({ status: "Out for delivery and on its way to you very soon now" }, text).event.status!.length <= 40);
    assert.deepEqual(check({ status: "<b>Out</b>" }, text).drops, [{ field: "status", reason: "markup" }]);
    assert.deepEqual(check({ about: "orders@[address]" }, text).drops, [{ field: "about", reason: "address" }]);
    assert.deepEqual(check({ about: "Parcelway" }, text).drops, [{ field: "about", reason: "only_sender" }]);
    assert.deepEqual(check({ about: "Parcelway GmbH" }, text).drops, [{ field: "about", reason: "only_sender" }]);
    assert.equal(check({ about: "Parcelway: parcel from Fernhill Books" }, text).event.about, "Parcel from Fernhill Books");
  });

  test("the summary is a summary's, checked the same way; one dropped leaves none", () => {
    assert.equal(check({ summary: "Your parcel arrives today" }, "x").summary, "Your parcel arrives today");
    const dropped = check({ summary: "<p>x</p>" }, "x");
    assert.deepEqual([dropped.summary, dropped.drops], [null, [{ field: "summary", reason: "markup" }]]);
  });

  test("an answer of the wrong shape, or none, is dropped whole", () => {
    assert.deepEqual(checkEvent(null, "x", [], null).drops, [{ field: "answer", reason: "no_answer" }]);
    assert.deepEqual(checkEvent({ status: 3 }, "x", [], null).drops, [{ field: "answer", reason: "shape" }]);
    assert.deepEqual(checkEvent(null, "x", [], null).event, { status: null, about: null, when: null });
  });
});

describe("a date written in the mail", () => {
  test(`is kept within ${EVENT_RANGE_DAYS} days either side of its message, read day or month first as the mail writes dates`, () => {
    assert.deepEqual(check({ date: "2026-11-23" }, "Confirmed for Monday 23 November 2026.").event.when, { date: "2026-11-23", time: null, endTime: null });
    assert.deepEqual(check({ date: "2026-11-02" }, "Delivered on 2 November.").event.when?.date, "2026-11-02", "a past event");
    assert.deepEqual(check({ date: "2024-11-02" }, "Order of 02.11.2024.").drops, [{ field: "date", reason: "out_of_range" }]);
    const swapped = check({ date: "2026-12-07" }, "Termin am 21.11.2026 verschoben auf 07.12.2026.", "2026-11-16T07:05:00Z");
    assert.equal(swapped.event.when?.date, "2026-12-07", "both readings within a year: the mail's own order (day first) keeps the model's");
    const turned = check({ date: "2026-07-12" }, "Termin am 21.11.2026 verschoben auf 07.12.2026.");
    assert.deepEqual([turned.event.when?.date, turned.swapped], ["2026-12-07", true]);
    assert.deepEqual(check({ date: "2026-02-30" }, "x").drops, [{ field: "date", reason: "invalid_date" }]);
    assert.deepEqual(check({ date: "2026-11-20" }, "Arriving soon.").drops, [{ field: "date", reason: "not_in_text" }]);
  });
});

describe("a date said relative to the mail's own date", () => {
  test("is the mail's local date moved by the word: one of the two dates its stored UTC time has from UTC−12 to UTC+14", () => {
    assert.deepEqual([...relativeDates(one("Out for delivery today.", "2026-11-16T07:05:00Z"))].sort(), ["2026-11-15", "2026-11-16"], "07:05 UTC is still the 15th west of UTC−7");
    assert.deepEqual([...relativeDates(one("Out for delivery today.", "2026-11-16T13:00:00Z"))].sort(), ["2026-11-16", "2026-11-17"]);
    assert.deepEqual([...relativeDates(one("Wird morgen zugestellt.", "2026-11-16T12:00:00Z"))].sort(), ["2026-11-17", "2026-11-18"]);
    assert.deepEqual([...relativeDates(one("Delivered yesterday.", "2026-11-14T09:00:00Z"))].sort(), ["2026-11-12", "2026-11-13"]);
    assert.deepEqual([...relativeDates(one("Livraison demain, hier c'était férié.", "2026-11-16T12:00:00Z"))].sort(), ["2026-11-17", "2026-11-18"],
      "French hier is left out: in German and Dutch it is \"here\"");
    assert.deepEqual([...relativeDates(one("Heute Morgen versandt.", "2026-11-16T12:00:00Z"))].sort(), ["2026-11-16", "2026-11-17"], "a capital Morgen is the morning, not tomorrow");
    assert.deepEqual([...relativeDates(one("Llega esta mañana.", "2026-11-16T12:00:00Z"))].sort(), [], "esta mañana is this morning: no date of its own");
  });

  test("a weekday is the next such day within a week of the message, that day itself included", () => {
    assert.deepEqual([...relativeDates(one("Your parcel arrives on Wednesday.", "2026-11-15T13:12:00Z"))].sort(), ["2026-11-18"]);
    assert.deepEqual([...relativeDates(one("Wir liefern am Montag.", "2026-11-16T12:00:00Z"))].sort(), ["2026-11-16", "2026-11-23"]);
  });

  test("the model's date is kept only when it agrees", () => {
    assert.deepEqual(check({ date: "2026-11-16", status: "Out for delivery" }, "Out for delivery today.").event.when?.date, "2026-11-16");
    assert.deepEqual(check({ date: "2026-11-18" }, "Out for delivery today.").drops, [{ field: "date", reason: "not_in_text" }]);
    assert.equal(check({ date: "2026-11-13" }, "Delivered yesterday.", "2026-11-14T09:00:00Z").event.when?.date, "2026-11-13");
  });
});

describe("times", () => {
  test("are read in 12- and 24-hour forms, with Uhr or h, with . or :, and a window takes its end's am or pm", () => {
    assert.deepEqual([...timesIn("between 3:15–6:15 pm")].sort(), ["15:15", "18:15"]);
    assert.deepEqual([...timesIn("um 14.30 Uhr")], ["14:30"]);
    assert.deepEqual([...timesIn("ab 15 Uhr")], ["15:00"]);
    assert.deepEqual([...timesIn("à 9h30, puis 18h")].sort(), ["09:30", "18:00"]);
    assert.deepEqual([...timesIn("at 9:40 am")], ["09:40"]);
    assert.deepEqual([...timesIn("at 12 pm or 12:30 a.m.")].sort(), ["00:30", "12:00"]);
    assert.deepEqual([...timesIn("Order of 07.11.2026")], [], "a date isn't a time");
  });

  test("must be written, a start before its end, and never without a date (\"a time with no date\" for the server's own)", () => {
    const text = "Out for delivery today, 3:15–6:15 pm.";
    assert.deepEqual(check({ date: "2026-11-16", time: "15:15", endTime: "18:15" }, text).event.when, { date: "2026-11-16", time: "15:15", endTime: "18:15" });
    assert.deepEqual(check({ date: "2026-11-16", time: "16:00" }, text).drops, [{ field: "time", reason: "not_in_text" }]);
    const backwards = check({ date: "2026-11-16", time: "18:15", endTime: "15:15" }, text);
    assert.deepEqual([backwards.event.when, backwards.drops], [{ date: "2026-11-16", time: "18:15", endTime: null }, [{ field: "endTime", reason: "time_order" }]]);
    const noDate = check({ time: "15:15" }, "Out for delivery, 3:15–6:15 pm.");
    assert.deepEqual([noDate.event.when, noDate.drops], [null, [{ field: "time", reason: "no_date" }]]);
    assert.deepEqual(check({ date: "2026-11-16", time: "3pm" }, text).drops, [{ field: "time", reason: "invalid_time" }]);
  });
});

describe("the event request's words", () => {
  test("a summary as today, each message with the day it was sent, a status at its date from a preferred list, deadlines, the event's own moment, the reference, all null for a notice with no event", () => {
    const id = "0123456789abcdef01";
    assert.equal(eventInstructions(id).split(" The mail is inside")[0], [
      "Say what this email thread is about in one short line, for the person who received it, and read the event it",
      "tells of. summary: one plain sentence, under about 100 characters, not repeating the sender's name; its",
      "messages are newest first, each with the day it was sent, and \"you\" is that person. status: what happens or",
      "happened at the date you give, a short plain phrase in English whatever the mail's language, under about",
      "30 characters, without a relative word such as \"today\", \"tomorrow\" or \"in 1 hour\" (the date says when).",
      "Prefer these when they fit: deliveries \"Dispatched\", \"Arriving\", \"Out for delivery\", \"Delivered\", \"Ready for",
      "pickup\"; appointments and bookings \"Appointment confirmed\", \"Appointment moved\", \"Appointment cancelled\",",
      "\"Reservation confirmed\", \"Reminder\"; accounts \"Password changed\", \"Payment failed\", \"Trial ended\", \"Limit",
      "reached\". A dispatch notice that gives the day the parcel arrives is \"Arriving\", with that day; \"Dispatched\" only",
      "with the day it was sent off, or no date. When the mail asks the reader to do something by a date, the status",
      "names what is needed (\"Consent needed\", \"Action required\", \"Pick up by\") and the date is that deadline. about:",
      "what or who it concerns, as the mail names it, under about 60 characters, without the sender's name or a",
      "date. date: the day the status happens or happened, as YYYY-MM-DD, when the mail states one, or says it relative",
      "to the day its message was sent (\"today\", \"tomorrow\", \"within 14 days\", a weekday): the event's own moment, not a",
      "neighbouring one (not when a limit resets, not the start of something the mail is not about). time and endTime: as",
      "HH:MM in 24 hours, when it happens, and the end of a window (a delivery slot) when the mail gives one, as the mail",
      "states them, without converting time zones. reference: exactly as the mail writes it, the number or code that",
      "identifies this order, parcel, booking or case (an order number, a tracking or shipment number, a booking or",
      "reservation code, a ticket or case number); null when there is none; never an amount, a date, a phone number, or a",
      "customer or account number that is the same in all of that sender's mail. When several messages tell of events,",
      "the newest one's. Null for anything the mail doesn't say; status, about, date, time and endTime all null when the",
      "mail tells of no event (a digest, or a notice with nothing done, dated or asked of the reader). Plain text only: no",
      "markup, no line breaks.",
    ].join(" "));
    assert.ok(eventInstructions(id).includes(`<usual-mail-data id="${id}">`), "the data block's notice, as for every request");
    assert.deepEqual(Object.keys(EVENT_SCHEMA.shape), ["summary", "status", "about", "date", "time", "endTime", "reference"]);
  });
});

describe("a time with no date", () => {
  const window = "Your parcel is out for delivery today, 3:15–6:15 pm.";
  const noon = "2026-11-16T07:05:00Z";

  test("takes its date from a relative word in the message that writes it, read in the server's time zone", () => {
    const berlin = checkEvent(answer({ status: "Out for delivery", time: "15:15", endTime: "18:15" }), window, one(window, noon), "Parcelway", "Europe/Berlin");
    assert.deepEqual([berlin.event.when, berlin.drops, berlin.changes], [{ date: "2026-11-16", time: "15:15", endTime: "18:15" }, [], ["dated"]]);
    const angeles = checkEvent(answer({ time: "15:15" }), window, one(window, noon), "Parcelway", "America/Los_Angeles");
    assert.equal(angeles.event.when?.date, "2026-11-15", "07:05 UTC is still the 15th in Los Angeles");
    const tomorrow = "Zustellung morgen zwischen 9 und 12 Uhr.";
    assert.deepEqual(checkEvent(answer({ time: "12:00" }), tomorrow, one(tomorrow, noon), null, "Europe/Berlin").event.when, { date: "2026-11-17", time: "12:00", endTime: null });
  });

  test("also when the model's own date didn't check out", () => {
    const { event, drops } = checkEvent(answer({ date: "2026-11-20", time: "15:15" }), window, one(window, noon), null, "Europe/Berlin");
    assert.deepEqual([event.when, drops], [{ date: "2026-11-16", time: "15:15", endTime: null }, [{ field: "date", reason: "not_in_text" }]]);
  });

  test("is still dropped with no relative word, or with words that disagree", () => {
    const plain = "Your parcel arrives between 3:15–6:15 pm.";
    assert.deepEqual(checkEvent(answer({ time: "15:15" }), plain, one(plain, noon), null, "Europe/Berlin").drops, [{ field: "time", reason: "no_date" }]);
    const both = "Not today: tomorrow, 3:15–6:15 pm.";
    assert.deepEqual(checkEvent(answer({ time: "15:15" }), both, one(both, noon), null, "Europe/Berlin").drops, [{ field: "time", reason: "no_date" }]);
  });
});
