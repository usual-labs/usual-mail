import SwiftUI
import UsualMailDesign
import UsualMailKit

// The guided set-up's two paths (`GoogleClientSetupView`): the person's own browser agent with the server's prompt, or
// the server's steps by hand.

/// "Let my agent do it": first "Copy the prompt" and "See the prompt", whose prompt text opens right under them,
/// scrolling inside, so the actions stay in view where the set-up scrolls (a short window shows the top of the part
/// that scrolls and fades its end); then the server's note on the prompt (signing in, filling it in, handing it over,
/// what stays with the person) and the app's one line on what the note doesn't say.
struct AgentPath: View {
    let prompt: String
    let note: String?
    @State private var showsPrompt = false

    typealias Words = Onboarding.GoogleClient

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 16) {
                CopyButton(text: prompt, look: .words(Words.copyPrompt))
                // The toggle is a button, so it has the pointing hand and the rows' soft highlight under the pointer.
                Button {
                    withAnimation(Motion.move) { showsPrompt.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.secondary)
                            .rotationEffect(.degrees(showsPrompt ? 90 : 0))
                        Text(Words.seePrompt)
                            .font(Theme.sans(12, weight: .medium))
                            .foregroundStyle(Theme.ink)
                    }
                    .contentShape(Rectangle())
                    .rowHover()
                }
                .buttonStyle(PlainControlStyle())
                .accessibilityValue(showsPrompt ? "Shown" : "Hidden")
            }
            .layoutMark(.promptActions)
            if showsPrompt {
                ScrollView {
                    Text(verbatim: prompt)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Theme.body)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: 180)
                .background(Color.white.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline) }
                .transition(.blurReveal)
            }
            if let note, !note.isEmpty {
                StepText(note)
            }
            StepText(Words.agentLine)
        }
    }
}

/// "Do it myself": the server's steps in order, each with its number, title, lines, a link to its console page and
/// the values to copy there.
struct StepsPath: View {
    let steps: [GoogleSetupStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                SetupStepRow(number: index + 1, step: step)
            }
        }
    }

    /// Where a step's Open link may go: Google Cloud's console, over https, on its own host and port. Any other address
    /// a server sends gets no link (the step still shows), so the app never opens a page a server picked elsewhere.
    static func page(_ address: String) -> URL? {
        guard let url = URL(string: address), url.scheme?.lowercased() == "https",
            url.host()?.lowercased() == consoleHost, url.port == nil, url.user() == nil, url.password() == nil
        else { return nil }
        return url
    }

    static let consoleHost = "console.cloud.google.com"
}

private struct SetupStepRow: View {
    let number: Int
    let step: GoogleSetupStep

    typealias Words = Onboarding.GoogleClient

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(verbatim: "\(number)")
                .font(Theme.sans(10, weight: .semibold))
                .foregroundStyle(Theme.secondary)
                .frame(width: 18, height: 18)
                .background(Color.white.opacity(0.7), in: Circle())
                .overlay { Circle().strokeBorder(Theme.hairline) }
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: step.title)
                        .font(Theme.sans(12, weight: .semibold))
                        .foregroundStyle(Theme.ink)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    if let page = StepsPath.page(step.url) {
                        Button {
                            Links.open(page)
                        } label: {
                            LinkWords(words: Words.open, color: Theme.ink)
                        }
                        .linkStyle()
                        .pointer()
                        .accessibilityLabel(Words.openLabel(step.title))
                    }
                }
                ForEach(step.lines, id: \.self) { StepText($0) }
                ForEach(Array((step.copy ?? []).enumerated()), id: \.offset) { _, value in
                    CopyValueRow(value: value)
                }
            }
        }
    }
}

/// A value to copy into the console: what it is, the value itself, and a small copy button.
private struct CopyValueRow: View {
    let value: GoogleSetupValue

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: value.label)
                    .font(Theme.sans(10))
                    .foregroundStyle(Theme.secondary)
                Text(verbatim: value.value)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            CopyButton(text: value.value, look: .icon(value.label))
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.vertical, 6)
        .background(Color.white.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline) }
    }
}

/// Copies its text to the pasteboard and says "Copied" for a moment: as the light button with its words, or as a small
/// icon named for VoiceOver after what it copies.
struct CopyButton: View {
    enum Look {
        case words(String)
        case icon(String)
    }

    let text: String
    let look: Look
    @State private var feedback = CopyFeedback()

    private var copied: Bool { feedback.copied }

    var body: some View {
        Button {
            Task { await feedback.copy(text) }
        } label: {
            switch look {
            case .words(let title):
                LightButtonLabel(title: copied ? Onboarding.GoogleClient.copied : title)
            case .icon:
                CopyIcon(copied: copied)
            }
        }
        .buttonStyle(PlainControlStyle())
        .accessibilityLabel(accessibilityName)
        .animation(Motion.reveal, value: copied)
    }

    private var accessibilityName: String {
        if copied { return Onboarding.GoogleClient.copied }
        switch look {
        case .words(let title): return title
        case .icon(let what): return Onboarding.GoogleClient.copyLabel(what)
        }
    }

}

/// The copy icon, a tick for a moment after copying, on a soft circle under the pointer.
private struct CopyIcon: View {
    let copied: Bool
    @Environment(\.isControlHovered) private var hovered

    var body: some View {
        Image(systemName: copied ? "checkmark" : "doc.on.doc")
            .font(.system(size: 11, weight: .regular))
            .foregroundStyle(hovered ? Theme.icon : Theme.secondary)
            .frame(width: 24, height: 24)
            .background(Color.black.opacity(hovered ? 0.05 : 0), in: Circle())
            .contentShape(Circle())
    }
}
