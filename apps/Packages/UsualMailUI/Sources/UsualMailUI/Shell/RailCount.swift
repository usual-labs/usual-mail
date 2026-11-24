import UsualMailKit

/// How many threads To reply, Pinned and Snoozed hold, as the server counts them (`Counts`, from the refresh and
/// `counts.changed`), in every inbox, always: those lists are stacks of their own, which no profile scopes (the
/// coordinator's spec of 2026-11-20). To reply is the `reply_later` stack, Pinned the `set_aside` stack, Snoozed the
/// waiting list. Never counted from the copy, which may not hold every thread; nothing before the first counts. No
/// other rail button has a count.
enum RailCount {
    static func count(_ place: Place, in counts: Counts?) -> Int {
        guard let counts = counts?.counts(for: nil) else { return 0 }
        return switch place {
        case .toReply: counts.count(on: .replyLater)
        case .pinned: counts.count(on: .setAside)
        case .snoozed: counts.waiting
        default: 0
        }
    }

    /// A count as the rail shows it: nothing for none, "99+" above 99.
    static func words(_ count: Int) -> String? {
        switch count {
        case ...0: nil
        case 1...99: "\(count)"
        default: "99+"
        }
    }
}
