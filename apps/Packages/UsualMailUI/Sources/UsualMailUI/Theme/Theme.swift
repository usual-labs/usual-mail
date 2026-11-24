import SwiftUI
import UsualMailDesign

/// The Mac app's look, from the Figma design of 2026-11-17: Geist Sans on frosted glass over a wallpaper.
///
/// Fonts come from the design package (`UsualMailDesign`); the sizes and colours below are the design's own, which
/// the package's tokens don't hold yet.
public enum Theme {
    /// Registers the bundled fonts (Geist Serif, Geist Sans, Prociono) with the system. Call once at launch, before
    /// the first view draws. Returns the faces that failed, by PostScript name; empty when all is well.
    @discardableResult
    public static func registerFonts() -> [String: String] {
        UsualFonts.register()
        return UsualFonts.failures
    }

    /// Geist Sans at a fixed size. The design uses 10 and 12 points, regular and bold (here the nearest bundled
    /// weight, semibold).
    static func sans(_ size: CGFloat, weight: UsualFontWeight = .regular) -> Font {
        .custom(UsualFonts.face(.sans, weight: weight)?.postScriptName ?? "Geist-Regular", fixedSize: size)
    }

    /// Prociono, the wordmark's face.
    static func wordmark(_ size: CGFloat) -> Font {
        .custom(UsualFonts.face(.wordmark, weight: .regular)?.postScriptName ?? "Prociono-Regular", fixedSize: size)
    }

    /// A page's side margin inside the card: the design's 24 on the Mac; 16 on the iPhone, whose card is as wide as
    /// the screen.
    #if os(macOS)
        static let pageInset: CGFloat = 24
    #else
        static let pageInset: CGFloat = 16
    #endif
    /// A page's padding inside the card.
    static let page = EdgeInsets(top: 24, leading: pageInset, bottom: 24, trailing: pageInset)

    /// Titles and labels.
    static let ink = Color.black
    /// A mail's own words on the mail page (black at 75%).
    static let body = Color.black.opacity(0.75)
    /// The summary box's edge (#E5E5EA).
    static let hairline = Color(red: 229 / 255, green: 229 / 255, blue: 234 / 255)
    /// The line under a title: who wrote, and what the mail is about.
    static let secondary = Color.black.opacity(0.5)
    /// "New" and "Seen".
    static let sectionTitle = Color.black.opacity(0.3)
    /// "16 New Items" over the screening list (#C7C7CC).
    static let listTitle = Color(red: 199 / 255, green: 199 / 255, blue: 204 / 255)
    /// A time beside a name in the screening list (#AEAEB2).
    static let quietTime = Color(red: 174 / 255, green: 174 / 255, blue: 178 / 255)
    /// A time shown on hover (#A1A1A1).
    static let time = Color(red: 161 / 255, green: 161 / 255, blue: 161 / 255)
    /// Icons (#141B34, Hugeicons' stroke colour).
    static let icon = Color(red: 20 / 255, green: 27 / 255, blue: 52 / 255)
    /// The card's frosted fill (#F7F7F7 at 85%), over a blur.
    static let card = Color(red: 247 / 255, green: 247 / 255, blue: 247 / 255).opacity(0.85)
    /// A control's fill on the wallpaper (white at 30%).
    static let control = Color.white.opacity(0.3)
    /// A selected control's fill under the pointer.
    static let controlHovered = Color.white.opacity(0.45)
    /// A hint of white on a clear control under the pointer.
    static let controlHint = Color.white.opacity(0.15)
}
