import SwiftUI
import UniformTypeIdentifiers
import UsualMailKit

/// Settings' Appearance tab, settings of this device (`Background`), in sections: Background, a small square preview of
/// the background as the window shows it (the owner's words of 2026-11-25: "the background image is so big and
/// consuming all page, make it square") beside "Choose a picture…" (the system's picker, pictures only; the app copies
/// it at once, so the sandbox's access to the file isn't needed again) and "Use the default"; Soften, its switch; and on
/// the iPhone, what swiping a mail does (`SwipeSettings`).
struct AppearanceTab: View {
    var background = Background.shared
    @Environment(\.windowSize) private var window
    @State private var picking = false

    /// The preview's side.
    #if os(iOS)
        static let previewSide: CGFloat = 88
    #else
        static let previewSide: CGFloat = 96
    #endif

    var body: some View {
        SettingsView.page {
            SettingsView.group(
                "Background",
                footer: ["The picture stays on \(SettingsWords.device). It isn't sent to your server or anywhere else."]
            ) {
                HStack(alignment: .center, spacing: 16) {
                    preview
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            Button("Choose a picture…") { picking = true }
                                .disabled(background.isImporting)
                            if background.isImporting {
                                ProgressView().controlSize(.small)
                            }
                        }
                        if background.isCustom {
                            Button("Use the default") { background.useDefault() }
                                .disabled(background.isImporting)
                                .transition(.blurReveal)
                        }
                        if let problem = background.problem {
                            SettingsView.refusal(problem)
                                .transition(.blurReveal)
                        }
                    }
                    .buttonStyle(.bordered)
                    .tint(Theme.ink)
                    .pointer()
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 4)
            }
            SettingsView.group(
                "Soften", footer: ["A slight blur and dim behind the window, so the words over it read more easily."]
            ) {
                Toggle(
                    "Soften the background",
                    isOn: Binding(get: { background.softened }, set: { background.setSoftened($0) })
                )
                .toggleStyle(.switch)
                .foregroundStyle(Theme.ink)
                .pointer()
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

    /// The background as the window shows it, softening included, cut to a square.
    private var preview: some View {
        let side = Self.previewSide
        let windowWidth = window.width > 0 ? window.width : 1512
        return BackgroundImage(background: background, scale: side / windowWidth)
            .frame(width: side, height: side)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.hairline))
            .accessibilityElement()
            .accessibilityLabel(background.isCustom ? "Your picture" : "The default wallpaper")
    }
}
