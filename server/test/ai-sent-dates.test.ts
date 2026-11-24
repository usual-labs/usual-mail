// The day each message was sent, in the requests that read a thread (summarize, payment details, events; never
// categorize): its weekday and date in the server's time zone, so a model can read "today" or "tomorrow"
// (docs/contract-ai.md, "What leaves the server"). Pure.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dataItems } from "../src/ai/fake.ts";
import { serverTimeZone } from "../src/ai/payment-dates.ts";
import { categorizeRequest, detailsRequest, eventRequest, sentDay, summarizeRequest } from "../src/ai/prompt.ts";

const messages = [
  { fromName: "Parcelway", text: "Out for delivery today.", html: null, at: Date.parse("2026-11-16T07:05:00Z") },
  { fromName: "you", text: "Thanks.", html: null, at: Date.parse("2026-11-15T20:00:00Z") },
];
const ID = "0123456789abcdef01";

describe("the day a message was sent", () => {
  test("is its weekday and date in the server's time zone, UTC without one", () => {
    assert.equal(sentDay(messages[0]!.at, "Europe/Berlin"), "Monday 2026-11-16");
    assert.equal(sentDay(messages[0]!.at, "America/Los_Angeles"), "Sunday 2026-11-15");
    assert.equal(sentDay(messages[1]!.at, "UTC"), "Sunday 2026-11-15");
    assert.equal(sentDay(messages[1]!.at, "Asia/Tokyo"), "Monday 2026-11-16");
    assert.deepEqual([serverTimeZone(undefined), serverTimeZone(""), serverTimeZone("Nowhere/Town"), serverTimeZone("Europe/Berlin")], ["UTC", "UTC", "UTC", "Europe/Berlin"],
      "a host that gives no zone, or not a zone, is UTC");
  });

  test("goes with each message in a summary's, a receipt's and a notification's request, as `sent`", () => {
    for (const request of [
      summarizeRequest("m", "Parcel", messages, ID, "Europe/Berlin"),
      detailsRequest("m", "Parcel", messages, ID, "receipt", 0, "Europe/Berlin").request,
      eventRequest("m", "Parcel", messages, ID, 0, "Europe/Berlin").request,
    ]) {
      const items = dataItems(request.data);
      assert.deepEqual(items.slice(1).map((item) => item.sent), ["Monday 2026-11-16", "Sunday 2026-11-15"]);
      assert.deepEqual(Object.keys(items[1]!).sort(), ["from", "sent", "text"]);
    }
  });

  test("never in a categorize request", () => {
    const request = categorizeRequest("m", { subject: "Parcel", from: { email: "updates@parcelway.example" }, listId: null, automated: true, text: "Today.", html: null }, ID);
    assert.equal("sent" in dataItems(request.data)[0]!, false);
  });
});
