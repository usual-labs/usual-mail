import Foundation

/// A sender blocked in one inbox (`BlockedSender` in core), as `GET /v1/senders?state=blocked` lists them, the newest
/// block first (docs/contract.md, "Blocked senders"). Settings' Blocked tab shows them (`MailStore.blockedSenders`).
public struct BlockedSender: Codable, Hashable, Sendable, Identifiable {
    public var inboxId: String
    /// The blocked address, lower case.
    public var address: String
    /// The name their newest stored mail gives; nil when none does.
    public var name: String?
    /// When the block in force now was applied.
    public var blockedAt: Date
    /// Who blocked them, as that action's record says it; nil when no record of it is left.
    public var blockedBy: Doer?
    /// How many messages from this address the server holds in this inbox dated after `blockedAt`.
    public var messagesSinceBlocked: Int
    /// The date of their newest stored mail in this inbox; nil (the contract's `null`) when none is held.
    public var lastMessageAt: Date?
    /// Asking them to stop, when a person unsubscribed from them in this inbox (docs/contract.md, "Unsubscribing").
    public var unsubscribe: Unsubscribe?

    public init(
        inboxId: String, address: String, name: String? = nil, blockedAt: Date, blockedBy: Doer? = nil,
        messagesSinceBlocked: Int = 0, lastMessageAt: Date? = nil, unsubscribe: Unsubscribe? = nil
    ) {
        self.inboxId = inboxId
        self.address = address
        self.name = name
        self.blockedAt = blockedAt
        self.blockedBy = blockedBy
        self.messagesSinceBlocked = messagesSinceBlocked
        self.lastMessageAt = lastMessageAt
        self.unsubscribe = unsubscribe
    }

    /// Who they are: the inbox and the address, compared without case.
    public var id: SenderKey { SenderKey(inboxId: inboxId, address: address) }

    private enum CodingKeys: String, CodingKey {
        case inboxId, address, name, blockedAt, blockedBy, messagesSinceBlocked, lastMessageAt, unsubscribe
    }

    /// `name`, `blockedBy` and `unsubscribe` are written only when present; `lastMessageAt` always, as `null` when
    /// there is none.
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(inboxId, forKey: .inboxId)
        try container.encode(address, forKey: .address)
        try container.encodeIfPresent(name, forKey: .name)
        try container.encode(blockedAt, forKey: .blockedAt)
        try container.encodeIfPresent(blockedBy, forKey: .blockedBy)
        try container.encode(messagesSinceBlocked, forKey: .messagesSinceBlocked)
        try container.encode(lastMessageAt, forKey: .lastMessageAt)
        try container.encodeIfPresent(unsubscribe, forKey: .unsubscribe)
    }
}

/// A sender in one inbox: the identity of a `BlockedSender` and of a `sender.changed` event. The address is compared
/// without case, as the server compares it.
public struct SenderKey: Hashable, Sendable {
    public let inboxId: String
    public let address: String

    public init(inboxId: String, address: String) {
        self.inboxId = inboxId
        self.address = address.lowercased()
    }
}

/// `sender.changed`: a sender became blocked or stopped being blocked, by any way, or mail from a blocked sender was
/// stored. `sender` is their item as it is now while blocked, and absent once they aren't. It carries no version: the
/// newest event wins.
public struct SenderChange: Codable, Hashable, Sendable {
    public var inboxId: String
    public var address: String
    public var blocked: Bool
    public var sender: BlockedSender?

    public init(inboxId: String, address: String, blocked: Bool, sender: BlockedSender? = nil) {
        self.inboxId = inboxId
        self.address = address
        self.blocked = blocked
        self.sender = sender
    }

    public var key: SenderKey { SenderKey(inboxId: inboxId, address: address) }
}
