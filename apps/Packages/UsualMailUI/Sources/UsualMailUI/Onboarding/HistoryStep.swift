import SwiftUI
import UsualMailDesign
import UsualMailKit

/// "How much old mail?": how many days back a new inbox's first sync reaches (the server's first-sync window), asked
/// before the first inbox is connected, since it applies only to inboxes connected from then on. The AI sorts and
/// summarizes all of it. Continue saves the choice only when it differs from the server's.
struct HistoryStep: View {
    let session: AppSession
    let next: () -> Void
    @Environment(MailStore.self) private var store
    @State private var choice: Int?
    @State private var loading = false
    @State private var saving = false
    @State private var problem: String?

    static let title = "How much old mail?"
    static let words =
        "New mail comes in as it arrives. Usual Mail also brings in some of the mail you already have, and the AI sorts "
        + "and summarizes all of it; each message costs a little on your Vercel account."

    var body: some View {
        let window = store.firstSyncWindow
        let picked = choice ?? Onboarding.firstSyncSelection(current: window?.days)
        VStack(alignment: .leading, spacing: 16) {
            StepTitle(Self.title)
            StepText(Self.words)
            if let window {
                VStack(spacing: 8) {
                    ForEach(Onboarding.firstSyncChoices(current: window.days)) { option in
                        ChoiceRow(title: option.words, selected: option.days == picked, enabled: window.changeable) {
                            choice = option.days
                        }
                    }
                }
                if !window.changeable {
                    StepText(Onboarding.firstSyncFixedWords(days: window.days), size: 10, color: Theme.time)
                }
            } else if loading {
                ProgressView().controlSize(.small)
            } else {
                StepText(Onboarding.firstSyncUnknownWords, size: 10, color: Theme.time)
            }
            if let problem {
                StepText(problem, color: UsualColor.danger)
                    .transition(.blurReveal)
            }
            OnboardingFooter(session: session) {
                PrimaryButton(title: "Continue", busy: saving || loading) { save(picked) }
            }
        }
        .animation(Motion.reveal, value: problem)
        .animation(Motion.reveal, value: window?.days)
        .onboardingCard()
        .revealOnAppear()
        .task {
            // The refresh brings the window for a person's device; ask once more if it hasn't yet.
            guard store.firstSyncWindow == nil else { return }
            loading = true
            await store.loadFirstSyncWindow()
            loading = false
        }
    }

    /// Keeps the choice on the server when it can be changed and differs from the server's, then moves on.
    private func save(_ days: Int) {
        guard !saving else { return }
        let window = store.firstSyncWindow
        guard
            let change = Onboarding.firstSyncChange(chosen: days, current: window?.days, changeable: window?.changeable)
        else {
            next()
            return
        }
        saving = true
        problem = nil
        Task {
            let shown = store.problem?.id
            let saved = await store.updateFirstSync(days: change)
            saving = false
            if saved {
                next()
            } else {
                problem = refusal(since: shown)
            }
        }
    }

    /// The store's words for the refusal, which this step shows in place of its own.
    private func refusal(since shown: UUID?) -> String {
        guard let reported = store.problem, reported.id != shown else {
            return "Your server didn't keep the choice. Try again."
        }
        store.dismissProblem()
        return reported.message
    }
}
