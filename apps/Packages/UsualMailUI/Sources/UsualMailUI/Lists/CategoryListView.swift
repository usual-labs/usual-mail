import SwiftUI
import UsualMailKit

/// A tab of categories as a list (Receipts: invoices and receipts, owner's request of 2026-11-18; Feed shows its
/// newsletters as posts instead, `FeedView`, and Notifications its notifications in sections, `NotificationsView`): its
/// mail as one list, newest first, with Home's row and Home's look; Receipts' rows say how much, to or from whom and
/// what for (`PaymentWords`). The Figma frames for these tabs ("MacBook Pro 14" - 2 and - 4) show only the tab chosen
/// over Home's card, so Home's layout stands. Clicking a row opens the mail page. On the iPhone a row swiped either way
/// does what Settings says for the tab (`SwipeList(tab)`; Receipts: by default left marks it seen, right archives it).
struct CategoryListView: View {
    let tab: Tab
    /// The inbox the profile switch picked, or nil for every inbox.
    let inboxId: String?
    let open: (String) -> Void
    @Environment(MailStore.self) private var store

    var body: some View {
        // At the store's now: a snoozed thread comes back when the store re-reads the copy at its time.
        let list = CategoryList(store.lists, tab: tab, inbox: inboxId, now: store.now)
        ScrollView {
            // Lazy, so a tab with hundreds of threads builds only the rows near the screen (as Home's).
            LazyVStack(alignment: .leading, spacing: 24) {
                ForEach(Array(list.threads.enumerated()), id: \.element.rowID) { index, thread in
                    HomeItem(
                        thread: thread, inbox: store.lists.inbox(id: thread.inboxId),
                        words: CategoryList.words(for: thread, on: tab)
                    ) { open(thread.id) }
                    // On the iPhone, a swipe either way does what Settings says for the tab (`SwipeList(tab)`).
                    .swipes(SwipeList(tab), [thread])
                    .revealOnAppear(delay: Motion.delay(at: index))
                    .transition(.blurReveal)
                }
                if list.threads.isEmpty && store.hasLoadedFromDisk {
                    Text(verbatim: CategoryList.emptyWords(for: tab))
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.sectionTitle)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                        .revealOnAppear()
                        .id(ListRowID.words("empty"))
                }
                if let note = AIWords.note(status: store.aiStatus, threads: list.threads) {
                    Text(verbatim: note)
                        .font(Theme.sans(10))
                        .foregroundStyle(Theme.time)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                        .revealOnAppear(delay: Motion.longestWait)
                        .id(ListRowID.words("note"))
                }
            }
            .scrollTargetLayout()
            .padding(Theme.page)
            .animation(Motion.move, value: list.threads.map(\.id))
        }
        .scrollIndicators(.never)
        .revealsFirstScreen(hasRows: !list.threads.isEmpty)
        // Back at the row that was at the top, coming back to the mail stack or from a mail (`ScrollPlaces`).
        .keepsTopRow(list.threads.map(\.rowID))
    }
}
