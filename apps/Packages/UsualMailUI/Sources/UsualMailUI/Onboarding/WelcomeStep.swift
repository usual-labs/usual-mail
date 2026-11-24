import SwiftUI
import UsualMailKit

/// The welcome, laid out like usual.dev: the wordmark stays at the top left (`PairingView`), the manifesto sits at the
/// bottom left in a few lines of one width, over the wallpaper's hills, with one button at the right of that column
/// (owner's words of 2026-11-24: "move the get started button to right", on the Mac and the iPhone).
struct WelcomeStep: View {
    let start: () -> Void

    /// The owner's manifesto (option D, chosen 2026-11-17).
    static let manifesto =
        "Email was made for letters. Today most of it isn't: receipts, newsletters, alerts and codes, all in one long "
        + "list, in the order they arrived, beside the few people who actually need you. We think an inbox is for "
        + "people. Everything else should be read for you, put where it belongs, and told to you in a line. And "
        + "because it's your mail, it should run on your own server, with your own AI, in the open. The usual, done "
        + "well."

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text(verbatim: Self.manifesto)
                .font(Theme.sans(15))
                .lineSpacing(5)
                .foregroundStyle(.white.opacity(0.95))
                // The hills under it are dark green in most windows and lighter in some; a soft shadow keeps it read,
                // and a tight one close behind the letters a little more (owner's words of 2026-11-24: "a bit of
                // shadow behind text, just a bit so it would be more readable").
                .shadow(color: .black.opacity(0.3), radius: 2, y: 1)
                .shadow(color: .black.opacity(0.35), radius: 8, y: 1)
                .fixedSize(horizontal: false, vertical: true)
            PrimaryButton(title: "Get started", action: start)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .frame(maxWidth: 440, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .revealOnAppear(delay: 0.1)
    }
}

/// "Where should Usual Mail run?": the person's own server, or Usual hosted, which is shown but not built.
struct WhereToRunStep: View {
    let back: () -> Void
    let next: () -> Void
    @State private var ownServer = true

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            StepTitle("Where should Usual Mail run?")
            VStack(spacing: 8) {
                ChoiceRow(
                    title: "Your own server",
                    words: "Run it on a machine you own. You hold your mail, your keys and your settings.",
                    selected: ownServer
                ) { ownServer = true }
                ChoiceRow(
                    title: "Usual hosted", tag: "Coming soon", words: "We run the server for you.", selected: false,
                    enabled: false
                ) {}
            }
            HStack {
                QuietButton("Back", action: back)
                Spacer(minLength: 12)
                PrimaryButton(title: "Continue", enabled: ownServer, action: next)
            }
        }
        .onboardingCard(width: 400)
        .revealOnAppear()
    }
}
