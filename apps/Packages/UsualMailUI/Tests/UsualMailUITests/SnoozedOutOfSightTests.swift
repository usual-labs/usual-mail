import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// A snoozed mail is out of sight until it comes back (the coordinator's decision of 2026-11-20): only Snoozed lists
/// it while it waits; Feed, Receipts, Notifications and the Inbox page leave it out (Home already did). A pinned or
/// reply-later mail still shows in its tab. The lists are worked out at a given moment, so the time passing brings it
/// back.
@MainActor
struct SnoozedOutOfSightTests {
    private let sample = SampleData.bundled
    private var now: Date { sample.now }
    private let today = CalendarDay("2026-11-16")!

    private func time(_ text: String) -> Date { MailJSON.parseTime(text)! }

    /// The sample with `ids` snoozed until `until` (Wednesday morning unless given).
    private func snoozed(_ ids: [String], until: String = "2026-11-18T08:00:00Z") -> SampleData {
        var data = sample
        for index in data.threads.indices where ids.contains(data.threads[index].id) {
            data.threads[index].comeBackAt = time(until)
        }
        return data
    }

    private func receipts(_ store: MailStore, at now: Date) -> [String] {
        CategoryList(store.lists, tab: .receipts, inbox: nil, now: now).threads.map(\.id)
    }

    private func snoozedList(_ store: MailStore) -> [String] {
        RailList(store.lists, place: .snoozed, inbox: nil).threads.map(\.id)
    }

    @Test func aSnoozedReceiptIsOnlyInSnoozedUntilItComesBack() async throws {
        let store = try await MailStore.sample(snoozed(["thr_17"]))
        #expect(receipts(store, at: now) == ["thr_6", "thr_18", "thr_10"])
        // Soonest first: the refund on Wednesday, the lease renewal on Thursday.
        #expect(snoozedList(store) == ["thr_17", "thr_9"])
        // A second before, still away; at its time, back in its place.
        #expect(!receipts(store, at: time("2026-11-18T07:59:59Z")).contains("thr_17"))
        #expect(receipts(store, at: time("2026-11-18T08:00:00Z")) == ["thr_6", "thr_17", "thr_18", "thr_10"])
    }

    @Test func unsnoozedItIsBackInReceiptsAtOnce() async throws {
        let store = try await heldStore(snoozed(["thr_17"]))
        #expect(!receipts(store, at: now).contains("thr_17"))

        // Before the server answers.
        let unsnooze = Task { await store.perform(.cancelComeBack, on: ["thr_17"]) }
        defer { unsnooze.cancel() }
        try await waitUntil("thr_17 is back in Receipts") {
            receipts(store, at: now) == ["thr_6", "thr_17", "thr_18", "thr_10"]
        }
        #expect(snoozedList(store) == ["thr_9"])
    }

    @Test func aPinnedReceiptStaysInReceipts() async throws {
        // The train tickets are pinned, not snoozed: in Pinned and in Receipts.
        let store = try await MailStore.sample()
        #expect(receipts(store, at: now).contains("thr_10"))
        #expect(RailList(store.lists, place: .pinned, inbox: nil).threads.map(\.id) == ["thr_10"])
    }

    @Test func aSnoozedNewsletterIsOutOfTheFeed() async throws {
        let store = try await MailStore.sample(snoozed(["thr_8"]))
        #expect(CategoryList(store.lists, tab: .reads, inbox: nil, now: now).threads.map(\.id) == ["thr_4"])
        #expect(snoozedList(store) == ["thr_8", "thr_9"])
        let wednesday = time("2026-11-18T09:00:00Z")
        #expect(
            CategoryList(store.lists, tab: .reads, inbox: nil, now: wednesday).threads.map(\.id) == ["thr_8", "thr_4"])
    }

    @Test func aGroupWhoseNewestIsSnoozedShowsItsNextAndCountsOnlyWhatShows() async throws {
        // The appointment's move (thr_25) and the parcel's delivery (thr_21) are snoozed.
        let store = try await MailStore.sample(snoozed(["thr_25", "thr_21"]))
        let sections = NotificationSections(store.lists, inbox: nil, today: today, now: now)
        let appointment = try #require(sections.rows.first { $0.threadIDs.contains("thr_20") })
        #expect(appointment.threadIDs == ["thr_20"] && appointment.count == nil)
        let parcel = try #require(sections.rows.first { $0.threadIDs.contains("thr_24") })
        #expect(parcel.shown.id == "thr_24" && parcel.threadIDs == ["thr_24", "thr_23"] && parcel.count == "2 updates")
        #expect(!sections.all.contains { ["thr_25", "thr_21"].contains($0.id) })

        // Back on Wednesday: the groups as they were.
        let wednesday = NotificationSections(store.lists, inbox: nil, today: today, now: time("2026-11-18T08:00:00Z"))
        #expect(wednesday.rows.map(\.threadIDs).contains(["thr_25", "thr_20"]))
        #expect(wednesday.rows.map(\.threadIDs).contains(["thr_21", "thr_24", "thr_23"]))
    }

    @Test func aGroupWhollySnoozedIsGone() async throws {
        let store = try await MailStore.sample(snoozed(["thr_21", "thr_24", "thr_23"]))
        let sections = NotificationSections(store.lists, inbox: nil, today: today, now: now)
        #expect(Set(sections.all.map(\.id)) == ["thr_19", "thr_25", "thr_20", "thr_11", "thr_22"])
        #expect(sections.rows.count == 4)
        // Equal times by id.
        #expect(snoozedList(store) == ["thr_21", "thr_23", "thr_24", "thr_9"])
    }

    @Test func theInboxPageLeavesASnoozedThreadOutUntilItComesBack() async throws {
        let store = try await MailStore.sample()
        // The lease renewal (thr_9) waits until Thursday 08:00.
        #expect(
            AllMailList(store.lists, inbox: "inb_harbor", now: now).threads.map(\.id) == ["thr_8", "thr_6", "thr_7"])
        let thursday = time("2026-11-19T08:00:00Z")
        #expect(
            AllMailList(store.lists, inbox: "inb_harbor", now: thursday).threads.map(\.id) == [
                "thr_8", "thr_6", "thr_7", "thr_9",
            ])
        #expect(!AllMailList.shows(try #require(store.lists.thread(id: "thr_9")), at: now))
        #expect(AllMailList.shows(try #require(store.lists.thread(id: "thr_9")), at: thursday))
    }
}
