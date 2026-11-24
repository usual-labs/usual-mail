import CoreGraphics

/// The design's columns (300, 700, 300 with 10 between, 100 from the top in a 1512 × 982 window), narrowed for a
/// smaller window: the sides give way first, down to room for the rail. On the classic inbox (`wide`) the card is up to
/// 200 wider (900), taken from the two sides alike and never below the rail's room, so the row is as wide as before
/// and the rail stays where it was; the smallest window has nothing to give.
struct MailLayout: Equatable {
    static let gap: CGFloat = 10
    static let designSide: CGFloat = 300
    static let designCenter: CGFloat = 700
    static let minSide: CGFloat = 56
    /// How much wider the classic inbox's card is, at most.
    static let wideGain: CGFloat = 200
    /// The rail's least distance from the window's edge.
    static let railMargin: CGFloat = 12

    let side: CGFloat
    let center: CGFloat
    let top: CGFloat
    /// Room between the side column's edge and the rail, so the rail is never closer than 12 to the window's edge
    /// (in the design's window the row's own margin, 96, is room enough).
    let railInset: CGFloat

    init(size: CGSize, wide: Bool = false) {
        let room = size.width - 2 * Self.gap
        let side = min(Self.designSide, max(Self.minSide, (room - Self.designCenter) / 2))
        let center = max(0, min(Self.designCenter, room - 2 * side))
        let gain = wide ? min(Self.wideGain, max(0, 2 * (side - Self.minSide))) : 0
        self.side = side - gain / 2
        self.center = center + gain
        // Clear of the window's buttons in a short window, the design's 100 in a tall one.
        top = min(100, max(52, size.height * 0.1))
        let margin = max(0, (size.width - 2 * side - 2 * Self.gap - center) / 2)
        railInset = max(0, Self.railMargin - margin)
    }

    /// The rail's room to open into (`RailFit.reachesCard`): its side column from the rail to the gap before the card.
    var railRoom: CGFloat { side - railInset }
}
