import Foundation
import UsualMailKit

/// One row of the Notifications tab (docs/contract.md, "Notification groups"; the owner's "Build one row per parcel or
/// appointment next?", "Yes, build it", of 2026-11-19): every thread of one notification group, shown as the one with
/// the newest mail, or a thread without a group on its own. The group is the server's `event.group`, only ever
/// compared.
struct NotificationRow: Equatable, Identifiable {
    /// Newest mail first (`lastMessageAt`, equal times by id descending); never empty.
    let threads: [MailThread]
    /// The group's, so a row stays the same row as its threads come and go; a thread's own without a group.
    let id: String

    /// The thread the row shows: the one with the newest mail.
    var shown: MailThread { threads[0] }
    /// The threads behind it, newest first: what its count expands.
    var older: [MailThread] { Array(threads.dropFirst()) }
    /// Whether the row stands for more than one thread.
    var isGroup: Bool { threads.count > 1 }
    /// Unread when any of its threads is.
    var unread: Bool { threads.contains(where: \.unread) }
    /// How many threads the row stands for ("3 updates"), only when there are two or more.
    var count: String? { isGroup ? "\(threads.count) updates" : nil }
    /// The ids of the threads it stands for, newest first.
    var threadIDs: [String] { threads.map(\.id) }
    /// What opening a group's row marks read besides opening its newest: every unread thread of the group, as one
    /// action. None for a row of one thread, whose opening marks it as any mail's does.
    var readOnOpening: [String] { isGroup ? threads.filter(\.unread).map(\.id) : [] }

    /// `threads` (any order) as rows: one per group in an inbox, one per thread without a group, each in the order of
    /// the row's newest mail. An empty group counts as none.
    static func rows(_ threads: [MailThread]) -> [NotificationRow] {
        var order: [String] = []
        var byKey: [String: [MailThread]] = [:]
        for thread in threads.sorted(by: newest) {
            let key = key(of: thread)
            if byKey[key] == nil { order.append(key) }
            byKey[key, default: []].append(thread)
        }
        return order.compactMap { key in byKey[key].map { NotificationRow(threads: $0, id: key) } }
    }

    /// The row a thread belongs to: its inbox and group, else the thread alone.
    private static func key(of thread: MailThread) -> String {
        guard let group = thread.event?.group, !group.isEmpty else { return "thread\u{0}\(thread.id)" }
        return "group\u{0}\(thread.inboxId)\u{0}\(group)"
    }

    /// Newest mail first, equal times by id descending, as the lists sort.
    static func newest(_ lhs: MailThread, _ rhs: MailThread) -> Bool {
        lhs.lastMessageAt != rhs.lastMessageAt ? lhs.lastMessageAt > rhs.lastMessageAt : lhs.id > rhs.id
    }
}

/// Which notification groups show their older rows, kept by the window for the session (coordinator's decision of
/// 2026-11-19): by the row's id, with the threads it had when expanded, so a group whose threads change (one archived,
/// new mail joining) shows collapsed again.
struct ExpandedGroups: Equatable {
    private var members: [String: Set<String>] = [:]

    func isExpanded(_ row: NotificationRow) -> Bool {
        row.isGroup && members[row.id] == Set(row.threadIDs)
    }

    /// Expands a collapsed group, collapses an expanded one.
    mutating func toggle(_ row: NotificationRow) {
        members[row.id] = isExpanded(row) ? nil : Set(row.threadIDs)
    }

    /// Forgets the groups among `rows` whose threads changed since they were expanded, so they stay collapsed even if
    /// the change is taken back.
    mutating func forgetChanged(_ rows: [NotificationRow]) {
        for row in rows where members[row.id] != nil && !isExpanded(row) {
            members[row.id] = nil
        }
    }
}
