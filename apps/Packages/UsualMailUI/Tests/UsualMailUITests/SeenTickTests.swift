import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The seen tick on the Notifications tab's rows (owner's words of 2026-11-20; the coordinator's decision: seen is the
/// threads' read state, nothing new on the server): what it shows and says, a group seen only when every thread is read
/// and what a click marks, the dimmed look, a click that neither opens the row nor moves it, and the row's menu agreeing
/// with it. There is no pointer, so the click is covered only here, by what it does.
@MainActor
struct SeenTickTests {
    private let today = CalendarDay("2026-11-16")!

    private func thread(_ id: String, group: String? = nil, hoursAgo: Double = 1, unread: Bool = false) -> MailThread {
        MailThread(
            id: id, inboxId: "inb_personal", subject: id,
            lastMessageAt: Date(timeIntervalSince1970: 1_800_000_000 - hoursAgo * 3600), unread: unread,
            category: .notification, event: NotificationEvent(status: "Update", group: group))
    }

    /// The sample's Notifications rows as the tab shows them, on its Monday.
    private func rows(_ store: MailStore) -> [NotificationRow] {
        NotificationSections(store.lists, inbox: nil, today: today, now: store.now).rows
    }

    @Test func anUnseenRowShowsAnEmptyRingAndOffersToMarkItSeen() {
        let state = SeenState([thread("parcel", unread: true)])
        #expect(!state.isSeen)
        #expect(state.icon == .unseen && state.icon.rawValue == "circle")
        #expect(state.words == "Mark as seen")
        #expect(state.click == .read(["parcel"]))
        // Always shown, under the pointer or not.
        #expect(state.showsTick(hovered: false) && state.showsTick(hovered: true))
    }

    @Test func aSeenRowShowsTheTickedRingOnHoverAndOffersToMarkItUnseen() {
        let state = SeenState([thread("parcel")])
        #expect(state.isSeen)
        #expect(state.icon == .seen && state.icon.rawValue == "checkmark-circle-02")
        #expect(state.words == "Mark as unseen")
        #expect(state.click == .unread(["parcel"]))
        // Only while the pointer is over the row.
        #expect(!state.showsTick(hovered: false) && state.showsTick(hovered: true))
    }

    @Test func aGroupIsSeenOnlyWhenEveryThreadIsRead() {
        let rows = NotificationRow.rows([
            thread("newest", group: "a"), thread("middle", group: "a", hoursAgo: 2, unread: true),
            thread("oldest", group: "a", hoursAgo: 3, unread: true),
            thread("done_new", group: "b", hoursAgo: 4), thread("done_old", group: "b", hoursAgo: 5),
        ])
        // Its newest is read, two older ones aren't: unseen, and a click marks those two read.
        let unseen = SeenState(rows[0].threads)
        #expect(!unseen.isSeen && unseen.icon == .unseen)
        #expect(unseen.click == .read(["middle", "oldest"]))
        // Every one read: seen, and a click marks them all unread.
        let seen = SeenState(rows[1].threads)
        #expect(seen.isSeen && seen.icon == .seen)
        #expect(seen.click == .unread(["done_new", "done_old"]))
        // An older row shown under its group's stands for itself only.
        #expect(SeenState([rows[0].older[0]]).click == .read(["middle"]))
        #expect(SeenState([rows[0].shown]).click == .unread(["newest"]))
    }

    @Test func aSeenRowIsDimmedAndAnUnseenOneKeepsTodaysLook() {
        #expect(SeenState([thread("new", unread: true)]).look == .normal)
        let look = SeenState([thread("read")]).look
        #expect(look == .seen && look != .normal)
        // Readable but plainly secondary: the words in the time's grey, the avatar at half, the count lighter still.
        #expect(look.title == Theme.time && look.subtitle == Theme.time)
        #expect(look.avatar == 0.5)
        #expect(look.count == Theme.quietTime)
        // Today's look, which every other list keeps.
        #expect(RowLook.normal.title == Theme.ink && RowLook.normal.subtitle == Theme.secondary)
        #expect(RowLook.normal.avatar == 1 && RowLook.normal.count == Theme.time)
    }

    @Test func tickingNeitherOpensTheRowNorMovesIt() async throws {
        let store = try await heldStore()
        func shown() -> [[String]] {
            NotificationSections(store.lists, inbox: nil, today: today, now: store.now).parts.map { part in
                [part.title] + part.rows.map { $0.threadIDs.joined(separator: " ") }
            }
        }
        let before = shown()
        #expect(
            before == [
                ["Today", "thr_19"], ["Coming up", "thr_25 thr_20"],
                ["Earlier", "thr_11", "thr_22", "thr_21 thr_24 thr_23"],
            ])
        // Today's parcel is unread; the boots' parcel is read, all three threads.
        let parcel = try #require(rows(store).first { $0.shown.id == "thr_19" })
        let boots = try #require(rows(store).first { $0.shown.id == "thr_21" })
        #expect(!SeenState(parcel.threads).isSeen && SeenState(boots.threads).isSeen)

        let seeing = Task { await SeenState(parcel.threads).click.apply(to: store) }
        let unseeing = Task { await SeenState(boots.threads).click.apply(to: store) }
        defer {
            seeing.cancel()
            unseeing.cancel()
        }
        try await waitUntil("both rows turn before the server answers") {
            let now = rows(store)
            return now.first { $0.shown.id == "thr_19" }.map { SeenState($0.threads).isSeen } == true
                && now.first { $0.shown.id == "thr_21" }.map { SeenState($0.threads).isSeen } == false
        }
        // Every thread of the boots' group is unread again.
        #expect(rows(store).first { $0.shown.id == "thr_21" }?.threads.allSatisfy(\.unread) == true)
        // The same sections, rows and order; nothing opened; nothing offered to undo, no question.
        #expect(shown() == before)
        #expect(store.openThreadID == nil && store.openThread == nil)
        #expect(store.lastAction == nil && store.teachPrompt == nil)
    }

    @Test func theRowsMenuAndItsTickAgree() async throws {
        let store = try await heldStore()
        // The menu as a row draws it (`HomeItem`): read or unread as the row reads, a group's as any of its threads.
        func agree(_ row: NotificationRow) -> Bool {
            let menu = RowMenu.items(for: row.shown, unread: row.unread, now: store.now)
            let read = menu.contains(.act("Mark as read", .read))
            let unread = menu.contains(.act("Mark as unread", .unread))
            return SeenState(row.threads).isSeen ? unread && !read : read && !unread
        }
        #expect(rows(store).map { SeenState($0.threads).isSeen } == [false, true, true, true, true])
        #expect(rows(store).allSatisfy(agree))

        // Each row ticked: its menu turns with it.
        let ticks = rows(store).map { row in Task { await SeenState(row.threads).click.apply(to: store) } }
        defer { ticks.forEach { $0.cancel() } }
        try await waitUntil("every row turned") {
            rows(store).map { SeenState($0.threads).isSeen } == [true, false, false, false, false]
        }
        #expect(rows(store).allSatisfy(agree))
    }
}
