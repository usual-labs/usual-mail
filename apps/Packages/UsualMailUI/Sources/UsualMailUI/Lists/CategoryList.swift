import Foundation
import UsualMailKit

/// What a tab of categories shows (Feed: newsletters; Receipts: invoices and receipts; Notifications: notifications):
/// the copy's category lists as one list, as the contract's merged category list is: let in, not done, never trashed,
/// stacked threads included, each thread once, newest first by `lastMessageAt`, equal times by id descending. In one
/// inbox, or all.
///
/// A snoozed thread is out of sight until it comes back (the coordinator's decision of 2026-11-20): only Snoozed lists
/// it while it waits (`MailThread.isWaiting(at:)`, the copy's own test for its waiting list), so a list worked out at
/// `now` leaves it out. The contract's category lists still hold it; this is the app's filter over them. A pinned or
/// reply-later thread stays.
struct CategoryList: Equatable {
    /// Newest first.
    let threads: [MailThread]

    init(_ lists: MailLists, categories: [UsualMailKit.Category], inbox inboxId: String?, now: Date) {
        var named = Set<UsualMailKit.Category>()
        let kinds = categories.filter { named.insert($0.listed).inserted }
        var seen = Set<String>()
        threads = kinds.flatMap { lists.threads(in: $0, inbox: inboxId) }
            .filter { !$0.isWaiting(at: now) && seen.insert($0.id).inserted }
            .sorted { $0.lastMessageAt != $1.lastMessageAt ? $0.lastMessageAt > $1.lastMessageAt : $0.id > $1.id }
    }

    init(_ lists: MailLists, tab: Tab, inbox inboxId: String?, now: Date) {
        self.init(lists, categories: tab.categories, inbox: inboxId, now: now)
    }

    /// A row's own money words: on Receipts, a receipt's or an invoice's (`PaymentWords`); nil on the other tabs.
    /// Notifications' rows take theirs from the event (`EventWords`, in `NotificationsView`).
    static func words(for thread: MailThread, on tab: Tab, locale: Locale = .current) -> PaymentWords? {
        tab == .receipts ? PaymentWords(thread, locale: locale) : nil
    }

    /// What an empty tab says.
    static func emptyWords(for tab: Tab) -> String {
        switch tab {
        case .receipts: "No receipts or invoices."
        case .notifications: "No notifications."
        default: "Nothing to read."
        }
    }
}
