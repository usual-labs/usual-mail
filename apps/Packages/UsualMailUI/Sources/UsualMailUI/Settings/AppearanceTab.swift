import SwiftUI
import UniformTypeIdentifiers
import UsualMailKit

/// Settings' Appearance tab, an app setting on this Mac (`Background`): a small preview of the window's background in
/// the window's shape, "Choose a picture…" (the system's picker, pictures only; the app copies it at once, so the
/// sandbox's access to the file isn't needed again), "Use the default", and "Soften the background". On the iPhone
/// also what swiping a mail does (`SwipeSettings`).
struct AppearanceTab: View {
    var background = Background.shared
    @Environment(\.windowSize) private var window
    @State private var picking = false

    /// The preview's width; its height follows the window's shape.
    static let previewWidth: CGFloat = 200

    var body: some View {
        SettingsView.page {
            SettingsView.group("Background") {
                HStack(alignment: .top, spacing: 16) {
                    preview
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            SettingsView.link("Choose a picture…") { picking = true }
                                .disabled(background.isImporting)
                            if background.isImporting {
                                ProgressView().controlSize(.mini)
                            }
                        }
                        if background.isCustom {
                            SettingsView.link("Use the default") { background.useDefault() }
                                .disabled(background.isImporting)
                                .transition(.blurReveal)
                        }
                        if let problem = background.problem {
                            SettingsView.refusal(problem)
                                .transition(.blurReveal)
                        }
                    }
                }
                SettingsView.note("The picture stays on this Mac. It isn't sent to your server or anywhere else.")
            }
            SettingsView.group("Soften") {
                Toggle(
                    "Soften the background",
                    isOn: Binding(get: { background.softened }, set: { background.setSoftened($0) })
                )
                .toggleStyle(.switch)
                .controlSize(.mini)
                .font(Theme.sans(12))
                .foregroundStyle(Theme.ink)
                .pointer()
                SettingsView.note("A slight blur and dim behind the window, so the words over it read more easily.")
            }
            #if os(iOS)
                SwipeSettings()
            #endif
        }
        .animation(Motion.reveal, value: background.isCustom)
        .animation(Motion.reveal, value: background.problem)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.image]) { result in
            guard case .success(let url) = result else { return }
            Task { await background.choose(fileAt: url) }
        }
    }

    /// The background as the window shows it, softening included, at the window's aspect.
    private var preview: some View {
        let size = Self.previewSize(window: window)
        let windowWidth = window.width > 0 ? window.width : 1512
        return BackgroundImage(background: background, scale: size.width / windowWidth)
            .frame(width: size.width, height: size.height)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline))
            .accessibilityElement()
            .accessibilityLabel(background.isCustom ? "Your picture" : "The default wallpaper")
    }

    /// The preview's size: `previewWidth` wide, as tall as the window's shape makes it; the design's window
    /// (1512 × 982) before it is measured.
    static func previewSize(window: CGSize) -> CGSize {
        let shape = window.width > 0 && window.height > 0 ? window : CGSize(width: 1512, height: 982)
        return CGSize(width: previewWidth, height: (previewWidth * shape.height / shape.width).rounded())
    }
}
