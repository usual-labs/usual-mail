import CoreGraphics

/// Settings' tabs, in this order, as small glass capsules at the right of the top row (2026-11-20, the owner's "add tabs
/// also for the settings page, shown on the right side of the top of the container"). The chosen one carries its icon
/// and name; the others their names too while the card has the design's full width, and only their icons in a
/// narrower window (the smallest, 820 × 560, included), the name then a tooltip. The last one chosen is remembered
/// while the app runs (`Navigation.settingsTab`), not across launches.
enum SettingsTab: String, CaseIterable, Hashable, Sendable {
    case accounts
    case ai
    case appearance
    case blocked
    case about

    var title: String {
        switch self {
        case .accounts: "Accounts"
        case .ai: "AI"
        case .appearance: "Appearance"
        case .blocked: "Blocked"
        case .about: "About"
        }
    }

    var icon: Icon {
        switch self {
        case .accounts: .accounts
        case .ai: .ai
        case .appearance: .appearance
        case .blocked: .blocked
        case .about: .about
        }
    }

    /// Whether the tabs not chosen show their names beside their icons: when the card is the design's full 700 wide
    /// (windows from about 840 wide); below that, icons only.
    static func showsNames(cardWidth: CGFloat) -> Bool {
        cardWidth >= MailLayout.designCenter
    }
}
