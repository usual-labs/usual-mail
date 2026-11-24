import CoreGraphics

/// The rail's sizes (`Rail` draws with them), its height, and how many profiles its switch shows at once.
///
/// The rail runs from the top margin (`MailLayout.top`) down to as far above the window's bottom edge, where settings
/// sits (owner's request of 2026-11-19). Above settings, with at least `spacing` between: search, the switch, To
/// reply, Pinned, Snoozed and the classic inbox. In the smallest window (820 × 560) that leaves room for 4 inboxes
/// besides the circle for every inbox and the plus; each 28 points more of rail holds one more (16 in the design's
/// 1512 × 982). With more inboxes than fit, the inboxes scroll inside the switch, kept to the height of those that fit,
/// between the circle and the plus, which stay in sight; so nothing ever reaches settings.
enum RailFit {
    /// The round buttons (search, To reply, Pinned, Snoozed, the classic inbox, settings), and the switch's width.
    static let button: CGFloat = 32
    /// How many round buttons the rail has.
    static let buttons = 6
    /// Between the rail's buttons and the switch, and the least room above settings.
    static let spacing: CGFloat = 10
    /// Each icon in the switch: the circle for every inbox, each inbox, the plus.
    static let row: CGFloat = 24
    static let rowSpacing: CGFloat = 4
    /// Inside the switch's pill, above its first icon and below its last.
    static let pillPadding: CGFloat = 8

    /// The rail open (`RailOpening`): every button and the switch this wide, each named beside its icon, which stays
    /// where it was. Room for "Add a Gmail account" and a count; a longer inbox name is cut short.
    static let openWidth: CGFloat = 184
    /// Where an open button's name starts: 6 past its icon, which sits in the middle of the button's first 32.
    static let labelStart: CGFloat = 30
    /// After an open button's name or count, to its end.
    static let labelEnd: CGFloat = 12

    /// Whether the open rail reaches over the card, in a window whose rail has `room` up to the gap before the card
    /// (`MailLayout.railRoom`): in windows narrower than 1092 points (1292 on the classic inbox). The open rail
    /// then lies over the card's left edge, above it, and nothing moves.
    static func reachesCard(room: CGFloat) -> Bool {
        openWidth > room + MailLayout.gap
    }

    /// `count` icons of the switch, one under another.
    static func rows(_ count: Int) -> CGFloat {
        count > 0 ? CGFloat(count) * row + CGFloat(count - 1) * rowSpacing : 0
    }

    /// The switch with `inboxes` profiles shown, the circle for every inbox and the plus.
    static func pill(inboxes: Int) -> CGFloat {
        2 * pillPadding + rows(inboxes + 2)
    }

    /// The whole rail at its shortest: its buttons and the switch, `spacing` between each, settings included.
    static func height(inboxes: Int) -> CGFloat {
        CGFloat(buttons) * (button + spacing) + pill(inboxes: inboxes)
    }

    /// The rail's column in a window `windowHeight` tall: from its top margin to as far above the bottom edge.
    static func column(windowHeight: CGFloat) -> CGFloat {
        let top = MailLayout(size: CGSize(width: 0, height: windowHeight)).top
        return max(0, windowHeight - 2 * top)
    }

    /// How many inboxes the switch shows at once, with the circle and the plus, before the rail would reach settings.
    static func inboxesThatFit(windowHeight: CGFloat) -> Int {
        let room = column(windowHeight: windowHeight) - height(inboxes: 0)
        return max(0, Int((room / (row + rowSpacing)).rounded(.down)))
    }

    /// With more `inboxes` than fit, the height the inboxes scroll in: as tall as the inboxes that fit (one at least),
    /// so the switch is as tall as it is with them. Nil when every inbox shows.
    static func scrollHeight(inboxes: Int, windowHeight: CGFloat) -> CGFloat? {
        let fit = inboxesThatFit(windowHeight: windowHeight)
        return inboxes > fit ? rows(max(1, fit)) : nil
    }
}
