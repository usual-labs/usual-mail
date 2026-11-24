import SwiftUI
import UsualMailKit

/// After pairing, in place of the whole mail window while `Onboarding.isNeeded(store)`: how much old mail a new inbox
/// brings in (before the first inbox only), connect Gmail, add the AI key, then what Usual Mail does while the first
/// mail is sorted, until "Go to Home". It resumes where this Mac left off with this server (`OnboardingProgress`), and
/// never past a need the server doesn't meet yet.
/// The window draws the wallpaper behind it and keeps the store running.
struct OnboardingView: View {
    let session: AppSession
    @Environment(MailStore.self) private var store
    @State private var step: Onboarding.Step?

    private var progress: OnboardingProgress { .shared }

    var body: some View {
        OnboardingFrame {
            if let step {
                Group {
                    switch step {
                    case .history:
                        HistoryStep(session: session) { go(after: .history) }
                    case .gmail:
                        GmailStep(session: session) { go(after: .gmail) }
                    case .aiKey:
                        AiKeyStep(session: session) { go(after: .aiKey) }
                    default:
                        WhileWaitingStep(home: goHome)
                    }
                }
                .id(step)
                .transition(.handOver)
            }
        }
        .onAppear(perform: begin)
    }

    /// Starts, or resumes, and notes on this Mac that the first run with this server has begun.
    private func begin() {
        guard step == nil else { return }
        let first = Onboarding.resume(store, progress: progress)
        progress.save(first, for: store.apiClient.server)
        step = first
    }

    private func go(after current: Onboarding.Step) {
        let next = Onboarding.step(after: current, in: store)
        progress.save(next, for: store.apiClient.server)
        withAnimation(Motion.move) { step = next }
    }

    /// "Go to Home": the first run ends on this Mac, and the window shows the mail. If the server still lacks
    /// something (its key was removed meanwhile, say), the first run picks up there instead.
    private func goHome() {
        progress.finish(for: store.apiClient.server)
        if Onboarding.isNeeded(store, progress: progress) {
            step = nil
            begin()
        }
    }
}

/// Where a step's card sits: centred in the window, offered the window less `OnboardingLayout.margin`, so it keeps that
/// margin at every size. A tall step (the Gmail step's set-up, the key step's "What the AI sees", the carousel) makes
/// room by scrolling or shrinking inside rather than reaching the edge.
struct OnboardingFrame<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ZStack { content }
            .padding(OnboardingLayout.margin)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The first run's room in the window after pairing.
enum OnboardingLayout {
    /// The least a step's card keeps from the window's edges. On the iPhone the card keeps its own 16 from the screen's
    /// sides (`onboardingCard`), and this keeps it clear of the top row's and the home indicator's areas.
    static let margin: EdgeInsets = {
        #if os(macOS)
            EdgeInsets(top: 24, leading: 24, bottom: 24, trailing: 24)
        #else
            EdgeInsets(top: 16, leading: 0, bottom: 16, trailing: 0)
        #endif
    }()
}
