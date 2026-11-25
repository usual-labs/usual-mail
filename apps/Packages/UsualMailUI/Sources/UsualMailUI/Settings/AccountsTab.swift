import SwiftUI
import UsualMailDesign
import UsualMailKit

/// Settings' Accounts tab, in three sections: Inboxes, each with its icon (`InboxIconPicker`), name, address and how it
/// stands, and for Gmail signing in with Google again, then "Add a Gmail account…" (`AddGmailSheet`; on the iPhone the
/// one way to add one, as its switcher's menu has none); Server, its address and its password (`ServerPassword`); and
/// disconnecting from it, in red, alone at the foot. Opened from the notice on an inbox that
/// stopped syncing (`SyncNotice`), it scrolls to that Gmail inbox and signs it in with Google again at once.
struct AccountsTab: View {
    let session: AppSession
    @Environment(MailStore.self) private var store
    @Environment(\.windowSize) private var window
    @State private var confirming = false
    @State private var addingGmail = false
    /// The Gmail inbox being signed in with Google again.
    @State private var signingIn: String?

    /// Told once the tab took the sign-in it opened for, so the window drops its request.
    private let started: @MainActor () -> Void

    /// `signingIn`: the Gmail inbox to sign in with Google again as the tab opens (`Navigation.accountsSignIn`);
    /// `started`, once it is in the tab's own state (`Navigation.accountsSignInStarted`).
    init(session: AppSession, signingIn: String? = nil, started: @escaping @MainActor () -> Void = {}) {
        self.session = session
        self.started = started
        _signingIn = State(initialValue: signingIn)
    }

    var body: some View {
        // Within Settings' scroll view: opened to sign an inbox in, it scrolls to that row first, so its steps
        // ("Finish in your browser", "Stop waiting") show among many inboxes.
        ScrollViewReader { scroller in
            page
                .task {
                    guard let inbox = signingIn else { return }
                    // The tab holds it now: a rebuilt tab won't be handed it again.
                    started()
                    // Once the rows are laid out.
                    await Task.yield()
                    scroller.scrollTo(inbox, anchor: .top)
                }
        }
    }

    private var page: some View {
        SettingsView.page {
            SettingsView.group("Inboxes") {
                ForEach(store.lists.inboxes) { inbox in
                    InboxRow(inbox: inbox, signingIn: $signingIn)
                        .id(inbox.id)
                }
                if store.lists.inboxes.isEmpty {
                    SettingsView.words("No inboxes yet.")
                }
                SettingsView.action("\(AddGmailSheet.title)…", icon: "plus") { addingGmail = true }
            }
            SettingsView.group("Server") {
                SettingsView.row("Address", value: session.credentials?.server.displayName ?? "Not paired")
                ServerPassword()
            }
            SettingsView.group(nil, footer: [SettingsWords.disconnecting]) {
                SettingsView.action("Disconnect from this server…", destructive: true) { confirming = true }
                    .disabled(session.credentials == nil || session.isDisconnecting)
            }
        }
        .animation(Motion.move, value: signingIn)
        .sheet(isPresented: $addingGmail) {
            AddGmailSheet { addingGmail = false }
                .environment(store)
                .environment(\.windowSize, window)
                // On the iPhone half the screen first, as the switcher's sheet was.
                .presentationDetents([.medium, .large])
        }
        .confirmationDialog("Disconnect from this server?", isPresented: $confirming) {
            Button("Disconnect", role: .destructive) { Task { await session.disconnect() } }
        } message: {
            Text(verbatim: SettingsWords.disconnecting)
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
            HStack(spacing: 10) {
                // The button is 24 wide for its hover circle; the icon keeps its place.
                InboxIconPicker(inbox: inbox, choice: icon)
                    .padding(-4)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: inbox.name)
                        .font(Theme.sans(SettingsType.body))
                        .foregroundStyle(Theme.ink)
                    if inbox.address != inbox.name {
                        Text(verbatim: inbox.address)
                            .font(Theme.sans(SettingsType.note))
                            .foregroundStyle(Theme.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 12)
                Text(InboxWords.status(inbox))
                    .font(Theme.sans(SettingsType.note))
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
                    SettingsView.link("Sign in with Google again…", size: SettingsType.note) { signingIn = inbox.id }
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

/// Settings' words that name the device they show on: "this Mac" or "this iPhone".
enum SettingsWords {
    #if os(iOS)
        static let device = "this iPhone"
    #else
        static let device = "this Mac"
    #endif

    /// What disconnecting does, under its button and in its question.
    static let disconnecting =
        "Your server forgets \(device), and \(device) forgets its sign-in and the mail it keeps. To use it again, pair "
        + "it with a new code."
}
