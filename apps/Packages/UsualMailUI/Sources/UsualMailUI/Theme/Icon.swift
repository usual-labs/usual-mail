import SwiftUI
import UsualMailDesign
import UsualMailKit

/// The design's icons (Hugeicons' free set, Stroke Rounded, 16 points, from the Figma file), in this package's asset
/// catalog. House, shop, globe, the plus, the notifications square, the attachment mark, the picked circle and the
/// seen tick's two rings, which the Figma file doesn't have, were drawn from the same set at the same size and stroke. The eight later inbox icons are the design
/// package's (`designed`).
enum Icon: String, CaseIterable, Sendable {
    case search = "search-01"
    case allInboxes = "circle-small"
    /// The circle for every inbox while it is picked: a dot in it (owner's words of 2026-11-20), the free set's
    /// `RadioButtonIcon`.
    case allInboxesChosen = "radio-button"
    case person = "male-02"
    case building = "building"
    case briefcase = "briefcase-07"
    case house = "house-03"
    case shop = "store-01"
    case globe = "globe-02"
    // The inbox icons the owner asked for on 2026-11-20: the design package's own drawings (`UsualIcon`, Hugeicons'
    // free set), not copies in this package's catalog.
    case plane, wallet, family, rocket, school, heart, star, leaf
    /// The switch's plus, which adds a Gmail account; drawn from the same free set (`plus-sign`).
    case add = "plus-sign"
    case inbox = "archive-04"
    case settings = "settings-01"
    case home = "home-02"
    case reads = "carousel-vertical"
    case receipts = "invoice-01"
    /// A square with a badge dot, not a bell, so it isn't taken for Snoozed's.
    case notifications = "notification-square"
    case toReply = "message-circle-reply"
    case pinned = "pin"
    case snoozed = "notification-snooze-01"
    case screening = "entrance-stairs"
    // The mail page (Figma frame "MacBook Pro 14" - 9").
    case back = "arrow-left-02"
    case archive = "archive"
    case more = "ellipsis"
    // Its menu, drawn from the same free set.
    case forward = "arrow-turn-forward"
    case label = "tag-01"
    case remove = "delete-02"
    // Screening (Figma frame "MacBook Pro 14" - 8"), grey as drawn.
    case expand = "arrow-down-01"
    case letIn = "checkmark-square-02"
    case block = "multiplication-sign-square"
    // The classic inbox's attachment mark, drawn from the same free set.
    case attachment = "attachment-01"
    // A Notifications row's seen tick (owner's words of 2026-11-20), drawn from the same free set: an empty ring until
    // the row is seen (`CircleIcon`), then the ring ticked (`CheckmarkCircle02Icon`).
    case unseen = "circle"
    case seen = "checkmark-circle-02"
    // Settings' tabs (2026-11-20), drawn from the same free set: Accounts (`UserAccountIcon`), AI (`AiMagicIcon`),
    // Appearance (`PaintBoardIcon`), Blocked (`UserBlock01Icon`) and About (`InformationCircleIcon`).
    case accounts = "user-account"
    case ai = "ai-magic"
    case appearance = "paint-board"
    case blocked = "user-block-01"
    case about = "information-circle"
    // Search's Ask, a sentence turned into filters by the server's AI (2026-11-20), drawn from the same free set
    // (`SparklesIcon`).
    case ask = "sparkles"

    /// A profile's icon: the one its inbox chose.
    init(_ icon: InboxIcon) {
        switch icon {
        case .person: self = .person
        case .building: self = .building
        case .briefcase: self = .briefcase
        case .house: self = .house
        case .shop: self = .shop
        case .globe: self = .globe
        case .plane: self = .plane
        case .wallet: self = .wallet
        case .family: self = .family
        case .rocket: self = .rocket
        case .school: self = .school
        case .heart: self = .heart
        case .star: self = .star
        case .leaf: self = .leaf
        case .unknown: self = .allInboxes
        }
    }

    /// This package's resources: the icons and the wallpaper.
    static let bundle = Bundle.module

    /// The design package's drawing, for an icon drawn from it rather than from this package's catalog.
    var designed: UsualIcon? {
        switch self {
        case .plane: .plane
        case .wallet: .wallet
        case .family: .family
        case .rocket: .rocket
        case .school: .school
        case .heart: .heart
        case .star: .star
        case .leaf: .leaf
        default: nil
        }
    }

    /// The asset catalog the icon is in, under its `rawValue`.
    var catalog: Bundle { designed == nil ? Icon.bundle : .usualMailDesign }

    /// The icon as the design draws it (its own #141B34 stroke, and the person's grey fill), at 16 points; with
    /// `tint`, a one-colour icon in that colour instead. The design package's drawings are black templates, so they
    /// always take a colour: the icons' #141B34 unless tinted.
    @ViewBuilder
    func view(size: CGFloat = 16, tint: Color? = nil) -> some View {
        if let colour = tint ?? (designed == nil ? nil : Theme.icon) {
            image
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(colour)
                .accessibilityHidden(true)
        } else {
            image
                .renderingMode(.original)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }

    /// The drawing itself, for a system menu's row (the iPhone's switcher), which sizes and tints it.
    var image: Image { designed?.image ?? Image(rawValue, bundle: Icon.bundle) }

    /// Drawn grey for the screening rows; on a glass button they take the icon colour.
    var isGrey: Bool { [.expand, .letIn, .block].contains(self) }
}
