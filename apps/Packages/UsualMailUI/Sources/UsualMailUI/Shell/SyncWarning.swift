import SwiftUI
import UsualMailDesign
import UsualMailKit

/// An inbox that stopped syncing, as the apps warn of it (the owner's words of 2026-11-25: "lets show a warning to user
/// if an account stopped syncing, in the menu show a warning icon next to that inbox"): one whose status is
/// `needs_attention`, the server's word for a sync that failed. Paused is the person's own choice and connecting is on
/// its way, so neither warns. A warning triangle marks it in the Mac's switch and the iPhone's menu, and a notice at
/// the top of the card says so on every list that shows its mail (`SyncNotice`).
enum SyncWarning {
    /// The warning's SF Symbol.
    static let symbol = "exclamationmark.triangle.fill"
    /// What the triangle says to VoiceOver, and the iPhone's menu under the inbox's name.
    static let words = "Stopped syncing"

    static func stopped(_ inbox: Inbox) -> Bool {
        inbox.status == .needsAttention
    }

    /// The inboxes stopped syncing whose mail the card shows at `nav`: on the mail stack, its profile's inbox or every
    /// inbox; on To reply, Pinned, Snoozed and the Inbox page, every inbox. None on Settings, whose Accounts tab says
    /// it already, on search, or with a mail open.
    static func shown(nav: Navigation, inboxes: [Inbox]) -> [Inbox] {
        guard nav.reading == nil else { return [] }
        switch nav.place {
        case .settings, .search: return []
        default: break
        }
        let stopped = inboxes.filter(stopped)
        guard let profile = nav.activeProfile else { return stopped }
        return stopped.filter { $0.id == profile }
    }
}

/// The notice at the top of the card while it shows mail of an inbox that stopped syncing (`SyncWarning.shown`): which
/// stopped, why in the server's words, and the one thing that fixes it.
struct SyncNotice: Equatable {
    let title: String
    let detail: String
    let action: Action

    /// What the notice's button does.
    enum Action: Equatable {
        /// Settings' Accounts tab, signing this Gmail inbox in with Google again at once, as its "Sign in with Google
        /// again…" does.
        case signIn(inboxId: String)
        /// The inbox's page in the server's dashboard (`MailStore.dashboardURL(inboxId:)`), in the browser: the apps
        /// take no new IMAP details, and that page does ("Reconnect").
        case dashboard(inboxId: String)
        /// Asks the server to sync it now (`POST /v1/inboxes/:id/sync`): for a provider that kept failing, or a sync
        /// that stopped. The notice stays until a sync finishes well.
        case tryAgain(inboxId: String)
        /// Settings' Accounts tab, where each inbox says how it stands.
        case openAccounts

        var title: String {
            switch self {
            case .signIn: "Sign in again"
            case .dashboard: "Reconnect on the dashboard"
            case .tryAgain: "Try again"
            case .openAccounts: "Open Accounts"
            }
        }

        /// The step for one inbox, by why it needs attention (`Inbox.statusReason`, 0.1.2): signing in again for a
        /// refused sign-in (Gmail here, IMAP on the dashboard, since the apps take no new IMAP details); Accounts, and
        /// no sign-in, for the host's own setup; trying again for a provider that kept failing or a sync that stopped.
        /// No reason, from an older server, or one this app doesn't know: as for a refused sign-in.
        static func step(for inbox: Inbox) -> Action {
            switch inbox.statusReason {
            case .hostSetup?: .openAccounts
            case .providerError?, .notSyncing?: .tryAgain(inboxId: inbox.id)
            case .needsSignIn?, .unknown?, nil:
                // Any Gmail inbox signs in with Google again, one connected by hand too (Settings' Accounts tab).
                inbox.provider == .gmail ? .signIn(inboxId: inbox.id) : .dashboard(inboxId: inbox.id)
            }
        }
    }

    /// The notice for `stopped`, nil when it is empty. One inbox: its name, the server's words on why, and the step
    /// its reason calls for (`Action.step`); several: their names or count, and Accounts.
    static func notice(for stopped: [Inbox]) -> SyncNotice? {
        guard let first = stopped.first else { return nil }
        guard stopped.count == 1 else {
            let title =
                stopped.count == 2
                ? "\(stopped[0].name) and \(stopped[1].name) stopped syncing."
                : "\(stopped.count) inboxes stopped syncing."
            return SyncNotice(
                title: title, detail: "New mail from them won't arrive here until they're reconnected.",
                action: .openAccounts)
        }
        let detail = first.statusDetail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return SyncNotice(
            title: "\(first.name) stopped syncing.",
            detail: detail.isEmpty ? "New mail from it won't arrive here until it's reconnected." : detail,
            action: .step(for: first))
    }
}

/// The warning triangle, in the danger colour, at `size` points.
struct SyncWarningMark: View {
    var size: CGFloat = 12

    var body: some View {
        Image(systemName: SyncWarning.symbol)
            .font(.system(size: size, weight: .semibold))
            .symbolRenderingMode(.palette)
            .foregroundStyle(.white, UsualColor.danger)
            .accessibilityLabel(SyncWarning.words)
    }
}

/// The notice on the card (`SyncNotice`): the triangle, what stopped and why, and its button (the dark one), on the
/// danger colour's tint, as wide as the page's content. The why stops at `detailLines`, so a long reason (Google's
/// runs to six lines on the iPhone) doesn't push the list down; Settings' Accounts tab and VoiceOver have it whole.
struct SyncNoticeView: View {
    let notice: SyncNotice
    /// The button's step; the button shows it working until it returns ("Try again" waits for the server's answer).
    let act: (SyncNotice.Action) async -> Void
    @State private var working = false

    static let detailLines = 3

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            SyncWarningMark(size: 13)
                .padding(.top, 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: notice.title)
                        .font(Theme.sans(12, weight: .medium))
                        .foregroundStyle(Theme.ink)
                    Text(verbatim: notice.detail)
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.body)
                        .lineLimit(Self.detailLines)
                        .truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: "\(notice.title) \(notice.detail)"))
                // The app's one filled button: fixing it is the step the notice is there for.
                Button {
                    Task {
                        working = true
                        await act(notice.action)
                        working = false
                    }
                } label: {
                    DarkButtonLabel(title: notice.action.title, busy: working, enabled: !working)
                }
                .buttonStyle(PlainControlStyle())
                .disabled(working)
                .pointer()
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(UsualColor.dangerTint, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}
