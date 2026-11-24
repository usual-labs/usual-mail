import Foundation
import UsualMailKit

/// The screening list grouped by sender: first mail from people who haven't been let in, one row per sender in an
/// inbox, the newest on top with the sender's older mail under it.
struct ScreeningList: Equatable {
    struct Group: Equatable, Identifiable {
        /// Newest first; the first is the one shown.
        let threads: [MailThread]

        var latest: MailThread { threads[0] }
        var older: [MailThread] { Array(threads.dropFirst()) }
        var id: String { latest.id }
    }

    let groups: [Group]

    /// `threads` as the screening list gives them, newest first. Threads without a `sender` stand alone.
    init(_ threads: [MailThread]) {
        var order: [String] = []
        var byKey: [String: [MailThread]] = [:]
        for thread in threads {
            let key = thread.sender.map { "\(thread.inboxId)\u{0}\($0.lowercased())" } ?? "thread\u{0}\(thread.id)"
            if byKey[key] == nil { order.append(key) }
            byKey[key, default: []].append(thread)
        }
        groups = order.compactMap { byKey[$0] }.map(Group.init)
    }

    init(_ lists: MailLists, inbox inboxId: String?) {
        self.init(lists.screening(inbox: inboxId))
    }

    /// "16 New Items", "1 New Item": every screened mail, not every sender.
    static func title(count: Int) -> String {
        count == 1 ? "1 New Item" : "\(count) New Items"
    }

    /// "Maya Kim (maya@example.com)", or the address alone.
    static func who(_ address: Address) -> String {
        guard let name = address.name, !name.isEmpty, name != address.email else { return address.email }
        return "\(name) (\(address.email))"
    }

    /// What it is about: the summary, or the mail's opening words while there is none. Never the sender again.
    static func about(_ thread: MailThread) -> String {
        let summary = thread.summary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return summary.isEmpty ? thread.snippet.trimmingCharacters(in: .whitespacesAndNewlines) : summary
    }
}
