import Foundation

// The server's owner and their password (docs/contract.md, "The owner's password"; `core/src/owner.ts`).

/// How an unclaimed server is claimed: by whoever comes first, or, when its host named the owner's email, by signing in
/// with Google as that address first (in a browser: the app can't).
public enum OwnerClaim: OpenEnum {
    case password
    case google
    case unknown(String)

    public static let known: [OwnerClaim] = [.password, .google]

    public var rawValue: String {
        switch self {
        case .password: "password"
        case .google: "google"
        case .unknown(let value): value
        }
    }
}

/// What `GET /v1/info` says of the owner. A server from before the owner's password sends none: `OwnerInfo.none`.
public struct OwnerInfo: Codable, Hashable, Sendable {
    /// Whether the owner has set a password, so this device may sign in with it.
    public var password: Bool
    /// Whether the server can be claimed now: no password and no person's device yet.
    public var claimable: Bool
    /// How it is claimed, while it is claimable.
    public var claim: OwnerClaim?

    public init(password: Bool, claimable: Bool, claim: OwnerClaim? = nil) {
        self.password = password
        self.claimable = claimable
        self.claim = claim
    }

    public static let none = OwnerInfo(password: false, claimable: false)
}

/// The shortest password the server takes, in characters.
public let ownerPasswordMinimum = 12

/// `POST /v1/owner/sign-in`: the owner's password pairs this device.
public struct OwnerSignInInput: Codable, Hashable, Sendable {
    public var password: String
    /// What the person will see in the device list.
    public var name: String

    public init(password: String, name: String) {
        self.password = password
        self.name = name
    }
}

/// `POST /v1/owner/claim`: makes this device's person the owner of an unclaimed server, and pairs it.
public struct OwnerClaimInput: Codable, Hashable, Sendable {
    public var password: String
    public var name: String
    /// Optional; shown only to the owner.
    public var email: String?

    public init(password: String, name: String, email: String? = nil) {
        self.password = password
        self.name = name
        self.email = email
    }
}

/// `PUT /v1/owner/password`: a first password or a new one, from a person's device. The old one isn't asked for.
public struct OwnerPasswordInput: Codable, Hashable, Sendable {
    public var password: String

    public init(password: String) {
        self.password = password
    }
}

/// `GET /v1/owner`: the owner as the server keeps them, never the password.
public struct Owner: Codable, Hashable, Sendable {
    public var email: String?
    public var password: Bool
    /// When the password was last set; nil without one.
    public var passwordSetAt: Date?

    public init(email: String? = nil, password: Bool, passwordSetAt: Date? = nil) {
        self.email = email
        self.password = password
        self.passwordSetAt = passwordSetAt
    }
}
