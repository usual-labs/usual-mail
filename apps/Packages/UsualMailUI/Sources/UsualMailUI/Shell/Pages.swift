import SwiftUI
import UsualMailKit

/// The card's content for where the window is (`Navigation.place`), on the Mac and the iPhone alike: the page of the
/// stack showing, search over it, or the mail open in either. Outside the mail stack no profile is active
/// (`Navigation.activeProfile`): To reply, Pinned, Snoozed, the Inbox page and search over them take every inbox.
/// Over a list that shows mail of an inbox that stopped syncing, the notice that says so (`SyncNotice`), which stays
/// put while the list scrolls.
struct Pages: View {
    let session: AppSession
    let nav: Navigation
    /// The Feed's posts' messages, kept by the window.
    let feed: FeedPosts
    /// The notification groups shown expanded, kept by the window.
    @Binding var expandedGroups: ExpandedGroups
    /// The list on show's kept place, for its scroll view (`keepsScroll`).
    let kept: KeptScroll
    /// The search page's query and answers, kept by the window.
    let search: SearchModel
    /// Rises each time the search field should take the focus again.
    let searchFocus: Int
    /// Reads a thread in the card.
    let read: (String) -> Void
    /// Search's second Esc, once its field is clear: the stack as it was.
    let leaveSearch: () -> Void
    /// Search's offer when asking needs the AI set up.
    let openAISettings: () -> Void
    /// The sync notice's button (`SyncNotice.Action`).
    let fixSync: @MainActor (SyncNotice.Action) -> Void
    /// Settings' Accounts tab took the sign-in it was opened for (`Navigation.accountsSignInStarted`).
    let accountsSignInStarted: @MainActor () -> Void
    @Environment(MailStore.self) private var store

    var body: some View {
        let notice = SyncNotice.notice(for: SyncWarning.shown(nav: nav, inboxes: store.lists.inboxes))
        VStack(spacing: 0) {
            if let notice {
                SyncNoticeView(notice: notice, watched: watched(notice), dispatch: dispatch)
                    .id(notice.action)
                    .padding(.horizontal, Theme.page.leading)
                    .padding(.top, 16)
                    .transition(.blurReveal)
            }
            page
                .frame(maxHeight: .infinity, alignment: .top)
        }
        .animation(Motion.move, value: notice)
    }

    /// What the sync notice's button does: the dashboard in the browser, Try again a request, the rest move the
    /// window (`Navigation.fixSync`).
    private var dispatch: SyncNoticeDispatch {
        let store = store
        return SyncNoticeDispatch(
            openURL: { Links.open($0) }, dashboardURL: { store.dashboardURL(inboxId: $0) },
            syncInbox: { try await store.apiClient.syncInbox(id: $0) }, navigate: fixSync)
    }

    /// The inbox Try again asks to sync, as the store has it now; nil for the other steps.
    private func watched(_ notice: SyncNotice) -> SyncSnapshot? {
        guard case .tryAgain(let inboxId) = notice.action, let inbox = store.lists.inbox(id: inboxId) else {
            return nil
        }
        return SyncSnapshot(inbox)
    }

    @ViewBuilder private var page: some View {
        let inboxId = nav.activeProfile
        switch nav.place {
        case .tab(.home):
            if let reading = nav.reading {
                ReadingView(threadID: reading)
                    .transition(.handOver)
            } else {
                HomeView(inboxId: inboxId, open: read)
                    .environment(\.keptScroll, kept)
                    .checksForMail(inboxId)
                    .transition(.handOver)
            }
        case .screening:
            if let reading = nav.reading {
                ReadingView(threadID: reading)
                    .transition(.handOver)
            } else {
                ScreeningView(inboxId: inboxId) { action, threadID in
                    Task { await store.perform(action, on: [threadID]) }
                } open: { id in
                    read(id)
                }
                .environment(\.keptScroll, kept)
                .checksForMail(inboxId)
                .transition(.handOver)
            }
        case .tab(.reads):
            if let reading = nav.reading {
                ReadingView(threadID: reading)
                    .transition(.handOver)
            } else {
                FeedView(inboxId: inboxId, posts: feed, open: read)
                    .environment(\.keptScroll, kept)
                    .checksForMail(inboxId)
                    .transition(.handOver)
            }
        case .tab(.notifications):
            if let reading = nav.reading {
                ReadingView(threadID: reading)
                    .transition(.handOver)
            } else {
                NotificationsView(inboxId: inboxId, expanded: $expandedGroups, open: read)
                    .environment(\.keptScroll, kept)
                    .checksForMail(inboxId)
                    .transition(.handOver)
            }
        case .tab(let tab):
            // Receipts.
            if let reading = nav.reading {
                ReadingView(threadID: reading)
                    .transition(.handOver)
            } else {
                CategoryListView(tab: tab, inboxId: inboxId, open: read)
                    .environment(\.keptScroll, kept)
                    .checksForMail(inboxId)
                    .id(tab)
                    .transition(.handOver)
            }
        case .inbox:
            if let reading = nav.reading {
                ReadingView(threadID: reading)
                    .transition(.handOver)
            } else {
                InboxView(inboxId: inboxId, top: kept.places.top(kept.key), open: read)
                    .checksForMail(inboxId)
                    .transition(.handOver)
            }
        case .toReply, .pinned, .snoozed:
            if let reading = nav.reading {
                ReadingView(threadID: reading)
                    .transition(.handOver)
            } else {
                RailListView(place: nav.place, inboxId: inboxId, open: read)
                    .environment(\.keptScroll, kept)
                    .checksForMail(inboxId)
                    .id(nav.place)
                    .transition(.handOver)
            }
        case .settings:
            SettingsView(
                session: session, tab: nav.settingsTab, inboxId: inboxId, accountsSignIn: nav.accountsSignIn,
                accountsSignInStarted: accountsSignInStarted
            )
            .transition(.handOver)
        case .search:
            if let reading = nav.reading {
                ReadingView(threadID: reading)
                    .transition(.handOver)
            } else {
                SearchView(
                    model: search, inboxId: inboxId, focusRequest: searchFocus, open: read, leave: leaveSearch,
                    openAISettings: openAISettings
                )
                .transition(.handOver)
            }
        }
    }
}

extension View {
    /// On the iPhone, a list that checks for new mail when pulled down (`MailStore.checkForMail`): the inbox of the
    /// profile showing, or every inbox, synced from its mailbox and everything fetched again, the spinner showing
    /// until the server has answered. Nothing on the Mac, whose lists aren't pulled.
    @ViewBuilder func checksForMail(_ inboxId: String?) -> some View {
        #if os(iOS)
            modifier(ChecksForMail(inboxId: inboxId))
        #else
            self
        #endif
    }
}

#if os(iOS)
    private struct ChecksForMail: ViewModifier {
        let inboxId: String?
        @Environment(MailStore.self) private var store

        func body(content: Content) -> some View {
            content.refreshable { await store.checkForMail(inboxId: inboxId) }
        }
    }
#endif
