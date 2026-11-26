import Foundation

/// A string union from `core/src/domain.ts` whose values the server may add to later.
///
/// Each conforming enum lists the values this app knows and keeps any other as `.unknown`, so a
/// newer server never makes decoding fail. Unknown values encode back to the same string.
public protocol OpenEnum: RawRepresentable, Codable, Hashable, Sendable, CustomStringConvertible
where RawValue == String {
    /// The values this version of the app understands, in the contract's order.
    static var known: [Self] { get }
    static func unknown(_ rawValue: String) -> Self
}

extension OpenEnum {
    public init(rawValue: String) {
        self = Self.parse(rawValue)
    }

    /// The known value spelled `rawValue`, or `.unknown(rawValue)`.
    public static func parse(_ rawValue: String) -> Self {
        known.first { $0.rawValue == rawValue } ?? .unknown(rawValue)
    }

    public init(from decoder: any Decoder) throws {
        self = Self.parse(try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    /// False for a value a newer server sent that this app doesn't know.
    public var isKnown: Bool { Self.known.contains(self) }

    public var description: String { rawValue }
}

/// Only built providers are named; another kind a newer server sends stays `.unknown`.
public enum ProviderKind: OpenEnum {
    case imap, gmail
    case unknown(String)

    public static let known: [ProviderKind] = [.imap, .gmail]

    public var rawValue: String {
        switch self {
        case .imap: "imap"
        case .gmail: "gmail"
        case .unknown(let raw): raw
        }
    }
}

/// How much rules and agents may do alone in an inbox.
public enum TrustLevel: OpenEnum {
    case suggest, actWithUndo, actSilently
    case unknown(String)

    public static let known: [TrustLevel] = [.suggest, .actWithUndo, .actSilently]

    public var rawValue: String {
        switch self {
        case .suggest: "suggest"
        case .actWithUndo: "act_with_undo"
        case .actSilently: "act_silently"
        case .unknown(let raw): raw
        }
    }
}

/// Where a person puts a thread on purpose. A thread is on at most one stack.
public enum Stack: OpenEnum, CodingKeyRepresentable {
    case replyLater, setAside
    case unknown(String)

    public static let known: [Stack] = [.replyLater, .setAside]

    public var rawValue: String {
        switch self {
        case .replyLater: "reply_later"
        case .setAside: "set_aside"
        case .unknown(let raw): raw
        }
    }
}

public enum InboxStatus: OpenEnum {
    case connecting, ok, needsAttention, paused
    case unknown(String)

    public static let known: [InboxStatus] = [.connecting, .ok, .needsAttention, .paused]

    public var rawValue: String {
        switch self {
        case .connecting: "connecting"
        case .ok: "ok"
        case .needsAttention: "needs_attention"
        case .paused: "paused"
        case .unknown(let raw): raw
        }
    }
}

/// Why an inbox is `needs_attention` (core's `InboxStatusReason`, docs/contract-sync.md, "When an inbox needs
/// attention"), so the apps offer the step that fits: signing in again, the host's setup, trying again. A server before
/// 0.1.2 sends none; a later one may send another (`unknown`).
public enum InboxStatusReason: OpenEnum {
    /// The mailbox refused the inbox's sign-in (Google's token, the IMAP login): sign in again, or new details.
    case needsSignIn
    /// The host's own setup stops it (the server's Google client refused or gone): the host fixes it.
    case hostSetup
    /// The provider kept failing for ten minutes: trying again may do.
    case providerError
    /// No sync of it has finished for a while though the server runs: trying again, else restarting the server.
    case notSyncing
    case unknown(String)

    public static let known: [InboxStatusReason] = [.needsSignIn, .hostSetup, .providerError, .notSyncing]

    public var rawValue: String {
        switch self {
        case .needsSignIn: "needs_sign_in"
        case .hostSetup: "host_setup"
        case .providerError: "provider_error"
        case .notSyncing: "not_syncing"
        case .unknown(let raw): raw
        }
    }
}

/// What a thread asks of the person.
public enum Need: OpenEnum {
    case reply, decide, pay, read
    case unknown(String)

    public static let known: [Need] = [.reply, .decide, .pay, .read]

    public var rawValue: String {
        switch self {
        case .reply: "reply"
        case .decide: "decide"
        case .pay: "pay"
        case .read: "read"
        case .unknown(let raw): raw
        }
    }
}

/// A kind of mail from a sender who isn't let in that may skip Screening (`ScreeningPass` in `core/src/screening.ts`),
/// in the owner's order: a one-time code, a sign-in link, an email confirmation, a security alert, a password reset or
/// account change, a receipt or order update, a booking, a payment alert.
public enum ScreeningPass: OpenEnum {
    case code, signIn, emailConfirmation, security, account, order, booking, payment
    case unknown(String)

    public static let known: [ScreeningPass] = [
        .code, .signIn, .emailConfirmation, .security, .account, .order, .booking, .payment,
    ]

    public var rawValue: String {
        switch self {
        case .code: "code"
        case .signIn: "sign_in"
        case .emailConfirmation: "email_confirmation"
        case .security: "security"
        case .account: "account"
        case .order: "order"
        case .booking: "booking"
        case .payment: "payment"
        case .unknown(let raw): raw
        }
    }
}

public enum DraftState: OpenEnum {
    case draft, sending, sent, failed
    case unknown(String)

    public static let known: [DraftState] = [.draft, .sending, .sent, .failed]

    public var rawValue: String {
        switch self {
        case .draft: "draft"
        case .sending: "sending"
        case .sent: "sent"
        case .failed: "failed"
        case .unknown(let raw): raw
        }
    }
}

public enum ActionState: OpenEnum {
    case proposed, applied, undone, rejected, failed
    case unknown(String)

    public static let known: [ActionState] = [.proposed, .applied, .undone, .rejected, .failed]

    public var rawValue: String {
        switch self {
        case .proposed: "proposed"
        case .applied: "applied"
        case .undone: "undone"
        case .rejected: "rejected"
        case .failed: "failed"
        case .unknown(let raw): raw
        }
    }
}

public enum RuleSource: OpenEnum {
    case person, correction, agent
    case unknown(String)

    public static let known: [RuleSource] = [.person, .correction, .agent]

    public var rawValue: String {
        switch self {
        case .person: "person"
        case .correction: "correction"
        case .agent: "agent"
        case .unknown(let raw): raw
        }
    }
}

public enum DeviceKind: OpenEnum {
    case person, agent
    case unknown(String)

    public static let known: [DeviceKind] = [.person, .agent]

    public var rawValue: String {
        switch self {
        case .person: "person"
        case .agent: "agent"
        case .unknown(let raw): raw
        }
    }
}

/// The `code` of every error the server returns. `docs/contract.md` and `ERROR_STATUS` in core say when.
public enum ErrorCode: OpenEnum {
    case unauthorized, forbidden, notFound, invalid, conflict, needsPerson, rateLimited, providerError, `internal`
    case unknown(String)

    public static let known: [ErrorCode] = [
        .unauthorized, .forbidden, .notFound, .invalid, .conflict, .needsPerson, .rateLimited, .providerError,
        .internal,
    ]

    public var rawValue: String {
        switch self {
        case .unauthorized: "unauthorized"
        case .forbidden: "forbidden"
        case .notFound: "not_found"
        case .invalid: "invalid"
        case .conflict: "conflict"
        case .needsPerson: "needs_person"
        case .rateLimited: "rate_limited"
        case .providerError: "provider_error"
        case .internal: "internal"
        case .unknown(let raw): raw
        }
    }

    /// The code for an HTTP status, for an error response without a readable body. `needs_person` shares
    /// 403 with `forbidden`, so a bare 403 reads as `forbidden`.
    public init(status: Int) {
        switch status {
        case 400: self = .invalid
        case 401: self = .unauthorized
        case 403: self = .forbidden
        case 404: self = .notFound
        case 409: self = .conflict
        case 429: self = .rateLimited
        case 502: self = .providerError
        case 500: self = .internal
        default: self = .unknown("http_\(status)")
        }
    }
}
