import UsualMailKit

/// The tabs across the top: Home, the default, then Feed, Receipts and Notifications, which list their categories.
/// The person's own lists (To reply, Pinned, Snoozed) are the rail's, not tabs (owner's request of 2026-11-19).
public enum Tab: String, CaseIterable, Hashable, Sendable {
    case home
    case reads
    case receipts
    case notifications

    var title: String {
        switch self {
        case .home: "Home"
        // The design's name (Figma frame "MacBook Pro 14" - 2"). The raw value and launch option stay `reads`.
        case .reads: "Feed"
        case .receipts: "Receipts"
        case .notifications: "Notifications"
        }
    }

    /// The categories a tab lists, for the tabs that list categories.
    var categories: [UsualMailKit.Category] {
        switch self {
        case .reads: [.newsletter]
        case .receipts: [.invoice, .receipt]
        case .notifications: [.notification]
        case .home: []
        }
    }

    var icon: Icon {
        switch self {
        case .home: .home
        case .reads: .reads
        case .receipts: .receipts
        case .notifications: .notifications
        }
    }
}

/// What the card shows: a tab, one of the places on the rail (search, the person's own lists, the classic inbox,
/// settings), or the screening queue. Choosing one is the only choice: a rail place shows no tab chosen, and a tab
/// lights no rail button. Each belongs to a stack (`destination`); the tabs show only in the mail stack's.
public enum Place: Hashable, Sendable {
    case tab(Tab)
    case toReply
    case pinned
    case snoozed
    case screening
    case search
    case inbox
    case settings

    /// The tab whose page this is, if a tab's: the one the top bar shows chosen.
    var tab: Tab? {
        if case .tab(let tab) = self { tab } else { nil }
    }

    var title: String {
        switch self {
        case .tab(let tab): tab.title
        case .toReply: "To reply"
        case .pinned: "Pinned"
        case .snoozed: "Snoozed"
        case .screening: "Screening"
        case .search: "Search"
        case .inbox: "Inbox"
        case .settings: "Settings"
        }
    }

    var icon: Icon {
        switch self {
        case .tab(let tab): tab.icon
        case .toReply: .toReply
        case .pinned: .pinned
        case .snoozed: .snoozed
        case .screening: .screening
        case .search: .search
        case .inbox: .inbox
        case .settings: .settings
        }
    }
}
