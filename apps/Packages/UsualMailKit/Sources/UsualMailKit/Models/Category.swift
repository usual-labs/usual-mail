import Foundation

/// What kind of mail a thread is (`Category` in core). Every thread has exactly one.
///
/// The contract has a real category spelled `unknown`: nobody has decided yet, or the AI isn't working. Here it is
/// `.uncategorized`, so it can't be mistaken for `.unknown(_)`, which every open enum in this package keeps for a value
/// a newer server sends that this app doesn't know. Such a value is kept whole, so it encodes back unchanged, but the
/// app treats it as `.uncategorized` wherever it matters (`listed`): it shows in Home and in the uncategorized list, so
/// nothing is hidden.
public enum Category: OpenEnum, CodingKeyRepresentable {
    /// Mail between people that may need the person.
    case conversation
    case newsletter, invoice, receipt, notification
    /// A one-time code. Never summarized and never screened.
    case otp
    /// The contract's `unknown`: nobody has decided yet, or the AI isn't working. Home shows it.
    case uncategorized
    /// A category a newer server sends that this app doesn't know. Treated as `.uncategorized` (`listed`).
    case unknown(String)

    /// The contract's seven, in its order (`CATEGORIES` in core).
    public static let known: [Category] = [
        .conversation, .newsletter, .invoice, .receipt, .notification, .otp, .uncategorized,
    ]

    /// The five filed under their own label or folder at the provider (`FILED_CATEGORIES` in core).
    public static let filed: [Category] = [.newsletter, .invoice, .receipt, .notification, .otp]

    /// The six a person, a rule or an agent can decide (`DecidedCategory` in core): nobody decides `unknown`.
    public static let decidable: [Category] = [
        .conversation, .newsletter, .invoice, .receipt, .notification, .otp,
    ]

    public var rawValue: String {
        switch self {
        case .conversation: "conversation"
        case .newsletter: "newsletter"
        case .invoice: "invoice"
        case .receipt: "receipt"
        case .notification: "notification"
        case .otp: "otp"
        case .uncategorized: "unknown"
        case .unknown(let raw): raw
        }
    }

    /// The category the lists and counts use: itself, or `.uncategorized` for one this app doesn't know.
    public var listed: Category {
        isKnown ? self : .uncategorized
    }

    /// True for the contract's `unknown` and for a category this app doesn't know.
    public var isUncategorized: Bool { listed == .uncategorized }

    /// Home holds `conversation` and `unknown` threads (docs/contract.md, "Lists"; the owner's decision of 2026-11-19:
    /// with a Notifications tab, Home no longer shows notifications).
    public var isShownInHome: Bool {
        listed == .conversation || listed == .uncategorized
    }
}

/// Who decided a thread's category, or proposed one (`CategorySource` in core).
public enum CategorySource: OpenEnum {
    /// The server's own AI.
    case ai
    case rule, agent, person
    /// The mailbox: a label or folder read back, or a change made at the provider.
    case mailbox
    case unknown(String)

    public static let known: [CategorySource] = [.ai, .rule, .agent, .person, .mailbox]

    public var rawValue: String {
        switch self {
        case .ai: "ai"
        case .rule: "rule"
        case .agent: "agent"
        case .person: "person"
        case .mailbox: "mailbox"
        case .unknown(let raw): raw
        }
    }

    /// Who an actor counts as when it decides a category: nil for `system` and kinds this app doesn't know.
    public init?(_ actor: Doer) {
        switch actor {
        case .person: self = .person
        case .rule: self = .rule
        case .agent: self = .agent
        case .ai: self = .ai
        case .system, .unknown: return nil
        }
    }
}

/// An inbox's icon in the profile switch (`InboxIcon` in core): the first six, then the eight the owner asked for on
/// 2026-11-20.
public enum InboxIcon: OpenEnum {
    case person, building, briefcase, house, shop, globe
    case plane, wallet, family, rocket, school, heart, star, leaf
    case unknown(String)

    /// Core's `INBOX_ICONS`, in the order pickers show them.
    public static let known: [InboxIcon] = [
        .person, .building, .briefcase, .house, .shop, .globe,
        .plane, .wallet, .family, .rocket, .school, .heart, .star, .leaf,
    ]

    public var rawValue: String {
        switch self {
        case .person: "person"
        case .building: "building"
        case .briefcase: "briefcase"
        case .house: "house"
        case .shop: "shop"
        case .globe: "globe"
        case .plane: "plane"
        case .wallet: "wallet"
        case .family: "family"
        case .rocket: "rocket"
        case .school: "school"
        case .heart: "heart"
        case .star: "star"
        case .leaf: "leaf"
        case .unknown(let raw): raw
        }
    }
}

extension CodingKeyRepresentable where Self: OpenEnum {
    /// Lets a dictionary keyed by an open enum read and write a JSON object, as `Record<Category, number>` is.
    public var codingKey: any CodingKey { OpenEnumKey(stringValue: rawValue) }

    public init?<T: CodingKey>(codingKey: T) {
        self = Self.parse(codingKey.stringValue)
    }
}

/// A JSON object's key spelled as an open enum's value.
struct OpenEnumKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }

    init(stringValue: String) {
        self.stringValue = stringValue
    }

    init?(intValue: Int) {
        return nil
    }
}
