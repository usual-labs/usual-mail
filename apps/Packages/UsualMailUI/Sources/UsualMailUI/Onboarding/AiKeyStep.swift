import SwiftUI
import UsualMailDesign
import UsualMailKit

/// "Add your AI key": a Vercel AI Gateway key, required. What leaves the server and to whom is the server's (core's)
/// words: the destination and the terms always above the button, the rest under "What the AI sees". Saving is the
/// person's yes, so it waits for those words; the server tests the key before it answers, and a key that works moves on
/// by itself. The key leaves the field the moment it is sent and is kept nowhere on this Mac.
struct AiKeyStep: View {
    let session: AppSession
    let next: () -> Void
    @Environment(MailStore.self) private var store
    @State private var model: OnboardingAiKey?
    @State private var key = ""
    @State private var showsDetail = false
    /// The button pressed last, which keeps its name while the server tests.
    @State private var pressed = "Save and test"

    static let words =
        "Usual Mail sorts every message and writes a line on what it says, using your own Vercel AI Gateway key. You "
        + "pay Vercel for what you use, nothing more. The key stays on your server; no app or device sees it again."

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            StepTitle("Add your AI key")
            StepText(Self.words)
            VStack(alignment: .leading, spacing: 6) {
                StepField(label: "Vercel AI Gateway key", text: $key, secure: true)
                    .onSubmit(save)
                if let keys = Onboarding.vercelKeys {
                    WebLink(title: "Get a key from Vercel", destination: keys)
                }
            }
            disclosure
            if case .done(.problem(let words)) = model?.check {
                StepText(words, color: UsualColor.danger)
                    .transition(.blurReveal)
            }
            OnboardingFooter(session: session) {
                if busy {
                    PrimaryButton(title: pressed, busy: true) {}
                } else if key.isEmpty, model?.canTestAgain == true {
                    PrimaryButton(title: "Test again") {
                        pressed = "Test again"
                        Task { await model?.testAgain() }
                    }
                } else {
                    PrimaryButton(title: "Save and test", busy: busy, enabled: canSave, action: save)
                }
            }
        }
        .animation(Motion.reveal, value: model?.check)
        .animation(Motion.reveal, value: model?.disclosure)
        .onboardingCard(width: 460)
        .revealOnAppear()
        .task {
            guard model == nil else { return }
            let model = OnboardingAiKey(store: store)
            self.model = model
            await model.loadDisclosure()
        }
        .onChange(of: model?.check) { _, check in
            if check == .done(.works) { next() }
        }
    }

    @ViewBuilder private var disclosure: some View {
        switch model?.disclosure ?? .loading {
        case .loading:
            ProgressView().controlSize(.small)
        case .failed(let words):
            VStack(alignment: .leading, spacing: 6) {
                StepText(words, color: UsualColor.danger)
                QuietButton("Try again") { Task { await model?.loadDisclosure() } }
            }
            .transition(.blurReveal)
        case .loaded(let words):
            VStack(alignment: .leading, spacing: 8) {
                StepText(words.destination, color: Theme.ink)
                StepText(words.terms, color: Theme.ink)
                // The toggle is a button, so it has the pointing hand and the rows' soft highlight under the pointer.
                Button {
                    withAnimation(Motion.move) { showsDetail.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.secondary)
                            .rotationEffect(.degrees(showsDetail ? 90 : 0))
                        Text("What the AI sees")
                            .font(Theme.sans(12, weight: .medium))
                            .foregroundStyle(Theme.ink)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .rowHover()
                }
                .buttonStyle(PlainControlStyle())
                .accessibilityValue(showsDetail ? "Shown" : "Hidden")
                if showsDetail {
                    ScrollView {
                        AiDisclosureDetail(words: words)
                            .padding(.leading, 15)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(maxHeight: 240)
                    .transition(.blurReveal)
                }
            }
            .transition(.blurReveal)
        }
    }

    private var busy: Bool { model?.check == .busy }

    private var canSave: Bool {
        model?.canSave == true && !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Sends the key and clears the field at once, so it stays nowhere while the server tests it.
    private func save() {
        guard canSave, let model else { return }
        let typed = key
        key = ""
        pressed = "Save and test"
        Task { await model.save(key: typed) }
    }
}

/// The detail of what leaves the server, as the server words it: the lead, each part sent (and what never is), then
/// how far back.
struct AiDisclosureDetail: View {
    let words: AiDisclosure

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !words.lead.isEmpty {
                StepText(words.lead)
            }
            ForEach(Array(words.sent.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: item.label)
                        .font(Theme.sans(12, weight: .semibold))
                        .foregroundStyle(Theme.ink)
                    StepText(item.words)
                }
            }
            if !words.history.isEmpty {
                StepText(words.history)
            }
        }
    }
}
