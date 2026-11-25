import SwiftUI
import UsualMailKit

/// The Feed tab (owner's request of 2026-11-18: "each mail content to be shown as a post in the feed like instagram
/// and be scrollable"): every newsletter in the chosen profile, newest first, one post after another, each showing the
/// mail itself, so the feed is read without opening anything. A post's messages are fetched only as it comes near the
/// screen (`FeedPosts`), and showing a post never marks it read. Clicking its header or subject opens the mail page,
/// which does. On the iPhone each post's header (who and when) sticks to the top while its post scrolls under it, until
/// the next post's header pushes it away (the owner's words of 2026-11-25: "each items header should stick to the top
/// and then scroll when next items comes").
struct FeedView: View {
    /// The inbox the profile switch picked, or nil for every inbox.
    let inboxId: String?
    /// Kept by the window, so coming back from the mail page fetches nothing again.
    let posts: FeedPosts
    let open: (String) -> Void
    @Environment(MailStore.self) private var store
    /// Where the feed was, kept by the window (`ScrollPlaces`).
    @Environment(\.keptScroll) private var kept

    var body: some View {
        // At the store's now: a snoozed newsletter comes back when the store re-reads the copy at its time.
        let list = CategoryList(store.lists, tab: .reads, inbox: inboxId, now: store.now)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: Self.pinned) {
                ForEach(Array(list.threads.enumerated()), id: \.element.id) { index, thread in
                    let inbox = store.lists.inbox(id: thread.inboxId)
                    // The first screenful comes into focus one after another; a post scrolled to, at once.
                    let delay = index < 4 ? Motion.delay(at: index) : 0
                    Section {
                        FeedPost(
                            thread: thread, inbox: inbox, state: posts.state(of: thread),
                            last: index == list.threads.count - 1
                        ) { open(thread.id) }
                        // Only looks: never `store.open`, which marks the mail read and is the one mail open.
                        .task(id: FeedPosts.Version(thread)) {
                            await posts.load(thread) { await store.detail(threadID: $0) }
                        }
                        .revealOnAppear(delay: delay)
                        .transition(.blurReveal)
                    } header: {
                        FeedPostHeader(thread: thread, inbox: inbox) { open(thread.id) }
                            // The post the feed keeps its place by (`scrollPosition`).
                            .id(thread.id)
                            .revealOnAppear(delay: delay)
                            .transition(.blurReveal)
                    }
                }
                if list.threads.isEmpty && store.hasLoadedFromDisk {
                    Text(verbatim: CategoryList.emptyWords(for: .reads))
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.sectionTitle)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                        .revealOnAppear()
                }
                if let note = AIWords.note(status: store.aiStatus, threads: list.threads) {
                    Text(verbatim: note)
                        .font(Theme.sans(10))
                        .foregroundStyle(Theme.time)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                        .revealOnAppear(delay: Motion.longestWait)
                }
            }
            .scrollTargetLayout()
            .padding(Theme.page)
            .animation(Motion.move, value: list.threads.map(\.id))
        }
        .scrollIndicators(.never)
        // Back at the post that was at the top, coming back to the mail stack or from a mail: a post's height is known
        // only once its mail is laid out, so the post, not the distance.
        .scrollPosition(id: kept.map { $0.places.top($0.key) } ?? .constant(nil), anchor: .top)
    }

    /// The headers stick on the iPhone; on the Mac they scroll with their posts.
    #if os(iOS)
        static let pinned: PinnedScrollableViews = [.sectionHeaders]
    #else
        static let pinned: PinnedScrollableViews = []
    #endif
}

/// A post's header, like an Instagram post's: the sender's avatar and name, and how long ago, one button that opens the
/// mail, with the row's right-click menu, dragged onto the rail as a row is. On the iPhone, while it sticks to the top,
/// it stands on the card's own ground, reaching the card's edges, so the post scrolling under it doesn't show through;
/// in its place in the feed it has none, as that ground would show as a band.
struct FeedPostHeader: View {
    let thread: MailThread
    let inbox: Inbox?
    let open: () -> Void
    @Environment(MailStore.self) private var store
    /// Whether it is stuck to the top of the feed.
    @State private var stuck = false

    /// The room above and below its row.
    #if os(iOS)
        static let above: CGFloat = 10
        static let below: CGFloat = 10
    #else
        static let above: CGFloat = 0
        static let below: CGFloat = 8
    #endif

    var body: some View {
        let sender = HomeWords.shownSender(of: thread, inbox: inbox)
        let name = FeedWords.sender(of: thread, inbox: inbox)
        Button(action: open) {
            HStack(spacing: 6) {
                Avatar(name: name, key: sender.key, avatar: sender.avatar)
                Text(verbatim: name)
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                Spacer(minLength: 12)
                TimelineView(.everyMinute) { context in
                    Text(HomeWords.ago(thread.lastMessageAt, now: context.date))
                        .font(Theme.sans(10))
                        .foregroundStyle(Theme.time)
                }
            }
            .contentShape(Rectangle())
            .rowHover()
        }
        .buttonStyle(PlainControlStyle())
        .rowMenu(for: thread, open: open) { action in
            Task { await store.perform(action, on: [thread.id]) }
        }
        .mailDraggable([thread.id], name: name, subject: thread.subject)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint("Opens the mail")
        // Outside the hover's box, which hugs the row: on the iPhone room above and below for the ground it sticks
        // on; on the Mac the 8 the subject had under it before.
        .padding(.top, Self.above)
        .padding(.bottom, Self.below)
        #if os(iOS)
            .background { stuckGround }
            // Stuck once its top reaches the top of the feed's scroll view.
            .onGeometryChange(for: Bool.self) {
                $0.frame(in: .scrollView).minY <= 0.5
            } action: {
                stuck = $0
            }
            .animation(.easeOut(duration: 0.15), value: stuck)
        #endif
    }

    /// The card's ground behind it while it is stuck, reaching the card's edges, with a hairline under it.
    private var stuckGround: some View {
        Rectangle()
            .fill(Theme.card)
            .background(.ultraThinMaterial)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 1) }
            .padding(.horizontal, -Theme.pageInset)
            .opacity(stuck ? 1 : 0)
    }
}

/// One newsletter as a post, under its header (`FeedPostHeader`): the subject, the summary as a caption, then the mail
/// as its sender wrote it, in full, and a hairline before the next post. The subject opens the mail page, carries the
/// row's right-click menu, and drags onto the rail as a row does.
struct FeedPost: View {
    let thread: MailThread
    let inbox: Inbox?
    let state: FeedPosts.State
    /// The feed's last post: no hairline after it.
    let last: Bool
    let open: () -> Void
    @Environment(MailStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                subject
                if let caption = FeedWords.caption(for: thread) {
                    // A model's plain text: shown as text, never as markup.
                    Text(verbatim: caption)
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.secondary)
                        .lineLimit(2)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                content
            }
            if !last {
                Rectangle()
                    .fill(Theme.hairline)
                    .frame(height: 1)
                    .padding(.top, 32)
                    // 32 to the next post's header row, its own room above counted.
                    .padding(.bottom, 32 - FeedPostHeader.above)
                    .accessibilityHidden(true)
            }
        }
    }

    /// The subject, a button that opens the mail.
    private var subject: some View {
        Button(action: open) {
            Text(verbatim: thread.subject.isEmpty ? "(no subject)" : thread.subject)
                .font(Theme.sans(13, weight: .medium))
                .foregroundStyle(Theme.ink)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .rowHover()
        }
        .buttonStyle(PlainControlStyle())
        .rowMenu(for: thread, open: open) { action in
            Task { await store.perform(action, on: [thread.id]) }
        }
        .mailDraggable([thread.id], name: FeedWords.sender(of: thread, inbox: inbox), subject: thread.subject)
        .accessibilityHint("Opens the mail")
    }

    /// The mail itself, a small spinner until it arrives, or its opening words when it can't be had.
    @ViewBuilder private var content: some View {
        switch state {
        case .shown(let detail):
            if let message = FeedWords.shown(in: detail) {
                MessageBody(message: message, client: store.apiClient)
                    .revealOnAppear()
            }
        case .loading:
            // As tall as a web view before it has measured its page, so the post doesn't jump twice.
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, minHeight: 120)
        case .unavailable:
            let words = HomeWords.oneLine(thread.snippet)
            if !words.isEmpty {
                Text(verbatim: words)
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
