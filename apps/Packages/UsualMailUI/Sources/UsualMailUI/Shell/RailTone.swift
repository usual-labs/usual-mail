import SwiftUI

/// The rail's icons over the wallpaper (coordinator's decision of 2026-11-19, after settings moved to the foot of the
/// rail, over the wallpaper's dark hills): drawn as the design draws them where the wallpaper under the button is
/// light, and light where it is dark, as the corner note adapts (`WallpaperTone`). The button's glass stays as it is.
/// Worked out again whenever the button moves or the window changes size.
enum RailTone {
    /// The icon's colour over dark wallpaper: white, a little softened, like the corner note's words.
    static let onDark = Color.white.opacity(0.92)

    /// The tint for an icon whose button covers `frame` (window coordinates) in a window of `window`'s size: nil (the
    /// icon's own colours) over a light wallpaper, `onDark` over a dark one. A window not measured yet counts as light.
    @MainActor
    static func tint(for frame: CGRect, in window: CGSize) -> Color? {
        guard window.width > 0, window.height > 0, frame.width > 0, frame.height > 0 else { return nil }
        return WallpaperTone.isLight(under: frame, in: window) ? nil : onDark
    }
}

extension EnvironmentValues {
    /// The window's size, which the rail hands its icons so they can tell what wallpaper lies under them.
    @Entry var railWindow: CGSize = .zero
}

/// An icon on the rail, toned to the wallpaper under it (`RailTone`); in its own colours while its button is frosted,
/// open over the card (`RailLook.frosted`), or lit as the current stack's (`RailLook.lit`).
struct RailIcon: View {
    let icon: Icon
    /// Its button is lit, white under it whatever the wallpaper.
    var lit = false
    @Environment(\.railWindow) private var window
    @Environment(\.railLook) private var look
    @State private var frame: CGRect = .zero

    var body: some View {
        let tint = look.frosted || lit ? nil : RailTone.tint(for: frame, in: window)
        icon.view(tint: tint)
            .onGeometryChange(for: CGRect.self) {
                $0.frame(in: .global)
            } action: {
                frame = $0
            }
            .animation(Motion.reveal, value: tint == nil)
    }
}
