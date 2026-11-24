import SwiftUI
import UsualMailKit

/// The Feed tab (owner's request of 2026-11-18: "each mail content to be shown as a post in the feed like instagram
/// and be scrollable"): every newsletter in the chosen profile, newest first, one post after another, each showing the
/// mail itself, so the feed is read without opening anything. A post's messages are fetched only as it comes near the
/// screen (`FeedPosts`), and showing a post never marks it read. Clicking its header or subject opens the mail page,
/// which does.
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
            LazyVStack(alignment: .leading, spacing: 32) {
                ForEach(Array(list.threads.enumerated()), id: \.element.id) { index, thread in
                    FeedPost(
                        thread: thread, inbox: store.lists.inbox(id: thread.inboxId), state: posts.state(of: thread),
                        separated: index > 0
                    ) { open(thread.id) }
                    // Only looks: never `store.open`, which marks the mail read and is the one mail open.
                    .task(id: FeedPosts.Version(thread)) {
                        await posts.load(thread) { await store.detail(threadID: $0) }
                    }
                    // The first screenful comes into focus one after another; a post scrolled to, at once.
                    .revealOnAppear(delay: index < 4 ? Motion.delay(at: index) : 0)
                    .transition(.blurReveal)
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
                        .padding(.top, 8)
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
}

/// One newsletter as a post: a header like an Instagram post's (the sender's avatar and name, how long ago), the
/// subject, the summary as a caption, then the mail as its sender wrote it, in full. The header and subject open the
/// mail page, carry the row's right-click menu, and drag onto the rail as a row does.
struct FeedPost: View {
    let thread: MailThread
    let inbox: Inbox?
    let state: FeedPosts.State
    /// Not the first post: a hairline above it.
    let separated: Bool
    let open: () -> Void
    @Environment(MailStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if separated {
                Rectangle()
                    .fill(Theme.hairline)
                    .frame(height: 1)
                    .padding(.bottom, 32)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 12) {
                heading
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
        }
    }

    /// The header row and the subject, one button that opens the mail.
    private var heading: some View {
        let sender = HomeWords.shownSender(of: thread, inbox: inbox)
        let name = FeedWords.sender(of: thread, inbox: inbox)
        return Button(action: open) {
            VStack(alignment: .leading, spacing: 8) {
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
                Text(verbatim: thread.subject.isEmpty ? "(no subject)" : thread.subject)
                    .font(Theme.sans(13, weight: .medium))
                    .foregroundStyle(Theme.ink)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
