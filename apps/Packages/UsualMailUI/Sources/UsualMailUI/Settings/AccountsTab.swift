import SwiftUI
import UsualMailDesign
import UsualMailKit

/// Settings' Accounts tab: the inboxes (each with its icon, `InboxIconPicker`, and for Gmail signing in with Google
/// again), "Add a Gmail account…" (the rail's plus's sheet, `AddGmailSheet`), then the server this Mac is paired with,
/// its password (`ServerPassword`) and, at the foot, disconnecting from it. Opened from the notice on an inbox that
/// stopped syncing (`SyncNotice`), it signs that Gmail inbox in with Google again at once.
struct AccountsTab: View {
    let session: AppSession
    @Environment(MailStore.self) private var store
    @Environment(\.windowSize) private var window
    @State private var confirming = false
    @State private var addingGmail = false
    /// The Gmail inbox being signed in with Google again.
    @State private var signingIn: String?

    /// `signingIn`: the Gmail inbox to sign in with Google again as the tab opens (`Navigation.accountsSignIn`).
    init(session: AppSession, signingIn: String? = nil) {
        self.session = session
        _signingIn = State(initialValue: signingIn)
    }

    var body: some View {
        SettingsView.page {
            SettingsView.group("Inboxes") {
                ForEach(store.lists.inboxes) { inbox in
                    InboxRow(inbox: inbox, signingIn: $signingIn)
                }
                if store.lists.inboxes.isEmpty {
                    SettingsView.words("No inboxes yet.")
                }
                SettingsView.link("\(AddGmailSheet.title)…") { addingGmail = true }
            }
            SettingsView.group("Server") {
                SettingsView.words(session.credentials?.server.displayName ?? "Not paired")
                ServerPassword()
            }
            Button("Disconnect from this server…") { confirming = true }
                .pointer()
                .font(Theme.sans(12))
                .disabled(session.credentials == nil || session.isDisconnecting)
        }
        .animation(Motion.move, value: signingIn)
        .sheet(isPresented: $addingGmail) {
            AddGmailSheet { addingGmail = false }
                .environment(store)
                .environment(\.windowSize, window)
        }
        .confirmationDialog("Disconnect from this server?", isPresented: $confirming) {
            Button("Disconnect", role: .destructive) { Task { await session.disconnect() } }
        } message: {
            Text(
                "Your server forgets this Mac, and this Mac forgets its sign-in and the mail it keeps. To use it again, pair it with a new code."
            )
        }
    }
}

/// One inbox in Settings: its icon, which changes it (`InboxIconPicker`), name and address, how it stands, why a new
/// icon wasn't kept, and for a Gmail inbox, signing in with Google again (each week while the server's Google client
/// is in Testing, and whenever it needs attention).
private struct InboxRow: View {
    let inbox: Inbox
    @Binding var signingIn: String?
    @State private var icon = InboxIconChoice()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                // The button is 24 wide for its hover circle; the icon keeps its place.
                InboxIconPicker(inbox: inbox, choice: icon)
                    .padding(-4)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: inbox.name)
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.ink)
                    if inbox.address != inbox.name {
                        Text(verbatim: inbox.address)
                            .font(Theme.sans(10))
                            .foregroundStyle(Theme.secondary)
                    }
                }
                Spacer(minLength: 12)
                Text(InboxWords.status(inbox))
                    .font(Theme.sans(10))
                    .foregroundStyle(inbox.status == .needsAttention ? UsualColor.danger : Theme.time)
            }
            if inbox.status == .needsAttention, let detail = inbox.statusDetail, !detail.isEmpty {
                SettingsView.refusal(detail)
            }
            if let refusal = icon.refusal {
                SettingsView.refusal(refusal)
                    .transition(.blurReveal)
            }
            // Any Gmail inbox: one connected by hand moves to the server's Google client when signed in again.
            if inbox.provider == .gmail {
                if signingIn == inbox.id {
                    GoogleSignInStep(inboxId: inbox.id, title: "Sign in with Google again", startsAtOnce: true)
                } else {
                    SettingsView.link("Sign in with Google again…", size: 10) { signingIn = inbox.id }
                }
            }
        }
        .padding(.vertical, 4)
        .animation(Motion.reveal, value: icon.refusal)
    }
}

/// How an inbox stands, in a word or two; while its first sync runs, how far it has got, in core's words.
enum InboxWords {
    static func status(_ inbox: Inbox) -> String {
        if let progress = inbox.fetching { return progress.words }
        return switch inbox.status {
        case .connecting: "Connecting…"
        case .ok: "Up to date"
        case .needsAttention: "Needs you"
        case .paused: "Paused"
        case .unknown(let raw): raw
        }
    }
}
