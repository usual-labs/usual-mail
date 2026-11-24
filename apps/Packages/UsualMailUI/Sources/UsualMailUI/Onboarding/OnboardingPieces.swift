import SwiftUI
import UsualMailDesign
import UsualMailKit

// The first run's pieces: a frosted card on the wallpaper (as pairing always was), a step's title and words, fields,
// the choice rows, and the footer every step after pairing shares.

extension View {
    /// The first run's card: the design's frosted #F7F7F7 at 85%, rounded, a little shadow.
    func onboardingCard(width: CGFloat = 440) -> some View {
        padding(24)
            // On the iPhone, as wide as the screen leaves it, 16 from its edges.
            #if os(macOS)
                .frame(width: width, alignment: .leading)
            #else
                .frame(maxWidth: width, alignment: .leading)
            #endif
            .background(Theme.card, in: OnboardingCardShape.shape)
            .background(.ultraThinMaterial, in: OnboardingCardShape.shape)
            .shadow(color: .black.opacity(0.05), radius: 10, y: 4)
            .layoutMark(.card)
            #if os(iOS)
                .padding(.horizontal, 16)
            #endif
    }
}

/// The first run's card's outline: rounded 16 all round on the Mac. On the iPhone, where the cards sit at the foot of
/// the screen (`OnboardingLayout.cardsAtFoot`), the two bottom corners follow the screen's own, their radius the
/// screen's less the card's distance from its edges (`ConcentricRectangle`), never under 16; the top stays 16 (owner's
/// words of 2026-11-24: "make the bottom border radiuses to fit the iphone screen, ... not top just bottom").
enum OnboardingCardShape {
    #if os(iOS)
        static let shape = ConcentricRectangle(
            topLeadingCorner: .fixed(16), topTrailingCorner: .fixed(16),
            bottomLeadingCorner: .concentric(minimum: .fixed(16)),
            bottomTrailingCorner: .concentric(minimum: .fixed(16)))
    #else
        static let shape = RoundedRectangle(cornerRadius: 16)
    #endif
}

/// A step's title, at the size a mail's subject is read.
struct StepTitle: View {
    let words: String

    init(_ words: String) {
        self.words = words
    }

    var body: some View {
        Text(words)
            .font(Theme.sans(16, weight: .medium))
            .foregroundStyle(Theme.ink)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A step's words, wrapping: 12 points for what to read, 10 for a note.
struct StepText: View {
    let words: String
    var size: CGFloat = 12
    var color: Color = Theme.secondary

    init(_ words: String, size: CGFloat = 12, color: Color = Theme.secondary) {
        self.words = words
        self.size = size
        self.color = color
    }

    var body: some View {
        Text(verbatim: words)
            .font(Theme.sans(size))
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A field with its name above it, in pairing's style: white at 60% on the card, 32 points high.
struct StepField: View {
    let label: String
    var prompt = ""
    @Binding var text: String
    var secure = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(Theme.sans(10, weight: .medium))
                .foregroundStyle(Theme.secondary)
            Group {
                if secure {
                    SecureField(label, text: $text, prompt: Text(prompt))
                } else {
                    TextField(label, text: $text, prompt: Text(prompt))
                        .autocorrectionDisabled()
                        // An address, a pairing code and a key are typed as they are.
                        #if os(iOS)
                            .textInputAutocapitalization(.never)
                        #endif
                }
            }
            .labelsHidden()
            .textFieldStyle(.plain)
            .font(Theme.sans(12))
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(Color.white.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// The step's one filled button (`DarkButtonLabel`), on Return.
struct PrimaryButton: View {
    let title: String
    var busy = false
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            DarkButtonLabel(title: title, busy: busy, enabled: enabled && !busy)
        }
        .buttonStyle(PlainControlStyle())
        .disabled(!enabled || busy)
        .keyboardShortcut(.defaultAction)
    }
}

/// A quiet button that reads as a link: Back, Use another server…, Try again, Stop waiting. The pointing hand, and
/// underlined under the pointer.
struct QuietButton: View {
    let title: String
    let action: () -> Void

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            LinkWords(words: title)
        }
        .linkStyle()
        .pointer()
    }
}

/// A link to a web page: the pointing hand, and underlined under the pointer.
struct WebLink: View {
    let title: String
    let destination: URL

    var body: some View {
        Link(destination: destination) {
            LinkWords(words: title, color: Theme.ink)
        }
        .pointer()
    }
}

/// Words that act as a link, at 10 points: underlined while the pointer is over them, if they can be clicked.
struct LinkWords: View {
    let words: String
    var color: Color = Theme.secondary
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
        Text(verbatim: words)
            .font(Theme.sans(10))
            .foregroundStyle(color)
            .underline(enabled && hovering)
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.15), value: hovering)
    }
}

/// The light button beside a step's dark one ("Add another Gmail"): white on the card, brighter under the pointer.
struct LightButtonLabel: View {
    let title: String
    var busy = false
    @Environment(\.isControlHovered) private var hovered

    var body: some View {
        HStack(spacing: 6) {
            if busy { ProgressView().controlSize(.mini) }
            Text(title).font(Theme.sans(12, weight: .medium))
        }
        .foregroundStyle(Theme.ink)
        .padding(.horizontal, 16)
        .frame(height: 32)
        .background(Color.white.opacity(hovered ? 0.95 : 0.7), in: Capsule())
        .overlay { Capsule().strokeBorder(Theme.hairline) }
    }
}

/// One answer to a step's question, as a row: a round mark, its name and what it means. A row that can't be chosen
/// yet is faded.
struct ChoiceRow: View {
    let title: String
    var tag: String? = nil
    var words: String? = nil
    let selected: Bool
    var enabled = true
    let choose: () -> Void

    var body: some View {
        Button(action: choose) {
            ChoiceRowLabel(selected: selected) {
                mark.alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 0) {
                        Text(title).font(Theme.sans(12, weight: .semibold)).foregroundStyle(Theme.ink)
                        if let tag {
                            Text(verbatim: " · \(tag)").font(Theme.sans(12)).foregroundStyle(Theme.secondary)
                        }
                    }
                    if let words {
                        Text(words)
                            .font(Theme.sans(12))
                            .foregroundStyle(Theme.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .buttonStyle(PlainControlStyle())
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .animation(Motion.reveal, value: selected)
    }

    private var mark: some View {
        ZStack {
            Circle().strokeBorder(selected ? Theme.ink : Theme.ink.opacity(0.3), lineWidth: 1.5)
            if selected { Circle().fill(Theme.ink).padding(4) }
        }
        .frame(width: 14, height: 14)
    }
}

/// A choice row's frame: white on the card, brighter under the pointer, edged in ink when chosen.
private struct ChoiceRowLabel<Content: View>: View {
    let selected: Bool
    @ViewBuilder var content: Content
    @Environment(\.isControlHovered) private var hovered

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) { content }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.white.opacity(fill), in: RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10).strokeBorder(selected ? Theme.ink.opacity(0.6) : Theme.hairline)
            }
            .contentShape(RoundedRectangle(cornerRadius: 10))
    }

    private var fill: Double {
        switch (selected, hovered) {
        case (true, _): 0.8
        case (false, true): 0.65
        case (false, false): 0.45
        }
    }
}

/// The foot of each step after pairing: a quiet way back to pairing (Settings is out of reach until the first run
/// ends), and the step's button.
struct OnboardingFooter<Primary: View>: View {
    let session: AppSession
    @ViewBuilder var primary: Primary
    @State private var confirming = false

    var body: some View {
        HStack(alignment: .center) {
            QuietButton("Use another server…") { confirming = true }
                .disabled(session.isDisconnecting)
            Spacer(minLength: 12)
            primary
        }
        .padding(.top, 4)
        .confirmationDialog("Disconnect from this server?", isPresented: $confirming) {
            Button("Disconnect", role: .destructive) { Task { await session.disconnect() } }
        }
    }
}
