import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The Notifications tab in Today, Coming up and Earlier (owner's "Yes, build both" of 2026-11-19), against the
/// person's own local date, the mail's dates never converted; one row per group, placed by the thread it shows. The
/// grouping itself is in `NotificationGroupsTests`.
@MainActor
struct NotificationSectionsTests {
    let monday = CalendarDay("2026-11-16")!
    let berlin = TimeZone(identifier: "Europe/Berlin")!

    private func thread(
        _ id: String, date: String? = nil, time: String? = nil, hoursAgo: Double = 1, status: String? = "Due"
    ) -> MailThread {
        MailThread(
            id: id, inboxId: "inb_personal", subject: id,
            lastMessageAt: Date(timeIntervalSince1970: 1_800_000_000 - hoursAgo * 3600), category: .notification,
            event: NotificationEvent(status: status, when: date.map { .init(date: $0, time: time) }))
    }

    /// The threads the rows show.
    private func ids(_ rows: [NotificationRow]) -> [String] { rows.map(\.shown.id) }
    private func ids(_ threads: [MailThread]) -> [String] { threads.map(\.id) }

    @Test func theSampleOnItsMonday() async throws {
        let store = try await MailStore.sample()
        let today = CalendarDay(store.now, in: berlin)
        #expect(today == monday)
        let sections = NotificationSections(store.lists, inbox: nil, today: today, now: store.now)
        // The parcel out for delivery today; the check-up next Monday, moved (15 Nov) after it was confirmed (14 Nov);
        // the rest newest mail first: the order not read yet (15 Nov 13:12), the digest (15 Nov 06:00) and the boots
        // delivered on 13 Nov (mail of 14 Nov), with the boots' two earlier mails behind it.
        #expect(ids(sections.today) == ["thr_19"])
        #expect(ids(sections.comingUp) == ["thr_25"])
        #expect(ids(sections.earlier) == ["thr_11", "thr_22", "thr_21"])
        #expect(sections.comingUp.map(\.threadIDs) == [["thr_25", "thr_20"]])
        #expect(sections.earlier.map(\.threadIDs) == [["thr_11"], ["thr_22"], ["thr_21", "thr_24", "thr_23"]])
        #expect(sections.rows.map(\.count) == [nil, "2 updates", nil, nil, "3 updates"])
        #expect(sections.parts.map(\.title) == ["Today", "Coming up", "Earlier"])
        #expect(
            ids(sections.all) == ["thr_19", "thr_25", "thr_20", "thr_11", "thr_22", "thr_21", "thr_24", "thr_23"])
        // One profile shows one inbox; the sample's notifications are all the personal inbox's.
        #expect(NotificationSections(store.lists, inbox: "inb_personal", today: today, now: store.now) == sections)
        #expect(NotificationSections(store.lists, inbox: "inb_northwind", today: today, now: store.now).isEmpty)
    }

    @Test func todayByTimeAMissingTimeLastThenTheNewestMail() {
        let sections = NotificationSections(
            [
                thread("all_day_new", date: "2026-11-16", hoursAgo: 1),
                thread("evening", date: "2026-11-16", time: "18:00", hoursAgo: 9),
                thread("all_day_old", date: "2026-11-16", hoursAgo: 5),
                thread("morning", date: "2026-11-16", time: "09:40", hoursAgo: 2),
                thread("morning_newer", date: "2026-11-16", time: "09:40", hoursAgo: 1),
            ], today: monday)
        #expect(ids(sections.today) == ["morning_newer", "morning", "evening", "all_day_new", "all_day_old"])
        #expect(sections.comingUp.isEmpty && sections.earlier.isEmpty)
        #expect(sections.parts.map(\.title) == ["Today"])
    }

    @Test func comingUpSoonestDateThenTimeAMissingTimeLast() {
        let sections = NotificationSections(
            [
                thread("next_week", date: "2026-11-23", time: "08:00"),
                thread("thursday_all_day", date: "2026-11-19", hoursAgo: 0.5),
                thread("thursday_afternoon", date: "2026-11-19", time: "14:00", hoursAgo: 3),
                thread("tomorrow", date: "2026-11-17", time: "20:00", hoursAgo: 40),
                thread("thursday_morning", date: "2026-11-19", time: "09:00", hoursAgo: 20),
                thread("next_year", date: "2027-01-02"),
            ], today: monday)
        #expect(
            ids(sections.comingUp) == [
                "tomorrow", "thursday_morning", "thursday_afternoon", "thursday_all_day", "next_week", "next_year",
            ])
        #expect(sections.parts.map(\.title) == ["Coming up"])
    }

    @Test func earlierIsThePastAndEverythingWithoutADateNewestMailFirst() {
        // Not read yet: no event at all.
        let notReadYet = MailThread(
            id: "not_read_yet", inboxId: "inb_personal", subject: "Your order",
            lastMessageAt: Date(timeIntervalSince1970: 1_800_000_000), category: .notification)
        let sections = NotificationSections(
            [
                thread("yesterday", date: "2026-11-15", time: "10:00", hoursAgo: 30),
                thread("digest", hoursAgo: 2, status: nil),
                thread("no_status_but_today", date: "2026-11-16", hoursAgo: 3, status: nil),
                thread("no_date", hoursAgo: 1),
                thread("bad_date", date: "16 November", hoursAgo: 4),
                thread("last_month", date: "2026-10-30", hoursAgo: 5),
                notReadYet,
            ], today: monday)
        #expect(
            ids(sections.earlier) == ["not_read_yet", "no_date", "digest", "bad_date", "last_month", "yesterday"])
        // A date without a status still says when it matters, so it sorts by its day; its row is Home's.
        #expect(ids(sections.today) == ["no_status_but_today"])
        #expect(sections.comingUp.isEmpty)
        #expect(sections.parts.map(\.title) == ["Today", "Earlier"])
    }

    @Test func anEmptyTab() {
        let sections = NotificationSections([], today: monday)
        #expect(sections.isEmpty && sections.parts.isEmpty && sections.all.isEmpty && sections.rows.isEmpty)
        #expect(CategoryList.emptyWords(for: .notifications) == "No notifications.")
    }

    @Test func aroundMidnightWhereThePersonIs() throws {
        let threads = [
            thread("monday", date: "2026-11-16", time: "15:15"),
            thread("tuesday", date: "2026-11-17", time: "09:00"),
            thread("tuesday_all_day", date: "2026-11-17"),
            thread("wednesday", date: "2026-11-18"),
        ]
        func sections(at moment: String) throws -> NotificationSections {
            NotificationSections(threads, today: CalendarDay(try Date(moment, strategy: .iso8601), in: berlin))
        }
        // A second before midnight in Berlin (22:59:59 UTC): still Monday.
        let before = try sections(at: "2026-11-16T22:59:59Z")
        #expect(ids(before.today) == ["monday"])
        #expect(ids(before.comingUp) == ["tuesday", "tuesday_all_day", "wednesday"])
        #expect(before.earlier.isEmpty)
        // Midnight: Tuesday is today, Monday's parcel is earlier.
        let after = try sections(at: "2026-11-16T23:00:00Z")
        #expect(ids(after.today) == ["tuesday", "tuesday_all_day"])
        #expect(ids(after.comingUp) == ["wednesday"])
        #expect(ids(after.earlier) == ["monday"])
    }

    @Test func theDateIsComparedAsWrittenNeverConverted() throws {
        let threads = [thread("evening", date: "2026-11-16", time: "23:30"), thread("next", date: "2026-11-17")]
        // One moment, 04:00 UTC on Tuesday: Monday evening in Los Angeles, Tuesday morning in Berlin.
        let moment = try Date("2026-11-17T04:00:00Z", strategy: .iso8601)
        let losAngeles = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let west = NotificationSections(threads, today: CalendarDay(moment, in: losAngeles))
        #expect(ids(west.today) == ["evening"] && ids(west.comingUp) == ["next"])
        let east = NotificationSections(threads, today: CalendarDay(moment, in: berlin))
        #expect(ids(east.today) == ["next"] && ids(east.earlier) == ["evening"])
    }

    @Test func aNotificationMovedAwayLeavesAndOneMovedInJoins() async throws {
        let store = try await MailStore.sample()
        func sections() -> NotificationSections {
            NotificationSections(store.lists, inbox: nil, today: monday, now: store.now)
        }
        // The parcel re-sorted as a conversation: its `thread.changed` comes without the event.
        var parcel = try #require(store.lists.thread(id: "thr_19"))
        parcel.category = .conversation
        parcel.event = nil
        parcel.version += 1
        await store.receive(.threadChanged(parcel))
        #expect(sections().today.isEmpty)
        #expect(!ids(sections().all).contains("thr_19"))
        // A conversation re-sorted as a notification, not read yet: Earlier, by its mail (16 Nov 08:52, the newest).
        var joining = try #require(store.lists.thread(id: "thr_1"))
        joining.category = .notification
        joining.version += 1
        await store.receive(.threadChanged(joining))
        #expect(ids(sections().earlier).first == "thr_1")
    }
}
