import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// One row per parcel or appointment (owner's "Yes, build it" of 2026-11-19; docs/contract.md, "Notification groups"):
/// grouped by the server's `event.group` within an inbox, the newest mail shown, the count, the section from the shown
/// thread, unread if any, threads without a group on their own rows, the row's menu following the group, opening it,
/// and which groups stay expanded.
@MainActor
struct NotificationGroupsTests {
    let monday = CalendarDay("2026-11-16")!
    let berlin = TimeZone(identifier: "Europe/Berlin")!

    private func thread(
        _ id: String, group: String? = nil, hoursAgo: Double = 1, date: String? = nil, unread: Bool = false,
        inbox: String = "inb_personal"
    ) -> MailThread {
        MailThread(
            id: id, inboxId: inbox, subject: id,
            lastMessageAt: Date(timeIntervalSince1970: 1_800_000_000 - hoursAgo * 3600), unread: unread,
            category: .notification,
            event: NotificationEvent(status: "Update", when: date.map { .init(date: $0) }, group: group))
    }

    @Test func oneRowPerGroupShowingItsNewestMail() {
        let rows = NotificationRow.rows([
            thread("arriving", group: "boots", hoursAgo: 60),
            thread("digest", hoursAgo: 2),
            thread("delivered", group: "boots", hoursAgo: 30),
            thread("confirmed", group: "checkup", hoursAgo: 50),
            thread("out_for_delivery", group: "boots", hoursAgo: 40),
            thread("moved", group: "checkup", hoursAgo: 20),
        ])
        // In the order of each row's newest mail; each row's threads newest first.
        #expect(rows.map(\.shown.id) == ["digest", "moved", "delivered"])
        #expect(
            rows.map(\.threadIDs) == [
                ["digest"], ["moved", "confirmed"], ["delivered", "out_for_delivery", "arriving"],
            ])
        #expect(rows[2].older.map(\.id) == ["out_for_delivery", "arriving"])
        // A row keeps its id while its threads change, so it stays the same row.
        let fewer = NotificationRow.rows([
            thread("out_for_delivery", group: "boots"), thread("arriving", group: "boots"),
        ])
        #expect(fewer.map(\.id) == [rows[2].id] && fewer[0].shown.id == "out_for_delivery")
    }

    @Test func equalTimesShowTheHigherIdAsTheLists() {
        let rows = NotificationRow.rows([thread("thr_a", group: "g"), thread("thr_b", group: "g")])
        #expect(rows.map(\.threadIDs) == [["thr_b", "thr_a"]])
    }

    @Test func theCountSaysHowManyThreadsFromTwo() {
        let rows = NotificationRow.rows([
            thread("a1", group: "a"), thread("a2", group: "a", hoursAgo: 2), thread("a3", group: "a", hoursAgo: 3),
            thread("b1", group: "b", hoursAgo: 4), thread("b2", group: "b", hoursAgo: 5),
            thread("c1", group: "c", hoursAgo: 6), thread("single", hoursAgo: 7),
        ])
        #expect(rows.map(\.count) == ["3 updates", "2 updates", nil, nil])
        // A group with one thread listed (the others archived) reads as a single row.
        #expect(rows.map(\.isGroup) == [true, true, false, false])
    }

    @Test func threadsWithoutAGroupStayRowsOfTheirOwn() {
        let rows = NotificationRow.rows([
            thread("one"), thread("two", hoursAgo: 2),
            // The same string in another inbox is another thing.
            thread("here", group: "g", hoursAgo: 3), thread("there", group: "g", hoursAgo: 4, inbox: "inb_northwind"),
            // An empty group is none.
            thread("empty_a", group: "", hoursAgo: 5), thread("empty_b", group: "", hoursAgo: 6),
        ])
        #expect(rows.map(\.threadIDs) == [["one"], ["two"], ["here"], ["there"], ["empty_a"], ["empty_b"]])
        #expect(rows.allSatisfy { !$0.isGroup && $0.count == nil })
    }

    @Test func theSectionIsTheShownThreads() {
        let sections = NotificationSections(
            [
                // Newest says today, an older one said Thursday: Today.
                thread("today_new", group: "a", hoursAgo: 1, date: "2026-11-16"),
                thread("thursday_old", group: "a", hoursAgo: 30, date: "2026-11-19"),
                // Newest has no date (delivered), an older one said tomorrow: Earlier, by its own mail.
                thread("delivered", group: "b", hoursAgo: 2),
                thread("tomorrow_old", group: "b", hoursAgo: 40, date: "2026-11-17"),
                // Newest moved it to Friday, the older said today: Coming up.
                thread("friday_new", group: "c", hoursAgo: 3, date: "2026-11-20"),
                thread("today_old", group: "c", hoursAgo: 50, date: "2026-11-16"),
            ], today: monday)
        #expect(sections.today.map(\.threadIDs) == [["today_new", "thursday_old"]])
        #expect(sections.comingUp.map(\.threadIDs) == [["friday_new", "today_old"]])
        #expect(sections.earlier.map(\.threadIDs) == [["delivered", "tomorrow_old"]])
    }

    @Test func aGroupIsUnreadWhenAnyOfItsThreadsIs() {
        let rows = NotificationRow.rows([
            thread("new_read", group: "a"), thread("old_unread", group: "a", hoursAgo: 2, unread: true),
            thread("all_read_1", group: "b", hoursAgo: 3), thread("all_read_2", group: "b", hoursAgo: 4),
        ])
        #expect(rows.map(\.unread) == [true, false])
        // The row's menu follows the group: read when any is unread, unread when none is.
        let menu = RowMenu.items(for: rows[0].shown, unread: rows[0].unread, now: .now)
        #expect(menu.contains(.act("Mark as read", .read)) && !menu.contains(.act("Mark as unread", .unread)))
        let read = RowMenu.items(for: rows[1].shown, unread: rows[1].unread, now: .now)
        #expect(read.contains(.act("Mark as unread", .unread)) && !read.contains(.act("Mark as read", .read)))
        // A thread opened behind the row has its own.
        #expect(RowMenu.items(for: rows[0].older[0], now: .now).contains(.act("Mark as read", .read)))
    }

    @Test func openingAGroupsRowMarksItsUnreadThreadsAndOneThreadNothingMore() {
        let rows = NotificationRow.rows([
            thread("newest", group: "a", unread: true), thread("middle", group: "a", hoursAgo: 2),
            thread("oldest", group: "a", hoursAgo: 3, unread: true), thread("alone", hoursAgo: 4, unread: true),
        ])
        // Every unread thread of the group, the newest it opens among them, as one action.
        #expect(rows[0].readOnOpening == ["newest", "oldest"])
        // A thread on its own is marked as opening any mail marks it.
        #expect(rows[1].readOnOpening.isEmpty)
        let allRead = NotificationRow.rows([thread("a", group: "g"), thread("b", group: "g", hoursAgo: 2)])
        #expect(allRead[0].readOnOpening.isEmpty)
    }

    @Test func aGroupStaysExpandedUntilItsThreadsChange() {
        let three = NotificationRow.rows([
            thread("delivered", group: "boots"), thread("out", group: "boots", hoursAgo: 2),
            thread("arriving", group: "boots", hoursAgo: 3),
        ])[0]
        var expanded = ExpandedGroups()
        #expect(!expanded.isExpanded(three))
        expanded.toggle(three)
        #expect(expanded.isExpanded(three))
        // New mail in one of them puts it first, but the group's threads are the same: it stays expanded.
        let reordered = NotificationRow.rows([
            thread("delivered", group: "boots", hoursAgo: 4), thread("out", group: "boots"),
            thread("arriving", group: "boots", hoursAgo: 3),
        ])[0]
        expanded.forgetChanged([reordered])
        #expect(reordered.shown.id == "out" && expanded.isExpanded(reordered) && expanded.isExpanded(three))
        // The newest archived on its own: the next newest shows, and the group is collapsed.
        let two = NotificationRow.rows([
            thread("out", group: "boots", hoursAgo: 2), thread("arriving", group: "boots", hoursAgo: 3),
        ])[0]
        #expect(two.shown.id == "out")
        #expect(two.id == three.id && !expanded.isExpanded(two))
        expanded.forgetChanged([two])
        // Taking it back doesn't open it again.
        #expect(!expanded.isExpanded(three))
        // Clicking the count again collapses it.
        expanded.toggle(three)
        expanded.toggle(three)
        #expect(!expanded.isExpanded(three))
        // A thread on its own never expands.
        let single = NotificationRow.rows([thread("alone")])[0]
        expanded.toggle(single)
        #expect(!expanded.isExpanded(single))
    }

    @Test func theSamplesTabOnItsMonday() async throws {
        let store = try await MailStore.sample()
        let today = CalendarDay(store.now, in: berlin)
        let sections = NotificationSections(store.lists, inbox: nil, today: today, now: store.now)
        func words(_ thread: MailThread) -> String {
            let inbox = store.lists.inbox(id: thread.inboxId)
            return EventWords(thread, inbox: inbox, today: today, twelveHour: false, timeZone: berlin)?.title
                ?? thread.subject
        }
        func shown(_ rows: [NotificationRow]) -> [String] {
            rows.map { row in [words(row.shown), row.count].compactMap(\.self).joined(separator: " | ") }
        }
        #expect(shown(sections.today) == ["Out for delivery · today, 15:15–18:15"])
        #expect(shown(sections.comingUp) == ["Appointment moved · Mon 23 Nov, 09:40 | 2 updates"])
        #expect(
            shown(sections.earlier) == [
                "Your order has shipped", "Your weekly digest", "Delivered · Fri 13 Nov | 3 updates",
            ])
        // Behind the rows, newest first.
        #expect(sections.comingUp[0].older.map(words) == ["Appointment confirmed · Mon 23 Nov, 12:00"])
        #expect(
            sections.earlier[2].older.map(words) == [
                "Out for delivery · Fri 13 Nov, 09:00–12:00", "Arriving · Fri 13 Nov",
            ])
        // Only today's parcel is unread; the groups' mails are all read.
        #expect(sections.rows.map(\.unread) == [true, false, false, false, false])
    }
}
