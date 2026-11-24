import CoreGraphics
import SwiftUI
import Testing

@testable import UsualMailUI

/// The rail's icons take the wallpaper's tone under them (2026-11-19): their own colours over the light sky, light over
/// the dark hills, and again whenever the window's size changes.
@MainActor
struct RailToneTests {
    /// The design's window, as the app opens.
    let window = CGSize(width: 1512, height: 982)

    @Test func overTheSkyTheIconKeepsItsColours() {
        // The rail's top, where search and the profile switch sit.
        #expect(RailTone.tint(for: CGRect(x: 96, y: 100, width: 32, height: 32), in: window) == nil)
    }

    @Test func overTheDarkHillsTheIconIsLight() {
        // The rail's foot, where settings sits: 98 points from the bottom of a 982-point window.
        let settings = CGRect(x: 96, y: 982 - 98 - 32, width: 32, height: 32)
        #expect(RailTone.tint(for: settings, in: window) == RailTone.onDark)
    }

    @Test func itFollowsTheWindowsSize() {
        // The same spot on the screen is sky in a short, wide window and hill in a tall one, since the wallpaper fills
        // the window: the answer is worked out from the window's size each time, not kept.
        let spot = CGRect(x: 96, y: 300, width: 32, height: 32)
        let short = RailTone.tint(for: spot, in: CGSize(width: 3000, height: 560))
        let tall = RailTone.tint(
            for: CGRect(x: 96, y: 1700, width: 32, height: 32), in: CGSize(width: 820, height: 2000))
        #expect(short == nil)
        #expect(tall == RailTone.onDark)
    }

    @Test func notMeasuredYetCountsAsLight() {
        #expect(RailTone.tint(for: .zero, in: window) == nil)
        #expect(RailTone.tint(for: CGRect(x: 0, y: 0, width: 32, height: 32), in: .zero) == nil)
    }
}
