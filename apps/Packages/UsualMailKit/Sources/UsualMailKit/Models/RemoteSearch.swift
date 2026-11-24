import Foundation

// Mirrors of remote search's shapes in `core/src/search.ts` (docs/contract-search.md, "Older mail in the mailbox"):
// older mail found in each inbox's mailbox, which the server doesn't hold, and how each inbox answered.

/// One conversation found in the mailbox itself that the server doesn't hold (`RemoteHit` in core). Nothing of it is
/// stored. `id` is the same for the same conversation across pages and searches, and opens it.
public struct RemoteHit: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var inboxId: String
    public var subject: String
    /// The sender of its newest message.
    public var from: Address
    public var lastMessageAt: Date
    /// The mailbox provider's own preview, plain text.
    public var snippet: String
    public var hasAttachments: Bool
    public var messageCount: Int
    /// True when no message of it is in the mailbox's inbox: opened, it arrives done.
    public var archived: Bool

    public init(
        id: String, inboxId: String, subject: String, from: Address, lastMessageAt: Date, snippet: String = "",
        hasAttachments: Bool = false, messageCount: Int = 1, archived: Bool = false
    ) {
        self.id = id
        self.inboxId = inboxId
        self.subject = subject
        self.from = from
        self.lastMessageAt = lastMessageAt
        self.snippet = snippet
        self.hasAttachments = hasAttachments
        self.messageCount = messageCount
        self.archived = archived
    }
}

/// How one inbox answered a remote search (`RemoteInboxState["state"]` in core).
public enum RemoteInboxStatus: OpenEnum {
    case ok
    /// Its provider can't search the mailbox (IMAP for now).
    case unsupported
    /// The person paused it.
    case paused
    /// The mailbox refused the sign-in: Sign in with Google again.
    case needsSignIn
    /// The mailbox refused or failed, in the state's `message`.
    case providerError
    case unknown(String)

    public static let known: [RemoteInboxStatus] = [.ok, .unsupported, .paused, .needsSignIn, .providerError]

    public var rawValue: String {
        switch self {
        case .ok: "ok"
        case .unsupported: "unsupported"
        case .paused: "paused"
        case .needsSignIn: "needs_sign_in"
        case .providerError: "provider_error"
        case .unknown(let raw): raw
        }
    }
}

/// How one inbox answered (`RemoteInboxState` in core). One inbox failing doesn't fail the others.
public struct RemoteInboxState: Codable, Hashable, Sendable {
    public var inboxId: String
    public var state: RemoteInboxStatus
    /// The provider's or the server's words, for every state but `ok`.
    public var message: String?

    public init(inboxId: String, state: RemoteInboxStatus, message: String? = nil) {
        self.inboxId = inboxId
        self.state = state
        self.message = message
    }
}

/// The answer of `GET /v1/search/remote` (`RemoteSearchResult` in core).
public struct RemoteSearchResult: Codable, Hashable, Sendable {
    public var items: [RemoteHit]
    public var nextCursor: String?
    public var understood: SearchUnderstood
    /// One per inbox searched, in the inbox list's order.
    public var inboxes: [RemoteInboxState]

    public init(
        items: [RemoteHit], nextCursor: String? = nil, understood: SearchUnderstood = SearchUnderstood(),
        inboxes: [RemoteInboxState] = []
    ) {
        self.items = items
        self.nextCursor = nextCursor
        self.understood = understood
        self.inboxes = inboxes
    }
}
