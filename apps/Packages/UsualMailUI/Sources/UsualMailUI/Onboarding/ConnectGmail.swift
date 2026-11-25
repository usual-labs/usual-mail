import SwiftUI
import UsualMailDesign
import UsualMailKit

/// "Connect your Gmail", the first step after pairing: sign in with Google, as often as there are Gmail inboxes to
/// connect; each connected inbox is listed, and Continue waits for the first.
struct GmailStep: View {
    let session: AppSession
    let next: () -> Void
    @Environment(MailStore.self) private var store

    static let words =
        "Sign in with Google and allow Usual Mail to read, sort and label your mail. Your server keeps the access; your "
        + "password stays with Google."
    static let headsUp = [
        "Google will warn that it hasn't verified the app. That's expected for a server you run yourself: continue "
            + "past it, and tick the box that lets Usual Mail read and change your Gmail.",
        "While your Google client is in Testing, Google asks you to sign in again each week. Usual Mail will tell you "
            + "when.",
    ]
    static let testUser = "Another address must first be listed as a test user in your Google client."

    /// While the step has nothing to sign in with yet (asking the server, or its Google client's set-up), the notes on
    /// signing in wait; hidden from the start, so they don't flash before the set-up shows.
    @State private var holdsNotes = true

    var body: some View {
        let inboxes = store.lists.inboxes
        VStack(alignment: .leading, spacing: 16) {
            StepTitle("Connect your Gmail")
            StepText(Self.words)
            if !inboxes.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(inboxes) { inbox in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: inbox.status == .needsAttention ? "exclamationmark.circle" : "checkmark")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(inbox.status == .needsAttention ? UsualColor.danger : Theme.ink)
                            StepText(Onboarding.inboxWords(inbox), color: Theme.ink)
                        }
                        .transition(.blurReveal)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                // A new step for each inbox connected, so the button comes back for the next one.
                GoogleSignInStep(
                    title: inboxes.isEmpty ? "Sign in with Google" : "Add another Gmail", prominent: inboxes.isEmpty,
                    holdsNotes: $holdsNotes
                )
                .id(inboxes.count)
                if !holdsNotes {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(inboxes.isEmpty ? Self.headsUp : [Self.testUser], id: \.self) { note in
                            StepText(note, size: 10, color: Theme.time)
                        }
                    }
                }
            }
            OnboardingFooter(session: session) {
                PrimaryButton(title: "Continue", enabled: !inboxes.isEmpty, action: next)
            }
        }
        .animation(Motion.reveal, value: inboxes.map(\.id))
        .onboardingCard()
        .revealOnAppear()
    }
}

/// Signing in with Google: one button opens Google's page in the browser, where the person picks their account and
/// allows Usual Mail; their server receives Google's answer and keeps the access. Then it says how it ended. With an
/// `inboxId` it signs that Gmail inbox in again, in place. While the server has no Google client, the guided set-up
/// (`GoogleClientSetupView`) shows instead, and once the server has one, the button. Settings uses it too: keep its
/// parameters working.
struct GoogleSignInStep: View {
    var inboxId: String? = nil
    var title = "Sign in with Google"
    var alignment: HorizontalAlignment = .leading
    /// Opens Google's page as soon as the server says it can, for a step the person already asked for by a click.
    var startsAtOnce = false
    /// The dark button, for a screen that is there for it; otherwise a light one beside another step's button.
    var prominent = true
    /// Set while there is nothing to sign in with yet (asking the server, or the guided set-up), for a screen that
    /// holds back its own notes on signing in meanwhile.
    var holdsNotes: Binding<Bool>? = nil
    @Environment(MailStore.self) private var store
    @State private var flow: GoogleSignInFlow?
    @State private var running: Task<Void, Never>?

    var body: some View {
        VStack(alignment: alignment, spacing: 10) {
            switch flow?.step ?? .checking {
            case .checking:
                ProgressView().controlSize(.small)
            case .unavailable(let words):
                note(words)
                if let guide = Onboarding.googleSetupGuide {
                    WebLink(title: "Open the setup guide", destination: guide)
                }
            case .needsClient:
                GoogleClientSetupView { [flow, store] settled in
                    flow?.clientSettled(settled)
                    store.googleSignInChanged(settled.googleSignIn)
                }
                .transition(.blurReveal)
            case .ready:
                button(title)
            case .starting:
                label(title, busy: true)
            case .waiting:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    note("Finish in your browser: choose your account and allow Usual Mail.")
                }
                QuietButton("Stop waiting", action: stop)
            case .connected(_, let reconnected):
                note(
                    reconnected
                        ? "Signed in again. Your mail syncs as before." : "Connected. Your mail is on its way.")
            case .failed(let words):
                note(words, color: UsualColor.danger)
                button("Try again")
            }
            // Once this device gave the server its client: that it has it, and the server's hint on the file.
            if flow?.step != .needsClient, let notes = flow?.notes, !notes.isEmpty {
                VStack(alignment: alignment, spacing: 4) {
                    ForEach(notes, id: \.self) { words in
                        StepText(words, size: 10, color: Theme.time)
                    }
                }
                .transition(.blurReveal)
            }
        }
        .animation(Motion.reveal, value: flow?.step)
        .animation(Motion.reveal, value: flow?.notes)
        .onChange(of: Self.holdsNotes(flow?.step), initial: true) { _, holds in
            holdsNotes?.wrappedValue = holds
        }
        // A client given elsewhere meanwhile (the command, another device) turns the step into the button.
        .onAppBecomesActive { Task { await flow?.recheck() } }
        .task {
            guard flow == nil else { return }
            let flow = GoogleSignInFlow(
                client: store.apiClient, reconnecting: inboxId, open: { Links.open($0) },
                connected: { [store] in await store.refresh() })
            self.flow = flow
            await flow.check()
            if startsAtOnce, flow.step == .ready { begin() }
        }
        // Put away (a Settings row scrolled off), it stops asking; back while it still waits, it asks again about the
        // same sign-in, so a sign-in finished meanwhile shows as finished.
        .onAppear {
            guard running == nil, flow?.step == .waiting else { return }
            running = Task { await flow?.resume() }
        }
        .onDisappear {
            running?.cancel()
            running = nil
        }
    }

    /// Whether a screen's notes on signing in wait: while the server is asked, and while its client is set up.
    static func holdsNotes(_ step: GoogleSignInFlow.Step?) -> Bool {
        switch step ?? .checking {
        case .checking, .needsClient: true
        default: false
        }
    }

    private func button(_ title: String) -> some View {
        Button(action: begin) {
            label(title)
        }
        .buttonStyle(PlainControlStyle())
        .transition(.blurReveal)
    }

    @ViewBuilder
    private func label(_ title: String, busy: Bool = false) -> some View {
        if prominent {
            DarkButtonLabel(title: title, busy: busy)
        } else {
            LightButtonLabel(title: title, busy: busy)
        }
    }

    private func begin() {
        running?.cancel()
        running = Task { await flow?.start() }
    }

    private func stop() {
        running?.cancel()
        flow?.reset()
    }

    private func note(_ words: String, color: Color = Theme.secondary) -> some View {
        Text(verbatim: words)
            .font(Theme.sans(12))
            .foregroundStyle(color)
            .multilineTextAlignment(alignment == .center ? .center : .leading)
            .fixedSize(horizontal: false, vertical: true)
            .transition(.blurReveal)
    }
}
