#if os(macOS)
    import SwiftUI
    import UsualMailKit

    /// An open rail button's name beside its icon, and a list's count at its right in the time colour: laid out where it
    /// sits when open, so a narrow button's own shape cuts it off and uncovers it as the button widens. The name takes the
    /// wallpaper's tone under it as the icons do (`RailTone`), dark while the button is frosted over the card or lit as the
    /// current stack's (`RailLook.lit`). Hidden from accessibility: the button already carries the name.
    struct RailLabel: View {
        let title: String
        var count = 0
        /// Its button is lit, white under it whatever the wallpaper.
        var lit = false
        @Environment(\.railWindow) private var window
        @Environment(\.railLook) private var look
        @State private var frame: CGRect = .zero

        var body: some View {
            let tint = look.frosted || lit ? nil : RailTone.tint(for: frame, in: window)
            HStack(spacing: 6) {
                Text(verbatim: title)
                    .font(Theme.sans(12))
                    .foregroundStyle(tint ?? Theme.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .onGeometryChange(for: CGRect.self) {
                        $0.frame(in: .global)
                    } action: {
                        frame = $0
                    }
                    .animation(Motion.reveal, value: tint == nil)
                Spacer(minLength: 0)
                if let words = RailCount.words(count) {
                    Text(verbatim: words)
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.time)
                        .fixedSize()
                        .contentTransition(.numericText())
                }
            }
            .animation(Motion.reveal, value: count)
            .padding(.leading, RailFit.labelStart)
            .padding(.trailing, RailFit.labelEnd)
            .frame(width: RailFit.openWidth, alignment: .leading)
            .reveal(look.isOpen)
            .accessibilityHidden(true)
        }
    }

    /// A list's count on its narrow button: a tiny white capsule (14 high) over the button's top right corner, 3 past its
    /// edges, the number in 9 points in the secondary grey, with a faint shadow so it reads over the sky and the hills
    /// alike. Nothing for none; it fades as the rail opens and the count moves beside the name (`RailLabel`). Drawn on the
    /// icon's square, which stays put while the button widens, by the rail over its glass (`railBadges`).
    struct RailBadge: View {
        let count: Int
        @Environment(\.railLook) private var look

        var body: some View {
            let words = RailCount.words(count)
            Color.clear
                .frame(width: RailFit.button, height: RailFit.button)
                .overlay(alignment: .topTrailing) {
                    if let words {
                        Text(verbatim: words)
                            .font(Theme.sans(9, weight: .semibold))
                            .foregroundStyle(Theme.secondary)
                            .fixedSize()
                            .contentTransition(.numericText())
                            .padding(.horizontal, 3.5)
                            .frame(minWidth: 14, minHeight: 14)
                            .background(Color.white.opacity(0.9), in: Capsule())
                            .shadow(color: .black.opacity(0.12), radius: 1.5, y: 0.5)
                            .offset(x: 3, y: -3)
                            .transition(.blurReveal)
                    }
                }
                .reveal(!look.isOpen)
                .animation(Motion.reveal, value: words)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    /// Where a list's badge (`RailBadge`) goes: its button's bounds, its count, and whether the button has grown under
    /// dragged mail. Reported by each of To reply, Pinned and Snoozed (`railBadge`), drawn by the rail (`railBadges`).
    struct RailBadgeSpot: Identifiable {
        let place: Place
        let count: Int
        let grows: Bool
        let bounds: Anchor<CGRect>

        var id: Place { place }

        struct Key: PreferenceKey {
            static var defaultValue: [RailBadgeSpot] { [] }

            static func reduce(value: inout [RailBadgeSpot], nextValue: () -> [RailBadgeSpot]) {
                value += nextValue()
            }
        }
    }

    extension View {
        /// This rail button's count, for the rail to draw over it (`railBadges`); nothing but for To reply, Pinned and
        /// Snoozed, the lists that have one (`RailCount`). `grows`: the button is 1.1 times its size, around its icon.
        func railBadge(_ place: Place, count: Int, grows: Bool) -> some View {
            anchorPreference(key: RailBadgeSpot.Key.self, value: .bounds) { bounds in
                guard Rail.lists.contains(place) else { return [] }
                return [RailBadgeSpot(place: place, count: count, grows: grows, bounds: bounds)]
            }
        }

        /// Draws the badges of the buttons inside (`railBadge`) over this view, each on its button's icon square, grown as
        /// the button grows. For the rail's glass container: a `GlassEffectContainer` draws its glass above everything
        /// else inside it, so a badge drawn by its button sat under the button's glass; drawn here, over the container, it
        /// is above all the rail's glass. Takes no clicks, hover or drops, and isn't read out: each button carries its
        /// count.
        func railBadges() -> some View {
            overlayPreferenceValue(RailBadgeSpot.Key.self) { spots in
                GeometryReader { proxy in
                    ForEach(spots) { spot in
                        let frame = proxy[spot.bounds]
                        RailBadge(count: spot.count)
                            .scaleEffect(spot.grows ? 1.1 : 1)
                            .animation(Motion.move, value: spot.grows)
                            .position(x: frame.minX + RailFit.button / 2, y: frame.minY + RailFit.button / 2)
                    }
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }
#endif
