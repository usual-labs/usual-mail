import Foundation

/// The blocked senders a person's device knows, in the server's order: the newest block first (the whole second of
/// `blockedAt`, then inbox and address, descending; docs/contract.md, "Blocked senders"). One row per sender in an
/// inbox (`SenderKey`). `sender.changed` events keep it current; there is no version, so the newest event wins.
///
/// Each row's `unsubscribe` is the newest this device has seen for that sender, from the row itself or from
/// `unsubscribe.changed` (docs/contract.md, "Unsubscribing"): of two copies the higher version is kept, whichever came
/// first. One seen before its sender's row (the app blocks, then asks, and the events may come in either order) is kept
/// and given to the row when it comes.
public struct BlockedSenderList: Hashable, Sendable {
    public private(set) var items: [BlockedSender]
    /// The newest unsubscribe seen per sender, rows or not.
    private var unsubscribes: [SenderKey: Unsubscribe] = [:]

    public init(_ items: [BlockedSender] = []) {
        self.items = []
        for sender in Self.unique(items) { keepNewest(sender.unsubscribe) }
        self.items = Self.sorted(Self.unique(items).map(withNewestUnsubscribe))
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

    /// `unsubscribe.changed`, or the answer to asking: the sender's row shows it unless it already has a higher
    /// version. Kept for a sender with no row yet.
    public mutating func apply(_ unsubscribe: Unsubscribe) {
        keepNewest(unsubscribe)
        guard let index = items.firstIndex(where: { $0.id == unsubscribe.key }) else { return }
        items[index] = withNewestUnsubscribe(items[index])
    }

    /// Puts a sender in, in place of any row for the same sender, in the list's order, with the newest unsubscribe
    /// known for them.
    public mutating func insert(_ sender: BlockedSender) {
        keepNewest(sender.unsubscribe)
        items.removeAll { $0.id == sender.id }
        items.append(withNewestUnsubscribe(sender))
        items = Self.sorted(items)
    }

    public mutating func remove(_ key: SenderKey) {
        items.removeAll { $0.id == key }
    }

    /// Keeps `unsubscribe` unless a copy with a higher version is already kept; of equal versions, the later one.
    private mutating func keepNewest(_ unsubscribe: Unsubscribe?) {
        guard let unsubscribe else { return }
        if let kept = unsubscribes[unsubscribe.key], kept.version > unsubscribe.version { return }
        unsubscribes[unsubscribe.key] = unsubscribe
    }

    private func withNewestUnsubscribe(_ sender: BlockedSender) -> BlockedSender {
        var sender = sender
        if let newest = unsubscribes[sender.id] { sender.unsubscribe = newest }
        return sender
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
