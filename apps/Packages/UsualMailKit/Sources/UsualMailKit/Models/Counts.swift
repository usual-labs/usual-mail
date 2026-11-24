import Foundation

/// How many threads are in each list, as docs/contract.md's "Lists" defines them (`ThreadCounts` in core). Tab badges
/// and Home's New count come from here, not from counting the copy on the device, which may not hold every thread.
public struct ThreadCounts: Codable, Hashable, Sendable {
    /// Home.
    public var home: Int
    /// Home's unread threads: its New, for now.
    public var unread: Int
    /// Each category's list. A category this app doesn't know is kept under its own value.
    public var categories: [Category: Int]
    /// Each stack's list.
    public var stacks: [Stack: Int]
    /// The waiting list: threads whose come-back time is ahead.
    public var waiting: Int
    /// The screening list.
    public var screened: Int

    public init(
        home: Int = 0, unread: Int = 0, categories: [Category: Int] = [:], stacks: [Stack: Int] = [:], waiting: Int = 0,
        screened: Int = 0
    ) {
        self.home = home
        self.unread = unread
        self.categories = categories
        self.stacks = stacks
        self.waiting = waiting
        self.screened = screened
    }

    /// The length of a category's list; 0 when the server doesn't count it.
    public func count(in category: Category) -> Int {
        categories[category] ?? 0
    }

    /// The length of a stack's list; 0 when the server doesn't count it.
    public func count(on stack: Stack) -> Int {
        stacks[stack] ?? 0
    }

    /// These counts less `other`'s, list by list: what `all` holds once an inbox is gone.
    func subtracting(_ other: ThreadCounts) -> ThreadCounts {
        ThreadCounts(
            home: home - other.home, unread: unread - other.unread,
            categories: categories.merging(other.categories.mapValues { -$0 }, uniquingKeysWith: +),
            stacks: stacks.merging(other.stacks.mapValues { -$0 }, uniquingKeysWith: +),
            waiting: waiting - other.waiting, screened: screened - other.screened)
    }
}

/// One inbox's counts (`InboxCounts` in core): its id with the lists' counts beside it in the same JSON object.
@dynamicMemberLookup
public struct InboxCounts: Codable, Hashable, Sendable {
    public var inboxId: String
    public var counts: ThreadCounts

    public init(inboxId: String, counts: ThreadCounts) {
        self.inboxId = inboxId
        self.counts = counts
    }

    public subscript<Value>(dynamicMember keyPath: KeyPath<ThreadCounts, Value>) -> Value {
        counts[keyPath: keyPath]
    }

    private enum Key: String, CodingKey {
        case inboxId
    }

    public init(from decoder: any Decoder) throws {
        inboxId = try decoder.container(keyedBy: Key.self).decode(String.self, forKey: .inboxId)
        counts = try ThreadCounts(from: decoder)
    }

    public func encode(to encoder: any Encoder) throws {
        try counts.encode(to: encoder)
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(inboxId, forKey: .inboxId)
    }
}

/// Counts for every inbox the caller may see, and for all of them together (`Counts` in core). `counts.changed`
/// carries the latest, at most once a second.
public struct Counts: Codable, Hashable, Sendable, Versioned {
    /// The sum of `inboxes`.
    public var all: ThreadCounts
    /// One per inbox, in the inbox list's order.
    public var inboxes: [InboxCounts]
    /// Rises whenever a count changes, maybe by more than one. Of two copies, keep the higher.
    public var version: Int

    public init(all: ThreadCounts, inboxes: [InboxCounts], version: Int) {
        self.all = all
        self.inboxes = inboxes
        self.version = version
    }

    /// One inbox's counts, or every inbox's together when `inboxId` is nil. Nil for an inbox the counts don't hold.
    public func counts(for inboxId: String?) -> ThreadCounts? {
        guard let inboxId else { return all }
        return inboxes.first { $0.inboxId == inboxId }?.counts
    }

    /// The counts without the inboxes not in `kept`, `all` lowered to match: what a client holds once an inbox is
    /// removed, until the server's next counts arrive. The version stays.
    func keepingOnly(inboxes kept: Set<String>) -> Counts {
        let gone = inboxes.filter { !kept.contains($0.inboxId) }
        guard !gone.isEmpty else { return self }
        return Counts(
            all: gone.reduce(all) { $0.subtracting($1.counts) }, inboxes: inboxes.filter { kept.contains($0.inboxId) },
            version: version)
    }
}
