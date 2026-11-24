import SwiftUI

/// The one filled button, for the step a screen is there for (Pair, Sign in with Google): dark, its words white,
/// 32 points high. Faded while it can't be pressed; a small spinner while it works.
struct DarkButtonLabel: View {
    let title: String
    var busy = false
    var enabled = true
    @Environment(\.isControlHovered) private var hovered

    var body: some View {
        HStack(spacing: 6) {
            if busy { ProgressView().controlSize(.mini) }
            Text(title).font(Theme.sans(12, weight: .medium))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .frame(height: 32)
        .background(Theme.ink.opacity(enabled ? (hovered ? 0.8 : 1) : 0.3), in: Capsule())
    }
}
