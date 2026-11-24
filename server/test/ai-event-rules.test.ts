// The rules of the notification events' audit round (2026-11-19, 119 rows judged: 71 right, 29 vague, 19 misleading):
// a status that names what happens at its date and carries no relative word, deadlines and dates said "in 14 days" or
// written without a year, times marked UTC, and an `about` that keeps a place. (Mail joining's status and moment
// together: ai-event-groups.) Pure.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkEvent, YEARLESS_PAST_DAYS } from "../src/ai/event.ts";

const at = (iso: string) => Date.parse(iso);
const answer = (fields: Record<string, unknown>) => ({ summary: null, status: null, about: null, date: null, time: null, endTime: null, ...fields });
/** One message sent at `sent` (12:00 UTC on the 19th by default: the 19th in Berlin and in UTC). */
const check = (fields: Record<string, unknown>, text: string, options: { sent?: string; zone?: string; sender?: string | null } = {}) =>
  checkEvent(answer(fields), text, [{ text, at: at(options.sent ?? "2026-11-19T12:00:00Z") }], options.sender === undefined ? "Parcelway" : options.sender, options.zone ?? "UTC");

describe("a status names what happens at its date", () => {
  test("a dispatch with a date after the day its message was sent is Arriving; on that day, or with none, it stays", () => {
    const text = "Your parcel was dispatched and arrives on 21 November.";
    for (const status of ["Dispatched", "Shipped", "On its way", "In transit", "Order shipped", "dispatched."]) {
      const arriving = check({ status, date: "2026-11-21" }, text);
      assert.deepEqual([arriving.event.status, arriving.changes], ["Arriving", ["arriving"]], status);
    }
    assert.equal(check({ status: "Dispatched", date: "2026-11-19" }, "Dispatched today.").event.status, "Dispatched", "the day it was sent off");
    assert.equal(check({ status: "Dispatched" }, text).event.status, "Dispatched", "no date");
    assert.equal(check({ status: "Dispatched to the pickup point", date: "2026-11-21" }, text).event.status, "Dispatched to the pickup point", "only the dispatch words themselves");
  });

  test("a relative word is taken out of a status when a phrase is left, else the status is dropped", () => {
    const text = "Out for delivery today, arriving tomorrow, starts in 1 hour.";
    const cases: Array<[string, string | null]> = [
      ["Out for delivery today", "Out for delivery"],
      ["Arriving tomorrow", "Arriving"],
      ["Delivered on Monday", "Delivered"],
      ["Today: delivered", "Delivered"],
      ["Starts in 1 hour", "Starts"],
      ["Pick up by tomorrow", "Pick up by"],
      ["Arriving this evening", "Arriving"],
      ["Today", null],
      ["In 2 hours", null],
    ];
    for (const [status, kept] of cases) {
      const checked = check({ status }, text);
      assert.equal(checked.event.status, kept, status);
      if (kept === null) assert.deepEqual(checked.drops, [{ field: "status", reason: "relative_only" }], status);
      else assert.deepEqual(checked.changes, ["relative_word"], status);
    }
    assert.deepEqual(check({ status: "Out for delivery" }, text).changes, [], "nothing to take out");
  });
});

describe("a deadline's date", () => {
  test("said as in or within N days counts from the day its message was sent, in the matcher's languages", () => {
    // Sent 12:00 UTC on the 19th: its local day is the 19th or the 20th.
    const cases: Array<[string, string]> = [
      ["Please give your consent within 14 days.", "2026-12-03"],
      ["Your trial ends in 3 days.", "2026-11-22"],
      ["Bitte stimmen Sie innerhalb von 14 Tagen zu.", "2026-12-03"],
      ["Bitte binnen 7 Tagen abholen.", "2026-11-27"],
      ["À retirer sous 10 jours.", "2026-11-29"],
      ["Ritiro entro 5 giorni.", "2026-11-25"],
      ["Ophalen binnen 7 dagen.", "2026-11-26"],
      ["Recoger en 4 días.", "2026-11-23"],
      ["Levante em 2 dias.", "2026-11-21"],
    ];
    for (const [text, date] of cases) assert.equal(check({ status: "Action required", date }, text).event.when?.date, date, text);
    assert.equal(check({ date: "2026-12-04" }, "Please give your consent within 14 days.").event.when?.date, "2026-12-04", "the later of the two days");
    assert.deepEqual(check({ date: "2026-12-10" }, "Please give your consent within 14 days.").drops, [{ field: "date", reason: "not_in_text" }]);
    assert.deepEqual(check({ date: "2026-11-22" }, "We took 3 days to answer.").drops, [{ field: "date", reason: "not_in_text" }], "a number of days alone isn't a date");
  });

  test(`written as dd.mm. or dd/mm without a year: the message's year, or the next when that day lies more than ${YEARLESS_PAST_DAYS} days before it`, () => {
    assert.equal(check({ date: "2026-12-05" }, "Zustimmung bis 05.12. erforderlich.").event.when?.date, "2026-12-05");
    assert.equal(check({ date: "2026-12-05" }, "Reply by 05/12 please.").event.when?.date, "2026-12-05", "day first");
    assert.deepEqual(check({ date: "2026-05-12" }, "Reply by 05/12 please.").drops, [{ field: "date", reason: "not_in_text" }], "never month first");
    assert.equal(check({ date: "2027-01-15" }, "Abholung bis 15.01. möglich.").event.when?.date, "2027-01-15", "January from November: next year");
    assert.deepEqual(check({ date: "2026-01-15" }, "Abholung bis 15.01. möglich.").drops, [{ field: "date", reason: "not_in_text" }]);
    assert.equal(check({ date: "2026-09-20" }, "Zugestellt am 20.09.").event.when?.date, "2026-09-20", "two months back: this year");
    assert.equal(check({ date: "2027-08-10" }, "Termin am 10.08.").event.when?.date, "2027-08-10", "101 days back: next year");
    assert.deepEqual(check({ date: "2026-08-10" }, "Termin am 10.08.").drops, [{ field: "date", reason: "not_in_text" }]);
    assert.deepEqual(check({ date: "2026-12-05" }, "Version 05.12.3 released.").drops, [{ field: "date", reason: "not_in_text" }], "digits after it: no date");
  });
});

describe("a time marked UTC", () => {
  test("is converted to the server's time zone on its date, which may move the date", () => {
    const build = "Your build finished at 14:30 UTC on 19 November.";
    assert.deepEqual(check({ date: "2026-11-19", time: "14:30" }, build, { zone: "Europe/Berlin" }).event.when, { date: "2026-11-19", time: "15:30", endTime: null });
    assert.deepEqual(check({ date: "2026-11-19", time: "14:30" }, build, { zone: "UTC" }).event.when, { date: "2026-11-19", time: "14:30", endTime: null });
    const late = check({ date: "2026-11-19", time: "23:30" }, "Maintenance on 19 November at 23:30 GMT.", { zone: "Europe/Berlin" });
    assert.deepEqual([late.event.when, late.changes], [{ date: "2026-11-20", time: "00:30", endTime: null }, ["from_utc"]]);
    assert.deepEqual(check({ date: "2026-11-19", time: "14:30" }, "Started 2026-11-19T14:30:00Z.", { zone: "America/New_York" }).event.when, { date: "2026-11-19", time: "09:30", endTime: null });
    assert.deepEqual(check({ date: "2026-11-19", time: "14:00", endTime: "16:00" }, "Window on 19 November, 14:00–16:00 UTC.", { zone: "Europe/Berlin" }).event.when,
      { date: "2026-11-19", time: "15:00", endTime: "17:00" }, "a window's start takes its end's mark");
  });

  test("a time with another offset is dropped and the date kept; an end on another day after converting is dropped", () => {
    const offset = check({ date: "2026-11-19", time: "14:30" }, "Release on 19 November at 14:30 UTC+1.", { zone: "Europe/Berlin" });
    assert.deepEqual([offset.event.when, offset.drops], [{ date: "2026-11-19", time: null, endTime: null }, [{ field: "time", reason: "utc_offset" }]]);
    const tokyo = check({ date: "2026-11-19", time: "14:00", endTime: "16:00" }, "Window on 19 November, 14:00–16:00 UTC.", { zone: "Asia/Tokyo" });
    assert.deepEqual([tokyo.event.when, tokyo.drops], [{ date: "2026-11-19", time: "23:00", endTime: null }, [{ field: "endTime", reason: "two_days" }]]);
    assert.deepEqual(check({ date: "2026-11-19", time: "15:30" }, "At 14:30 UTC (15:30 in Berlin) on 19 November.", { zone: "Europe/Berlin" }).event.when?.time, "15:30",
      "a time written without a mark stays as written");
  });
});

describe("about", () => {
  test("keeps the sender's name when taking it out would leave a single word or a place", () => {
    assert.equal(check({ about: "Parcelway: parcel from Fernhill Books" }, "x").event.about, "Parcel from Fernhill Books");
    assert.equal(check({ about: "Parcelway: Berlin" }, "x").event.about, "Parcelway: Berlin");
    assert.equal(check({ about: "Parcelway – Frankfurt am Main" }, "x").event.about, "Parcelway – Frankfurt am Main");
    assert.equal(check({ about: "Parcelway: parcel" }, "x").event.about, "Parcelway: parcel");
  });
});
