import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The Feed, Receipts and Notifications tabs: a tab's categories as one list from the copy, newest first, in one inbox
/// or all.
@MainActor
struct CategoryListTests {
    private func thread(_ id: String, _ category: UsualMailKit.Category, minutesAgo: Double) -> MailThread {
        MailThread(
            id: id, inboxId: "inb_northwind", subject: id,
            lastMessageAt: Date(timeIntervalSince1970: 1_800_000_000 - minutesAgo * 60), category: category)
    }

    @Test func theFeedIsEveryNewsletterNewestFirst() async throws {
        let store = try await MailStore.sample()
        let list = CategoryList(store.lists, tab: .reads, inbox: nil, now: store.now)
        // The sample's two newsletters, in two inboxes.
        #expect(list.threads.map(\.id) == ["thr_8", "thr_4"])
        #expect(list.threads.allSatisfy { $0.category == .newsletter })
    }

    @Test func receiptsAreInvoicesAndReceiptsAsOneListByTime() async throws {
        let store = try await MailStore.sample()
        let list = CategoryList(store.lists, tab: .receipts, inbox: nil, now: store.now)
        // The invoice (15 Nov) above the refund (14 Nov), the hosting bill charged automatically (13 Nov) and the
        // pinned train tickets (11 Nov, on a stack, still listed); the receipt that is done (thr_3) never.
        #expect(list.threads.map(\.id) == ["thr_6", "thr_17", "thr_18", "thr_10"])
    }

    @Test func oneProfileShowsOneInbox() async throws {
        let store = try await MailStore.sample()
        #expect(
            CategoryList(store.lists, tab: .reads, inbox: "inb_harbor", now: store.now).threads.map(\.id) == ["thr_8"])
        #expect(
            CategoryList(store.lists, tab: .receipts, inbox: "inb_personal", now: store.now).threads.map(\.id) == [
                "thr_17", "thr_18", "thr_10",
            ])
        #expect(CategoryList(store.lists, tab: .receipts, inbox: "inb_northwind", now: store.now).threads.isEmpty)
    }

    @Test func mergedNewestFirstEqualTimesByIdDescendingOnceEach() {
        let lists = MailLists(categories: [
            .invoice: [thread("thr_a", .invoice, minutesAgo: 10), thread("thr_c", .invoice, minutesAgo: 30)],
            .receipt: [
                thread("thr_d", .receipt, minutesAgo: 5), thread("thr_b", .receipt, minutesAgo: 10),
                // A copy that somehow holds a thread twice still shows it once.
                thread("thr_a", .invoice, minutesAgo: 10),
            ],
            .newsletter: [thread("thr_n", .newsletter, minutesAgo: 1)],
        ])
        let list = CategoryList(
            lists, categories: [.invoice, .receipt, .invoice], inbox: nil,
            now: Date(timeIntervalSince1970: 1_800_000_000))
        #expect(list.threads.map(\.id) == ["thr_d", "thr_b", "thr_a", "thr_c"])
    }

    @Test func onlyReceiptsRowsCarryMoneyWords() async throws {
        let store = try await MailStore.sample()
        let gb = Locale(identifier: "en_GB")
        let receipts = CategoryList(store.lists, tab: .receipts, inbox: nil, now: store.now)
        // The state first in each title, so no row needs the kind word any more.
        #expect(
            receipts.threads.map { CategoryList.words(for: $0, on: .receipts, locale: gb)?.title } == [
                "To be paid: €1,240.00 to Kestrel Roasters", "Refunded: €12.00 by Lumen Outdoor",
                "Will be charged: €12.50 by Cloudbase Hosting", "Paid to Rail Booking",
            ])
        // Notifications and the feed keep Home's words, even for a receipt that is somehow there.
        for tab in [Tab.notifications, .reads, .home] {
            #expect(receipts.threads.allSatisfy { CategoryList.words(for: $0, on: tab) == nil })
        }
    }

    @Test func theTabsAreCalledFeedAndReceipts() {
        // The design's name for the reading tab (Figma frame "MacBook Pro 14" - 2"); its launch option stays `reads`.
        #expect(Tab.reads.title == "Feed" && Tab.reads.rawValue == "reads")
        #expect(Tab.receipts.title == "Receipts")
        #expect(CategoryList.emptyWords(for: .reads) == "Nothing to read.")
        #expect(CategoryList.emptyWords(for: .receipts) == "No receipts or invoices.")
    }

    // MARK: Notifications

    @Test func theTabsInOrderWithTheCategoryTabsTogether() {
        // Notifications right after Receipts, so Feed, Receipts and Notifications sit together; the person's lists
        // are the rail's since 2026-11-19.
        #expect(Tab.allCases == [.home, .reads, .receipts, .notifications])
    }

    @Test func theNotificationsTab() {
        #expect(Tab.notifications.title == "Notifications")
        #expect(Tab.notifications.rawValue == "notifications")
        #expect(Tab.notifications.categories == [.notification])
        #expect(Tab.notifications.icon == .notifications)
        #expect(Icon.notifications.rawValue == "notification-square")
        // Not Snoozed's bell.
        #expect(Tab.notifications.icon != Place.snoozed.icon)
        #expect(CategoryList.emptyWords(for: .notifications) == "No notifications.")
    }

    @Test func notificationsAreTheSamplesNotificationsInTheirInbox() async throws {
        let store = try await MailStore.sample()
        let list = CategoryList(store.lists, tab: .notifications, inbox: nil, now: store.now)
        // The sample's eight notifications, all in the personal inbox, newest first: the parcel out for delivery, the
        // check-up moved, the order not read yet ("Your order has shipped"), the digest, the check-up confirmed, then
        // the boots delivered, out for delivery and arriving. One thread each: the tab groups them into rows.
        let notifications = ["thr_19", "thr_25", "thr_11", "thr_22", "thr_20", "thr_21", "thr_24", "thr_23"]
        #expect(list.threads.map(\.id) == notifications)
        #expect(list.threads.allSatisfy { $0.category == .notification })
        // No money words on any row; the tab's own words are the event's (`EventWords`).
        #expect(list.threads.allSatisfy { CategoryList.words(for: $0, on: .notifications) == nil })
        #expect(
            CategoryList(store.lists, tab: .notifications, inbox: "inb_personal", now: store.now).threads.map(\.id)
                == notifications)
        #expect(CategoryList(store.lists, tab: .notifications, inbox: "inb_northwind", now: store.now).threads.isEmpty)
    }

    @Test func aDoneScreenedOrSnoozedNotificationIsntListedAStackedOneIs() async throws {
        let store = try await MailStore.sample()
        // Whether the order notification is listed at `now`; the sample's other notifications stay as they are.
        func listed(at now: Date = SampleData.bundled.now) -> Bool {
            CategoryList(store.lists, tab: .notifications, inbox: nil, now: now).threads.map(\.id).contains("thr_11")
        }
        var thread = try #require(store.lists.thread(id: "thr_11"))

        // On a stack: still listed, as the contract's category lists hold it.
        thread.stack = .setAside
        thread.version += 1
        await store.receive(.threadChanged(thread))
        #expect(listed())
        // Waiting to come back: out of sight until it does (the coordinator's decision of 2026-11-20).
        thread.stack = nil
        thread.comeBackAt = SampleData.bundled.now.addingTimeInterval(86_400)
        thread.version += 1
        await store.receive(.threadChanged(thread))
        #expect(!listed())
        #expect(listed(at: SampleData.bundled.now.addingTimeInterval(86_400)))

        // Screened: only in the screening list.
        thread.comeBackAt = nil
        thread.screened = true
        thread.version += 1
        await store.receive(.threadChanged(thread))
        #expect(!listed())

        // Let in, then done: in no list.
        thread.screened = false
        thread.version += 1
        await store.receive(.threadChanged(thread))
        #expect(listed())
        thread.done = true
        thread.version += 1
        await store.receive(.threadChanged(thread))
        #expect(!listed())
    }

    @Test func mailMovedToNotificationsJoinsAndMailMovedAwayLeaves() async throws {
        let store = try await MailStore.sample()
        func notifications() -> [String] {
            CategoryList(store.lists, tab: .notifications, inbox: nil, now: store.now).threads.map(\.id)
        }

        // A conversation re-sorted as a notification joins, newest first (16 Nov 08:52, above the parcel's 07:05).
        var joining = try #require(store.lists.thread(id: "thr_1"))
        joining.category = .notification
        joining.version += 1
        await store.receive(.threadChanged(joining))
        #expect(
            notifications() == [
                "thr_1", "thr_19", "thr_25", "thr_11", "thr_22", "thr_20", "thr_21", "thr_24", "thr_23",
            ])

        // The order notification re-sorted as a receipt leaves for Receipts.
        var leaving = try #require(store.lists.thread(id: "thr_11"))
        leaving.category = .receipt
        leaving.version += 1
        await store.receive(.threadChanged(leaving))
        #expect(notifications() == ["thr_1", "thr_19", "thr_25", "thr_22", "thr_20", "thr_21", "thr_24", "thr_23"])
        #expect(
            CategoryList(store.lists, tab: .receipts, inbox: nil, now: store.now).threads.map(\.id).contains("thr_11"))
    }
}
