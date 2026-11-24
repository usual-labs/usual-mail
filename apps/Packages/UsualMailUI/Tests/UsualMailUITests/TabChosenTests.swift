import Foundation
import SwiftUI
import Testing

@testable import UsualMailUI

/// The chosen tab in the top row reads as chosen over the wallpaper, light or dark (the coordinator's brief of
/// 2026-11-20, from the owner's captures at 1512 × 982: Settings' five tabs all show their names there, and in a
/// capsule's padding chosen and not differed by about 3 levels over the sky, Accounts 209 221 226 against 212 223 227).
/// It is lit as the rail's current button is (`RailLook.lit`): white under its clear glass, its icon and name in the
/// design's dark ink. Settings' tabs and the mail stack's (Home, Feed, Receipts, Notifications) alike, on the real
/// `TopBar` at the card's width in the design's window, drawn offscreen (`Picture`: glass flat, without the lens) over
/// the flat sky and hill colours of `RailChosenTests`. When the chosen tab's glass was tinted instead, it differed from
/// the others by 7 to 9 levels over the sky here (47 to 49 over the hills): its tint lightened every glass in the row.
/// Lit, 31 over the sky and 112 over the hills, its name 20 and 16 to 1 against its fill.
@MainActor
struct TabChosenTests {
    /// How much lighter, in levels of luminance (0 to 255), the chosen tab is in its padding than every other tab.
    static let margin = 25.0
    /// The least contrast of the chosen tab's name against its own fill.
    static let contrast = 4.5
    /// The least contrast of the chosen tab's icon against its own fill, as the rail's.
    static let iconContrast = 3.0
    static let grounds = [("sky", RailChosenTests.sky), ("hills", RailChosenTests.hills)]
    /// Room around the bar, so the ground shows on every side of it.
    static let inset: CGFloat = 20

    @Test func theChosenSettingsTabStandsOutOverTheSkyAndTheHills() throws {
        Theme.registerFonts()
        for (name, ground) in Self.grounds {
            for (index, tab) in SettingsTab.allCases.enumerated() {
                let picture = try Picture(of: bar(.settings, settingsTab: tab, ground: ground))
                let capsules = Self.capsules(in: picture)
                try #require(capsules.count == SettingsTab.allCases.count, "\(tab) over the \(name): \(capsules)")
                check(picture, capsules: capsules, chosen: index, named: true, "\(tab) over the \(name)")
            }
        }
    }

    @Test func theChosenMailTabStandsOutOverTheSkyAndTheHills() throws {
        Theme.registerFonts()
        for (name, ground) in Self.grounds {
            for (index, tab) in Tab.allCases.enumerated() {
                let picture = try Picture(of: bar(.tab(tab), ground: ground))
                // The four tabs, then the screening capsule at the right.
                let capsules = Self.capsules(in: picture)
                try #require(capsules.count == Tab.allCases.count + 1, "\(tab) over the \(name): \(capsules)")
                check(
                    picture, capsules: Array(capsules.prefix(Tab.allCases.count)), chosen: index, named: false,
                    "\(tab) over the \(name)")
            }
        }
    }

    /// The chosen capsule is `margin` lighter in its padding than each other one, and its icon and name stand out from
    /// its fill. `named`: the others show their names too (Settings' at this width), so they are as wide.
    private func check(_ picture: Picture, capsules: [ClosedRange<CGFloat>], chosen: Int, named: Bool, _ what: String) {
        let lit = capsules[chosen]
        let fill = picture.luma(inPaddingOf: lit)
        for (index, other) in capsules.enumerated() where index != chosen {
            let plain = picture.luma(inPaddingOf: other)
            #expect(fill - plain >= Self.margin, "\(what): capsule \(index) \(plain), the chosen \(fill)")
            if named { #expect(other.upperBound - other.lowerBound > 50, "\(what): capsule \(index) unnamed") }
        }
        let name = picture.contrast(in: Self.name(of: lit), against: lit)
        #expect(name >= Self.contrast, "\(what): its name \(name) to 1")
        let icon = picture.contrast(in: Self.icon(of: lit), against: lit)
        #expect(icon >= Self.iconContrast, "\(what): its icon \(icon) to 1")
    }

    /// The real top row at the card's width in the design's window, `place` showing, over `ground`.
    private func bar(_ place: Place, settingsTab: SettingsTab = .accounts, ground: Color) -> some View {
        TopBar(
            place: .constant(place), screeningCount: 0, mail: nil, settingsTab: .constant(settingsTab),
            back: {}, act: { _ in }
        )
        .frame(width: RailChosenTests.layout.center)
        .padding(Self.inset)
        .background(ground)
    }

    /// The middle of the row, where every capsule is full height.
    static let middle = inset + 16

    /// The capsules along the row's middle, left to right, by their left and right edges: the stretches of pixels that
    /// aren't the ground, which shows in the 10-point gaps between them. A glyph's soft edge can match the ground for a
    /// pixel or two, so only 4 points of ground part two capsules.
    static func capsules(in picture: Picture) -> [ClosedRange<CGFloat>] {
        let line = picture.pixels(in: CGRect(x: 0, y: middle, width: picture.bounds.width, height: 1 / Picture.scale))
        guard let ground = line.first else { return [] }
        let parting = Int(4 * Picture.scale)
        var runs: [ClosedRange<CGFloat>] = []
        var start: Int?
        var end = 0
        var gap = 0
        for (x, pixel) in (line + Array(repeating: ground, count: parting)).enumerated() {
            let isGround =
                abs(pixel.red - ground.red) + abs(pixel.green - ground.green) + abs(pixel.blue - ground.blue) <= 6
            if !isGround {
                if start == nil { start = x }
                end = x + 1
                gap = 0
                continue
            }
            gap += 1
            guard let first = start, gap >= parting else { continue }
            start = nil
            // As wide as a capsule (32 at least), not a stray edge.
            if end - first >= 40 { runs.append(CGFloat(first) / Picture.scale...CGFloat(end) / Picture.scale) }
        }
        return runs
    }

    /// A capsule's padding, left and right of what it holds (14 points each side): clear of its round ends.
    static func padding(of capsule: ClosedRange<CGFloat>) -> [CGRect] {
        [
            CGRect(x: capsule.lowerBound + 5, y: middle - 4, width: 5, height: 8),
            CGRect(x: capsule.upperBound - 10, y: middle - 4, width: 5, height: 8),
        ]
    }

    /// A capsule's icon, 16 points after its padding.
    static func icon(of capsule: ClosedRange<CGFloat>) -> CGRect {
        CGRect(x: capsule.lowerBound + 14, y: middle - 8, width: 16, height: 16)
    }

    /// A named capsule's name, after its icon and the 6 points beside it, up to its padding.
    static func name(of capsule: ClosedRange<CGFloat>) -> CGRect {
        let start = capsule.lowerBound + 14 + 16 + 6
        return CGRect(x: start, y: middle - 8, width: max(0, capsule.upperBound - 14 - start), height: 16)
    }
}

extension Picture {
    /// The average luminance in levels of a capsule's padding (`TabChosenTests.padding`).
    func luma(inPaddingOf capsule: ClosedRange<CGFloat>) -> Double {
        let values = TabChosenTests.padding(of: capsule).flatMap { pixels(in: $0) }.map(\.luma)
        return values.reduce(0, +) / Double(max(1, values.count))
    }

    /// How far what is drawn in `rect` stands out from the capsule's fill in its padding: the contrast ratio of the
    /// pixel there furthest from it, dark or light.
    func contrast(in rect: CGRect, against capsule: ClosedRange<CGFloat>) -> Double {
        let values = TabChosenTests.padding(of: capsule).flatMap { pixels(in: $0) }.map(\.luminance)
        let fill = values.reduce(0, +) / Double(max(1, values.count))
        let ratios = pixels(in: rect).map { pixel in
            (max(pixel.luminance, fill) + 0.05) / (min(pixel.luminance, fill) + 0.05)
        }
        return ratios.max() ?? 1
    }
}
