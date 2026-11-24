import SwiftUI

/// The window's background, filling it behind everything: the design's wallpaper, or the picture the person chose in
/// Settings, softened when they asked (`Background`).
struct Wallpaper: View {
    var body: some View {
        BackgroundImage(background: Background.shared)
            .ignoresSafeArea()
    }
}

/// The frosted card the content sits on: 700 points wide in the design, rounded at the top, running to the window's
/// bottom edge.
struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        let shape = UnevenRoundedRectangle(topLeadingRadius: 16, topTrailingRadius: 16)
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Theme.card, in: shape)
            .background(.ultraThinMaterial, in: shape)
            .clipShape(shape)
            .shadow(color: .black.opacity(0.05), radius: 10, y: 4)
    }
}
