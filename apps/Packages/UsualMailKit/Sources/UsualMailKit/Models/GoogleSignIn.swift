import Foundation

// Mirrors of `core/src/google.ts`: connecting Gmail by signing in with Google. The server runs Google's sign-in with
// the Google client its host gave it, receives the answer itself and keeps the token; the app only opens Google's page
// in the browser and asks how it ended.

/// Whether a server can connect Gmail by signing in with Google. Part of `GET /v1/info`.
public struct GoogleSignInInfo: Codable, Hashable, Sendable {
    /// True when the host gave the server a Google client and the server knows its own address.
    public var available: Bool
    /// Where Google sends a person back: `<the server's root>/v1/google/callback`, which the host registers at Google.
    public var redirectUri: String?
    /// What the host still has to give the server, while it isn't available.
    public var missing: [GoogleSignInMissing]?

    public init(available: Bool, redirectUri: String? = nil, missing: [GoogleSignInMissing]? = nil) {
        self.available = available
        self.redirectUri = redirectUri
        self.missing = missing
    }
}

public enum GoogleSignInMissing: OpenEnum {
    /// The host's Google OAuth client.
    case client
    /// The server's own address, which Google sends people back to.
    case address
    case unknown(String)

    public static let known: [GoogleSignInMissing] = [.client, .address]

    public var rawValue: String {
        switch self {
        case .client: "client"
        case .address: "address"
        case .unknown(let raw): raw
        }
    }
}

/// Starting a sign-in (`POST /v1/google/sign-ins`). Person only.
public struct GoogleSignInInput: Encodable, Hashable, Sendable {
    /// Reconnect this Gmail inbox in place. Without it, the sign-in connects a new inbox.
    public var inboxId: String?
    /// For a new inbox only. Default: the mailbox's address.
    public var name: String?
    /// For a new inbox only: `#RRGGBB`.
    public var color: String?
    /// For a new inbox only.
    public var icon: InboxIcon?

    public init(inboxId: String? = nil, name: String? = nil, color: String? = nil, icon: InboxIcon? = nil) {
        self.inboxId = inboxId
        self.name = name
        self.color = color
        self.icon = icon
    }
}

/// A sign-in that was started: the page to open, and how to ask how it ended.
public struct GoogleSignInStart: Codable, Hashable, Sendable {
    public var id: String
    /// Google's sign-in, which sends the person back to the server.
    public var url: String
    /// After this the sign-in can no longer be finished.
    public var expiresAt: Date

    public init(id: String, url: String, expiresAt: Date) {
        self.id = id
        self.url = url
        self.expiresAt = expiresAt
    }
}

/// `waiting` until the person comes back from Google (or it expires), then `connected` or `failed`.
public enum GoogleSignInState: OpenEnum {
    case waiting, connected, failed
    case unknown(String)

    public static let known: [GoogleSignInState] = [.waiting, .connected, .failed]

    public var rawValue: String {
        switch self {
        case .waiting: "waiting"
        case .connected: "connected"
        case .failed: "failed"
        case .unknown(let raw): raw
        }
    }
}

/// Why a sign-in failed.
public enum GoogleSignInFailure: OpenEnum {
    /// The person didn't allow it at Google.
    case declined
    /// They left Gmail access unticked.
    case scopeMissing
    /// Google gave no lasting access.
    case noRefreshToken
    /// Not finished in time.
    case expired
    /// They signed in with another account than the inbox being reconnected.
    case wrongAccount
    /// The device that started it, or the inbox being reconnected, was removed meanwhile.
    case cancelled
    /// Google refused or didn't answer.
    case googleError
    /// Gmail didn't accept the new access.
    case mailboxError
    case unknown(String)

    public static let known: [GoogleSignInFailure] = [
        .declined, .scopeMissing, .noRefreshToken, .expired, .wrongAccount, .cancelled, .googleError, .mailboxError,
    ]

    public var rawValue: String {
        switch self {
        case .declined: "declined"
        case .scopeMissing: "scope_missing"
        case .noRefreshToken: "no_refresh_token"
        case .expired: "expired"
        case .wrongAccount: "wrong_account"
        case .cancelled: "cancelled"
        case .googleError: "google_error"
        case .mailboxError: "mailbox_error"
        case .unknown(let raw): raw
        }
    }
}

/// How a sign-in stands, for the device that started it (`GET /v1/google/sign-ins/:id`).
public struct GoogleSignIn: Codable, Hashable, Sendable {
    public var id: String
    public var state: GoogleSignInState
    /// The inbox being reconnected, or, once `connected`, the inbox connected or reconnected.
    public var inboxId: String?
    /// Once `connected`: true when an existing inbox was reconnected in place.
    public var reconnected: Bool?
    /// Once `failed`: why.
    public var failure: GoogleSignInFailure?
    /// Once it ended: what happened, in words a person can act on.
    public var message: String?
    public var expiresAt: Date

    public init(
        id: String, state: GoogleSignInState, inboxId: String? = nil, reconnected: Bool? = nil,
        failure: GoogleSignInFailure? = nil, message: String? = nil, expiresAt: Date
    ) {
        self.id = id
        self.state = state
        self.inboxId = inboxId
        self.reconnected = reconnected
        self.failure = failure
        self.message = message
        self.expiresAt = expiresAt
    }
}
