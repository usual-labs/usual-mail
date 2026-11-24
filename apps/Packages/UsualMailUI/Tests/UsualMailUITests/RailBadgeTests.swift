import AppKit
import SwiftUI
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The counts' badges on To reply, Pinned and Snoozed draw over their buttons' glass, whole (owner's report of
/// 2026-11-20: "the number is beneath button"; a `GlassEffectContainer` draws its glass over everything else inside
/// it, so the rail draws them over the container, `railBadges`). Rendered offscreen (`Picture`), which draws glass as
/// its tint, without the lens: on the real rail, by the badge's number over its button; on stand-in buttons of red
/// glass, by the badge's white, beside the badges drawn as before, which this renderer shows covered.
@MainActor
struct RailBadgeTests {
    /// Under everything: blue, which neither the badge's white nor the red glass is.
    private static let ground = Color(red: 0, green: 0, blue: 1)
    private static let margin: CGFloat = 20

    @Test func aBadgeDrawsOverItsButtonsGlass() throws {
        // One, two digits and "99+"; Pinned grown under dragged mail.
        let counts = [4, 42, 120]
        let fixed = try Picture(of: stack(counts: counts, grows: .pinned))
        let before = try Picture(of: stack(counts: counts, grows: .pinned, badgesInside: true))
        for index in counts.indices {
            let glass = Self.glass(at: index, grown: Rail.lists[index] == .pinned)
            // Where the badge lies over the button's edge: its white, not the glass.
            #expect(fixed.count(in: glass, where: \.isBadge) > 20, "\(Rail.lists[index])")
            // Each drawn by its button, as before: the glass covered it there (which this renderer shows).
            #expect(before.count(in: glass, where: \.isBadge) == 0, "\(Rail.lists[index])")
        }
    }

    @Test func badgesFadeAsTheRailOpens() throws {
        let open = try Picture(of: stack(counts: [4, 42, 120], look: RailLook(isOpen: true)))
        #expect(open.count(in: open.bounds, where: \.isBadge) == 0)
    }

    @Test func theRailsBadgesDrawOverItsGlass() async throws {
        let store = try await MailStore.sample()
        // Two digits and "99+", whose numbers reach over the button; a single digit lies past the glass's edge in this
        // renderer (the stand-ins above cover it).
        let counts = Counts(
            all: ThreadCounts(home: 0, unread: 0, stacks: [.replyLater: 42, .setAside: 120], waiting: 64, screened: 0),
            inboxes: [], version: 1)
        // Mail dragged over Pinned: all three tinted as taking it, Pinned grown.
        let dragged = MailDragState(dropBeat: .seconds(60), watchEvery: .seconds(60), mouse: FakeMouse().read)
        dragged.over(.pinned)
        defer { dragged.ended() }
        // None chosen, each chosen (its glass tinted), and mail dragged.
        let states: [(Place, MailDragState?)] = [
            (.tab(.home), nil), (.toReply, nil), (.pinned, nil), (.snoozed, nil), (.tab(.home), dragged),
        ]
        for (place, drag) in states {
            let rail = Rail(
                place: place, mark: ProfileMark(profile: nil, active: true), inboxes: store.lists.inboxes,
                counts: counts, room: 300, window: CGSize(width: 1512, height: 982), chooseProfile: { _ in },
                press: { _ in }
            )
            .environment(store)
            .environment(drag)
            .padding(Self.margin)
            .background(Self.ground)
            let picture = try Picture(of: rail)
            // To reply, Pinned and Snoozed follow search and the switch, `spacing` apart.
            let lists =
                Self.margin + RailFit.button + 2 * RailFit.spacing
                + RailFit.pill(inboxes: store.lists.inboxes.count)
            for (index, list) in Rail.lists.enumerated() {
                let top = lists + CGFloat(index) * (RailFit.button + RailFit.spacing)
                // The badge's number where it lies over the button's glass, in its grey: drawn by its button, the
                // glass hid it there.
                let glass = Round(
                    center: CGPoint(x: Self.margin + RailFit.button / 2, y: top + RailFit.button / 2),
                    radius: RailFit.button / 2 - 1)
                let badge = CGRect(x: Self.margin + 13, y: top - 3, width: 22, height: 12)
                let number = picture.count(in: glass, within: badge, where: \.isInk)
                #expect(number > 20, "\(list), \(place) chosen\(drag == nil ? "" : ", mail dragged")")
            }
        }
    }

    /// To reply, Pinned and Snoozed as the rail stacks them, each a stand-in button of red glass in the rail's glass
    /// container, their badges drawn by the rail's layer (`railBadges`), or, as before, each by its own button.
    private func stack(
        counts: [Int], grows: Place? = nil, badgesInside: Bool = false, look: RailLook = RailLook()
    ) -> some View {
        GlassEffectContainer(spacing: RailFit.spacing) {
            VStack(spacing: RailFit.spacing) {
                ForEach(Array(zip(Rail.lists, counts)), id: \.0) { place, count in
                    Color.clear
                        .frame(width: RailFit.button, height: RailFit.button)
                        .glassEffect(.regular.tint(.red), in: Capsule())
                        .overlay(alignment: .topLeading) {
                            if badgesInside { RailBadge(count: count) }
                        }
                        .scaleEffect(grows == place ? 1.1 : 1)
                        .railBadge(place, count: badgesInside ? 0 : count, grows: grows == place)
                }
            }
        }
        .railBadges()
        .environment(\.railLook, look)
        .padding(Self.margin)
        .background(Self.ground)
    }

    /// The `index`th stand-in's glass, a point inside its edge, grown 1.1 times around its middle or not.
    private static func glass(at index: Int, grown: Bool) -> Round {
        let radius = (RailFit.button / 2 - 1) * (grown ? 1.1 : 1)
        let middle = margin + CGFloat(index) * (RailFit.button + RailFit.spacing) + RailFit.button / 2
        return Round(center: CGPoint(x: margin + RailFit.button / 2, y: middle), radius: radius)
    }
}

/// A round area of a picture, in points.
private struct Round {
    let center: CGPoint
    let radius: CGFloat

    var bounds: CGRect {
        CGRect(x: center.x - radius, y: center.y - radius, width: 2 * radius, height: 2 * radius)
    }

    func contains(_ point: CGPoint) -> Bool {
        hypot(point.x - center.x, point.y - center.y) < radius
    }
}

extension Pixel {
    /// The badge's white (white at 90% over anything), never the red glass (green under 100) nor the blue ground.
    fileprivate var isBadge: Bool { green > 150 }
    /// The badge's number, grey on its white; never the rail's glass, light over whatever is under it.
    fileprivate var isInk: Bool { red < 170 && green < 170 && blue < 170 }
}

extension Picture {
    /// How many pixels inside `circle`, and `within` a part of it, match.
    fileprivate func count(in circle: Round, within part: CGRect? = nil, where matches: (Pixel) -> Bool) -> Int {
        count(in: part.map(circle.bounds.intersection) ?? circle.bounds, inside: circle.contains, where: matches)
    }
}
