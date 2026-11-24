import SwiftUI
import UsualMailKit

/// Older mail in Gmail, after the local results (docs/contract-search.md, "Older mail in the mailbox"): first a button,
/// "Search older mail in Gmail", never searched as the person types; then what each inbox answered (paused; needs to
/// sign in again, with the shared Sign in with Google step; Gmail's own words with Try again; an inbox that can't be
/// searched says nothing and isn't offered again), the older mail found, and more on a button. While the server asks to
/// wait (too many searches of the mailbox), how long. A click on an older mail brings it in and opens it.
struct RemoteSearchSection: View {
    let model: SearchModel
    let dates: MailDate
    let selected: SearchRow?
    /// Opens the thread an older mail became.
    let open: (String) -> Void
    @Environment(MailStore.self) private var store
    @Environment(\.windowSize) private var window
    @State private var signingIn: SignInAgain?

    var body: some View {
        let remote = model.remote
        VStack(alignment: .leading, spacing: 8) {
            if remote.status != .offered {
                Text("Older mail in Gmail")
                    .font(Theme.sans(12, weight: .semibold))
                    .foregroundStyle(Theme.sectionTitle)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 8)
            }
            switch remote.status {
            case .offered:
                offer
            case .searching:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    quiet("Searching Gmail…")
                }
            case .answered:
                answers(remote)
            case .failed(let words):
                quiet(words)
                QuietButton("Try again") { model.searchRemote() }
            }
        }
        .padding(.top, 8)
        .animation(Motion.reveal, value: remote)
        .sheet(item: $signingIn, onDismiss: { model.searchRemote() }) { signIn in
            SignInAgainSheet(inboxId: signIn.id) { signingIn = nil }
                .environment(store)
                .environment(\.windowSize, window)
        }
    }

    /// The button, or while the server asks to wait, how long.
    @ViewBuilder private var offer: some View {
        if let until = model.remoteWaitsUntil {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                quiet(SearchWords.remoteWait(seconds: max(1, Int(until.timeIntervalSince(context.date).rounded(.up)))))
            }
        } else {
            Button {
                model.searchRemote()
            } label: {
                HStack(spacing: 8) {
                    Icon.search.view(size: 13, tint: Theme.secondary)
                    Text(SearchWords.remoteButton)
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.ink)
                    Spacer(minLength: 0)
                }
                .frame(height: Avatar.side)
                .searchRow(selected: false)
            }
            .buttonStyle(PlainControlStyle())
        }
    }

    @ViewBuilder private func answers(_ remote: RemoteSection) -> some View {
        let lines = remote.inboxes.compactMap { state in
            SearchWords.remote(state, inbox: model.inboxes.first { $0.id == state.inboxId }).map { (state, $0) }
        }
        ForEach(lines, id: \.0.inboxId) { state, line in
            VStack(alignment: .leading, spacing: 2) {
                quiet(line.words)
                switch line.offer {
                case .signIn: QuietButton("Sign in with Google") { signingIn = SignInAgain(id: state.inboxId) }
                case .retry: QuietButton("Try again") { model.searchRemote() }
                case .nothing: EmptyView()
                }
            }
        }
        if remote.hits.isEmpty && lines.isEmpty {
            quiet(SearchWords.nothingOlder)
        }
        ForEach(remote.hits) { hit in
            RemoteHitRow(
                hit: hit, dates: dates, selected: selected == .remote(hit.id), opening: remote.opening == hit.id,
                problem: remote.problems[hit.id]
            ) {
                Task { if let id = await model.open(hit) { open(id) } }
            }
            .id(SearchRow.remote(hit.id))
        }
        if remote.nextCursor != nil {
            if remote.isLoadingMore {
                ProgressView().controlSize(.small)
            } else if !model.remoteWaits(at: Date()) {
                QuietButton("More older mail") { model.loadMoreRemote() }
            }
        }
        if let until = model.remoteWaitsUntil {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                quiet(SearchWords.remoteWait(seconds: max(1, Int(until.timeIntervalSince(context.date).rounded(.up)))))
            }
        }
    }

    private func quiet(_ words: String) -> some View {
        Text(verbatim: words)
            .font(Theme.sans(10))
            .foregroundStyle(Theme.time)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The inbox whose mailbox refused the sign-in, for the sheet.
struct SignInAgain: Identifiable {
    let id: String
}

/// Signing an inbox in with Google again, from older mail's answer: the shared step (`GoogleSignInStep`, as the rail's
/// plus and Settings use it), which opens Google's page at once, in a sheet so it keeps following the sign-in while
/// the browser is in front (`AddGmailButton`). Done closes it, and older mail is asked for again.
struct SignInAgainSheet: View {
    let inboxId: String
    let done: () -> Void
    /// The window the sheet is on, so it never grows taller than it (the presenter passes it on).
    @Environment(\.windowSize) private var window

    static let title = "Sign in with Google again"

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            StepTitle(Self.title)
            GoogleSignInStep(inboxId: inboxId, title: Self.title, startsAtOnce: true)
            HStack {
                Spacer(minLength: 0)
                Button(action: done) {
                    LightButtonLabel(title: "Done")
                }
                .buttonStyle(PlainControlStyle())
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        #if os(macOS)
            .frame(width: 380, alignment: .leading)
        #else
            .frame(maxWidth: .infinity, alignment: .leading)
        #endif
        .frame(maxHeight: AddGmailSheet.maxHeight(window: window))
    }
}
