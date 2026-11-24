import Foundation
import SwiftUI
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The current stack's rail button reads as chosen over the wallpaper, light or dark (the coordinator's brief of
/// 2026-11-20, from the owner's captures at 1512 × 982: beside the icon, chosen and not differed by 2 to 4 levels over
/// the sky, clearly over the hills). It is lit (`RailLook.lit`): white under its glass, its icon in the design's ink.
/// On the real `Rail`, drawn offscreen (`Picture`: glass flat, without the lens) where the design's window has it, so
/// each icon takes the wallpaper's tone there (`RailTone`), over a flat sky and a flat hill colour. When its glass was
/// tinted instead, it differed from the others by 7 to 8 levels over the sky here (47 over the hills), and settings'
/// light icon all but vanished on it (1.04 to 1 over the sky).
@MainActor
struct RailChosenTests {
    /// The sky and the hills under the glass. This renderer draws clear glass 22 to 26 levels lighter than what lies
    /// under it, so these are the colours whose glass it draws as the owner's captures beside the icons, not chosen:
    /// 207 218 223 beside To reply, 95 119 87 beside Settings (`thePictureIsAsTheScreenShowsIt`).
    static let sky = Color(red: 185 / 255, green: 196 / 255, blue: 201 / 255)
    static let hills = Color(red: 69 / 255, green: 93 / 255, blue: 61 / 255)
    static let window = CGSize(width: 1512, height: 982)
    static let layout = MailLayout(size: window)
    /// How much lighter, in levels of luminance (0 to 255), the chosen button is beside its icon than every other.
    static let margin = 25.0
    /// The least contrast of the chosen button's icon against its own fill.
    static let contrast = 3.0
    /// The buttons that can be chosen: search (while it shows) and each stack's.
    static let buttons: [Place] = [.search, .toReply, .pinned, .snoozed, .inbox, .settings]

    @Test func theCurrentStacksButtonStandsOutOverTheSkyAndTheHills() async throws {
        let store = try await MailStore.sample()
        let inboxes = store.lists.inboxes.count
        for (name, ground) in [("sky", Self.sky), ("hills", Self.hills)] {
            for target in Self.buttons {
                let picture = try picture(target, ground: ground, store: store)
                let square = Self.square(of: target, inboxes: inboxes)
                let chosen = picture.luma(besideIconIn: square)
                for other in Self.buttons where other != target {
                    let plain = picture.luma(besideIconIn: Self.square(of: other, inboxes: inboxes))
                    #expect(
                        chosen - plain >= Self.margin, "\(target) over the \(name): \(other) \(plain), it \(chosen)")
                }
                let ratio = picture.iconContrast(in: square)
                #expect(ratio >= Self.contrast, "\(target)'s icon over the \(name): \(ratio) to 1")
            }
        }
    }

    @Test func thePictureIsAsTheScreenShowsIt() async throws {
        let store = try await MailStore.sample()
        let inboxes = store.lists.inboxes.count
        // Nothing chosen, the glass reads as in the owner's captures beside the icons.
        let sky = try picture(.tab(.home), ground: Self.sky, store: store)
        let hills = try picture(.tab(.home), ground: Self.hills, store: store)
        let captured = (
            sky: Pixel(red: 207, green: 218, blue: 223).luma, hills: Pixel(red: 95, green: 119, blue: 87).luma
        )
        for place in Self.buttons {
            let square = Self.square(of: place, inboxes: inboxes)
            #expect(abs(sky.luma(besideIconIn: square) - captured.sky) < 4, "\(place)")
            #expect(abs(hills.luma(besideIconIn: square) - captured.hills) < 4, "\(place)")
        }
        // Each icon takes the wallpaper's tone where the window has it: To reply's dark over the sky, Settings' light
        // over the hills. So a lit button's icon is checked against the tone it would otherwise take.
        #expect(sky.pixels(in: Self.icon(in: Self.square(of: .toReply, inboxes: inboxes))).contains { $0.luma < 90 })
        #expect(sky.pixels(in: Self.icon(in: Self.square(of: .settings, inboxes: inboxes))).contains { $0.luma > 240 })
    }

    @Test func litMeetsTheDragAndTheFrost() {
        let lit = Color.white.opacity(RailLook.lit)
        #expect(RailLook.lit == 0.8)
        // Narrow or open over the wallpaper: the current stack's button lit, the others nothing.
        #expect(RailLook().fill(chosen: true, accepting: false, takesMail: false) == lit)
        #expect(RailLook(isOpen: true).fill(chosen: true, accepting: false, takesMail: true) == lit)
        #expect(RailLook().fill(chosen: false, accepting: false, takesMail: true) == .clear)
        // Mail dragged: the buttons taking it are tinted by their glass, not lit, and the current one stays lit as it
        // takes it too; a current one that takes none fades with its icon, so the three lead.
        let dragging = RailLook(isOpen: true, dimsOthers: true)
        #expect(dragging.fill(chosen: false, accepting: true, takesMail: true) == .clear)
        #expect(dragging.fill(chosen: true, accepting: true, takesMail: true) == lit)
        #expect(dragging.fill(chosen: true, accepting: false, takesMail: false) == Color.white.opacity(0.8 * 0.45))
        // Open over the card, frosted as before: every button white at 70%, the chosen or taking one the hairline's
        // grey.
        let frosted = RailLook(isOpen: true, reachesCard: true)
        #expect(frosted.fill(chosen: true, accepting: false, takesMail: true) == Theme.hairline)
        #expect(frosted.fill(chosen: false, accepting: true, takesMail: true) == Theme.hairline)
        #expect(frosted.fill(chosen: false, accepting: false, takesMail: false) == Color.white.opacity(0.7))
    }

    /// The real rail with `place` showing, where the design's window has it, over `ground`. Its room up to the card is
    /// none (`room`), so the pointer's area, an AppKit view this renderer draws as a yellow block, takes no width;
    /// narrow, the rail draws the same in any room.
    private func picture(_ place: Place, ground: Color, store: MailStore) throws -> Picture {
        let rail = Rail(
            place: place, mark: ProfileMark(profile: nil, active: place.destination == .mail),
            inboxes: store.lists.inboxes, counts: nil, room: -MailLayout.gap, window: Self.window,
            chooseProfile: { _ in }, press: { _ in }
        )
        .environment(store)
        .padding(.leading, Self.left)
        .padding(.top, Self.layout.top)
        .padding([.bottom, .trailing], 20)
        .background(ground)
        return try Picture(of: rail)
    }

    /// The rail's left edge in the design's window: the row of columns is centred, the rail inset in its side.
    static var left: CGFloat {
        let row = 2 * layout.side + 2 * MailLayout.gap + layout.center
        return (window.width - row) / 2 + layout.railInset
    }

    /// Where `place`'s round button is, from the window's top left: search at the rail's top, then the switch, To
    /// reply, Pinned, Snoozed and the classic inbox, `spacing` apart; settings at the column's foot.
    static func square(of place: Place, inboxes: Int) -> CGRect {
        let top = layout.top
        let step = RailFit.button + RailFit.spacing
        let lists = top + step + RailFit.pill(inboxes: inboxes) + RailFit.spacing
        let y =
            switch place {
            case .search: top
            case .toReply: lists
            case .pinned: lists + step
            case .snoozed: lists + 2 * step
            case .inbox: lists + 3 * step
            default: top + RailFit.column(windowHeight: window.height) - RailFit.button
            }
        return CGRect(x: left, y: y, width: RailFit.button, height: RailFit.button)
    }

    /// A button's icon, 16 points in the middle of its square.
    static func icon(in square: CGRect) -> CGRect {
        square.insetBy(dx: 8, dy: 8)
    }

    /// A button's glass beside its icon, left and right of it: clear of its edge, its icon and a count's badge.
    static func beside(_ square: CGRect) -> [CGRect] {
        [
            CGRect(x: square.minX + 3, y: square.minY + 12, width: 4, height: 8),
            CGRect(x: square.maxX - 7, y: square.minY + 12, width: 4, height: 8),
        ]
    }
}

extension Picture {
    /// The average luminance in levels of a button's glass beside its icon (`RailChosenTests.beside`).
    fileprivate func luma(besideIconIn square: CGRect) -> Double {
        average(RailChosenTests.beside(square).flatMap { pixels(in: $0) }.map(\.luma))
    }

    /// How far a button's icon stands out from its own fill: the contrast ratio, against the fill beside the icon, of
    /// the icon's pixel furthest from it, dark or light.
    fileprivate func iconContrast(in square: CGRect) -> Double {
        let fill = average(RailChosenTests.beside(square).flatMap { pixels(in: $0) }.map(\.luminance))
        let ratios = pixels(in: RailChosenTests.icon(in: square)).map { pixel in
            (max(pixel.luminance, fill) + 0.05) / (min(pixel.luminance, fill) + 0.05)
        }
        return ratios.max() ?? 1
    }

    private func average(_ values: [Double]) -> Double {
        values.reduce(0, +) / Double(max(1, values.count))
    }
}
