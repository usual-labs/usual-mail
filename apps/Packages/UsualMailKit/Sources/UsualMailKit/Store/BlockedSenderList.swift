import Foundation

/// The blocked senders a person's device knows, in the server's order: the newest block first (the whole second of
/// `blockedAt`, then inbox and address, descending; docs/contract.md, "Blocked senders"). One row per sender in an
/// inbox (`SenderKey`). `sender.changed` events keep it current; there is no version, so the newest event wins.
public struct BlockedSenderList: Hashable, Sendable {
    public private(set) var items: [BlockedSender]

    public init(_ items: [BlockedSender] = []) {
        self.items = Self.sorted(Self.unique(items))
    }

    /// The senders blocked in one inbox, or in every inbox for nil (the profile switch's "all inboxes").
    public func items(in inboxId: String?) -> [BlockedSender] {
        guard let inboxId else { return items }
        return items.filter { $0.inboxId == inboxId }
    }

    public func contains(_ key: SenderKey) -> Bool {
        items.contains { $0.id == key }
    }

    /// `sender.changed`: blocked, the row is put in or replaced with the event's item and the list sorted again; no
    /// longer blocked, the row goes. A blocked event without its item changes nothing it can't know.
    public mutating func apply(_ change: SenderChange) {
        if change.blocked {
            guard let sender = change.sender else { return }
            insert(sender)
        } else {
            remove(change.key)
        }
    }

    /// Puts a sender in, in place of any row for the same sender, in the list's order.
    public mutating func insert(_ sender: BlockedSender) {
        items.removeAll { $0.id == sender.id }
        items.append(sender)
        items = Self.sorted(items)
    }

    public mutating func remove(_ key: SenderKey) {
        items.removeAll { $0.id == key }
    }

    /// The server's order: the newest block first by whole seconds, then inbox and address, descending.
    static func sorted(_ items: [BlockedSender]) -> [BlockedSender] {
        items.sorted { a, b in
            let (secondA, secondB) = (
                a.blockedAt.timeIntervalSince1970.rounded(.down),
                b.blockedAt.timeIntervalSince1970.rounded(.down)
            )
            if secondA != secondB { return secondA > secondB }
            if a.inboxId != b.inboxId { return a.inboxId > b.inboxId }
            return a.address.lowercased() > b.address.lowercased()
        }
    }

    /// The last row for each sender, so a page that repeats one keeps a single row.
    private static func unique(_ items: [BlockedSender]) -> [BlockedSender] {
        var seen = Set<SenderKey>()
        return items.reversed().filter { seen.insert($0.id).inserted }.reversed()
    }
}
