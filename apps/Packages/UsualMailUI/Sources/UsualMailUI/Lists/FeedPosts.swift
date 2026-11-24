import Foundation
import Observation
import UsualMailKit

/// The messages the Feed's posts show, fetched only as each post comes near the screen and kept by thread while the
/// window is open, so scrolling back, or coming back from the mail page, fetches nothing again. A thread is fetched
/// again only when it has a new message (its message count or its last message's time changed); a new summary, a
/// read mark or a move fetches nothing. Until the new message arrives, the post keeps showing what it had.
@MainActor
@Observable
final class FeedPosts {
    /// What a post shows under its caption.
    enum State: Equatable {
        /// Its messages are on the way.
        case loading
        /// The server couldn't be asked and the device holds none of its messages.
        case unavailable
        case shown(ThreadDetail)
    }

    /// What tells a thread's new message: its count and its last message's time.
    struct Version: Hashable {
        let messageCount: Int
        let lastMessageAt: Date

        init(_ thread: MailThread) {
            messageCount = thread.messageCount
            lastMessageAt = thread.lastMessageAt
        }
    }

    private struct Kept {
        let version: Version
        let detail: ThreadDetail
    }

    private var kept: [String: Kept] = [:]
    private var unavailable: Set<String> = []
    /// The threads being fetched, with the version asked for.
    @ObservationIgnored private var asking: [String: Version] = [:]

    func state(of thread: MailThread) -> State {
        if let detail = kept[thread.id]?.detail { return .shown(detail) }
        return unavailable.contains(thread.id) ? .unavailable : .loading
    }

    func detail(for thread: MailThread) -> ThreadDetail? {
        kept[thread.id]?.detail
    }

    /// Fetches the thread's messages unless they are kept for its current version or already on the way. A fetch
    /// whose post left before it finished (its task cancelled) keeps nothing, and neither does one that brought no
    /// message, so the post asks again the next time it appears.
    func load(_ thread: MailThread, fetch: @MainActor (String) async -> ThreadDetail?) async {
        let version = Version(thread)
        guard kept[thread.id]?.version != version, asking[thread.id] != version else { return }
        asking[thread.id] = version
        let detail = await fetch(thread.id)
        if asking[thread.id] == version { asking[thread.id] = nil }
        guard !Task.isCancelled else { return }
        if let detail, !detail.messages.isEmpty {
            kept[thread.id] = Kept(version: version, detail: detail)
            if unavailable.contains(thread.id) { unavailable.remove(thread.id) }
        } else if kept[thread.id] == nil, !unavailable.contains(thread.id) {
            unavailable.insert(thread.id)
        }
    }
}

/// A feed post's words.
enum FeedWords {
    /// The message a post shows, as the mail page shows it: the newest someone else wrote, or the newest of all in a
    /// thread of only the mailbox's own mail. Earlier messages aren't shown in the feed.
    static func shown(in detail: ThreadDetail?) -> Message? {
        detail.flatMap(MailPage.latestIncoming)
    }

    /// Who the post is from, as Home finds them (`HomeWords.shownSender`: the address its picture is for, else the
    /// first participant who isn't the inbox itself), by name or else by address; the thread's sender when it has no
    /// participants.
    static func sender(of thread: MailThread, inbox: Inbox?) -> String {
        HomeWords.shownSender(of: thread, inbox: inbox).name ?? thread.sender ?? "Unknown sender"
    }

    /// The caption: the server's summary as one run of plain text, or nil without one. A summary is a model's plain
    /// text and is only ever shown as text.
    static func caption(for thread: MailThread) -> String? {
        let summary = HomeWords.oneLine(thread.summary ?? "")
        return summary.isEmpty ? nil : summary
    }
}
