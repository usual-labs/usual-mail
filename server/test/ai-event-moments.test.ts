// The audit of the groups (2026-11-19: 12 groups of two or three threads all right; what is left are things still
// apart): one sender's notifications about the same upcoming moment join whatever their status or `about` says; times
// marked UTC in more ways are converted; and a limit's reset time is not its event's moment. Pure.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { momentOf, sameMoment } from "../src/ai/event-group.ts";
import { readTimes } from "../src/ai/event-times.ts";
import { checkEvent } from "../src/ai/event.ts";

const at = (iso: string) => Date.parse(iso);
const answer = (fields: Record<string, unknown>) => ({ summary: null, status: null, about: null, date: null, time: null, endTime: null, reference: null, ...fields });
const check = (fields: Record<string, unknown>, text: string, sent = "2026-11-19T12:00:00Z", zone = "UTC") =>
  checkEvent(answer(fields), text, [{ text, at: at(sent) }], "Tooling", zone);
const marks = (text: string) => Object.fromEntries([...readTimes(text)].map(([time, set]) => [time, [...set].sort().join()]));

describe("a time marked UTC", () => {
  test("also as ISO 8601 with seconds and fractions, with a numeric zero offset, or with the mark before it", () => {
    assert.deepEqual(marks("Resets 2026-11-20T00:00:00.000Z."), { "00:00": "utc" });
    assert.deepEqual(marks("Resets 2026-11-20T00:00:00+00:00."), { "00:00": "utc" });
    assert.deepEqual(marks("Resets 2026-11-20 00:00:00.123 UTC."), { "00:00": "utc" });
    assert.deepEqual(marks("Resets daily at UTC 00:00."), { "00:00": "utc" });
    assert.deepEqual(marks("Window GMT 14:00–16:00."), { "14:00": "utc", "16:00": "utc" });
    assert.deepEqual(marks("Starts 2026-11-20T09:30:00+01:00."), { "09:30": "offset" });
    assert.deepEqual(marks("Open 14:00-15:00 daily."), { "14:00": "local", "15:00": "local" }, "a window with a plain hyphen: two times, no offset");
    assert.deepEqual(marks("Order of 07.11.2026, sent 2026-11-19."), {}, "dates are no times");
    assert.deepEqual(check({ status: "Build finished", date: "2026-11-20", time: "00:00" }, "Finished 2026-11-20T00:00:00.000Z.", undefined, "Europe/Berlin").event.when,
      { date: "2026-11-20", time: "01:00", endTime: null });
  });
});

describe("a limit's reset time", () => {
  test("is not the moment of a status about a limit: the time goes, and the date unless it is the mail's own day", () => {
    const text = "You have used 75% of your monthly limit. It resets on 1 December 2026 at 00:00 UTC.";
    const reset = check({ status: "75% of limit used", date: "2026-12-01", time: "00:00" }, text);
    assert.deepEqual([reset.event.when, reset.drops], [null, [{ field: "time", reason: "reset_time" }, { field: "date", reason: "reset_time" }]]);
    const today = "Limit reached. Your quota renews today at 18:00.";
    assert.deepEqual(check({ status: "Limit reached", date: "2026-11-19", time: "18:00" }, today).event.when, { date: "2026-11-19", time: null, endTime: null });
    assert.deepEqual(check({ status: "Limit reached", date: "2026-11-19", time: "14:02" }, "Limit reached on 19 November at 14:02. It resets at 00:00 UTC.").event.when,
      { date: "2026-11-19", time: "14:02", endTime: null }, "a time not after a reset word stays");
    assert.deepEqual(check({ status: "Password changed", date: "2026-12-01", time: "00:00" }, "Your password was changed. Codes reset on 1 December 2026 at 00:00.").event.when,
      { date: "2026-12-01", time: "00:00", endTime: null }, "only for a status about a limit");
  });
});

describe("one sender's notifications about the same moment", () => {
  const sent = at("2026-11-19T08:00:00Z");
  const moment = (event: Record<string, unknown>, when = sent) => momentOf({ status: null, about: null, when: null, ...event } as never, when, "UTC");
  const day = (time: string | null) => ({ date: "2026-11-23", time, endTime: null });

  test("join when an upcoming moment has the same date and time, whatever the status or about", () => {
    const reminder = moment({ status: "Reminder", about: "Your health professional", when: day("12:00") });
    const confirmed = moment({ status: "Appointment confirmed", about: "Check-up with Dr. Moor", when: day("12:00") });
    assert.ok(reminder && confirmed && sameMoment(reminder, confirmed));
    assert.ok(!sameMoment(reminder!, moment({ status: "Reminder", when: day("12:30") })!), "another minute");
    assert.ok(!sameMoment(reminder!, moment({ status: "Reminder", when: { date: "2026-11-24", time: "12:00", endTime: null } })!), "another day");
  });

  test("an appointment's moved time joins by what it is about on its day; a moment with neither joins nothing", () => {
    const confirmed = moment({ status: "Appointment confirmed", about: "Check-up with Dr. Moor", when: day("12:00") })!;
    const moved = moment({ status: "Appointment moved", about: "check-up with Dr Moor", when: day("09:40") })!;
    assert.ok(sameMoment(confirmed, moved));
    assert.equal(moment({ status: "Delivered", when: day(null) }), null, "no time and not an appointment");
    assert.equal(moment({ status: "Reminder", when: null }), null);
  });

  test("two events on one date with no time on either and the same about join, whatever their statuses (2026-11-20)", () => {
    const reminder = moment({ status: "Reminder", about: "Board games night", when: day(null) })!;
    const pending = moment({ status: "Approval pending", about: "board-games night!", when: day(null) })!;
    assert.ok(sameMoment(reminder, pending));
    assert.ok(!sameMoment(reminder, moment({ status: "Reminder", about: "Quiz night", when: day(null) })!), "another about that day");
    assert.ok(!sameMoment(reminder, moment({ status: "Reminder", about: "Board games night", when: { date: "2026-11-24", time: null, endTime: null } })!), "another day");
    assert.ok(!sameMoment(reminder, moment({ status: "Reminder", about: "Board games night", when: day("19:00") })!), "one with a time, one without");
    assert.equal(moment({ status: "Reminder", about: null, when: day(null) }), null, "no about: nothing to join by");
    assert.equal(moment({ status: "Reminder", about: "Board games night", when: null }), null, "undated");
  });

  test("a time already past when the mail was sent is a report, not an upcoming moment: two builds at one minute stay apart", () => {
    const finished = at("2026-11-23T14:31:00Z");
    const build = moment({ status: "Build failed", about: "Build 1", when: day("14:30") }, finished);
    assert.equal(build, null);
    const upcoming = moment({ status: "Maintenance", when: day("14:30") }, at("2026-11-23T09:00:00Z"));
    assert.ok(upcoming && upcoming.time === "14:30", "the same day, later than the mail: upcoming");
  });
});
