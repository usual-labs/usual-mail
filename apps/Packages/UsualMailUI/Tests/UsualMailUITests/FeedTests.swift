import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The Feed tab's posts: which message a post shows, the words of its header and caption, and the messages fetched
/// once per thread as posts come near the screen, again only when the thread gets a new message.
@MainActor
struct FeedTests {
    let sample = SampleData.bundled

    /// Counts the fetches a `FeedPosts` asks for, and can hold them back until released.
    @MainActor
    final class Fetcher {
        var asked: [String] = []
        var answers: [String: ThreadDetail] = [:]
        private var held: [CheckedContinuation<Void, Never>] = []
        var holds = false

        func fetch(_ id: String) async -> ThreadDetail? {
            asked.append(id)
            if holds { await withCheckedContinuation { held.append($0) } }
            return answers[id]
        }

        func release() {
            holds = false
            held.forEach { $0.resume() }
            held.removeAll()
        }
    }

    private func detail(_ id: String) throws -> ThreadDetail {
        try #require(sample.detail(threadId: id))
    }

    private func message(_ id: String, outgoing: Bool, minutes: Double) -> Message {
        Message(
            id: id, threadId: "thr_x", inboxId: "inb_northwind",
            from: Address(name: outgoing ? "Northwind Studio" : "The Weekly Build", email: "\(id)@mail.example"),
            date: Date(timeIntervalSince1970: 1_800_000_000 + minutes * 60), subject: "Issue", text: id,
            outgoing: outgoing)
    }

    // MARK: Which message a post shows

    @Test func aPostShowsTheNewestMessageSomeoneElseWrote() throws {
        let thread = MailThread(id: "thr_x", inboxId: "inb_northwind", subject: "Issue", lastMessageAt: .now)
        let mixed = ThreadDetail(
            thread: thread,
            messages: [
                message("in_1", outgoing: false, minutes: 0), message("in_2", outgoing: false, minutes: 1),
                message("out_1", outgoing: true, minutes: 2),
            ], drafts: [])
        #expect(FeedWords.shown(in: mixed)?.id == "in_2")
        // Only the mailbox's own mail: the newest of it.
        let own = ThreadDetail(
            thread: thread,
            messages: [message("out_1", outgoing: true, minutes: 0), message("out_2", outgoing: true, minutes: 1)],
            drafts: [])
        #expect(FeedWords.shown(in: own)?.id == "out_2")
        #expect(FeedWords.shown(in: ThreadDetail(thread: thread, messages: [], drafts: [])) == nil)
        #expect(FeedWords.shown(in: nil) == nil)
        // The sample's newsletter: its one issue, as HTML.
        let newsletter = FeedWords.shown(in: try detail("thr_4"))
        #expect(newsletter?.id == "msg_4a")
        #expect(newsletter?.html?.isEmpty == false)
    }

    // MARK: The header and the caption

    @Test func theHeaderNamesTheSender() throws {
        let newsletter = try #require(sample.threads.first { $0.id == "thr_4" })
        let inbox = sample.inboxes.first { $0.id == newsletter.inboxId }
        #expect(FeedWords.sender(of: newsletter, inbox: inbox) == "The Weekly Build")

        // The first participant who isn't the inbox itself, by address when it has no name.
        let own = try #require(sample.inboxes.first { $0.id == "inb_northwind" })
        var thread = MailThread(
            id: "thr_y", inboxId: own.id, subject: "Issue",
            participants: [Address(name: "Northwind", email: own.address), Address(email: "a@b.example")],
            lastMessageAt: .now, sender: "a@b.example")
        #expect(FeedWords.sender(of: thread, inbox: own) == "a@b.example")
        // Only the inbox's own address: that one, as Home does.
        thread.participants = [Address(name: "Northwind", email: own.address)]
        #expect(FeedWords.sender(of: thread, inbox: own) == "Northwind")
        // No participants: the thread's sender, else words that say so.
        thread.participants = []
        #expect(FeedWords.sender(of: thread, inbox: own) == "a@b.example")
        thread.sender = nil
        #expect(FeedWords.sender(of: thread, inbox: own) == "Unknown sender")
    }

    @Test func theCaptionIsTheSummaryOnOneRunOfText() throws {
        var thread = try #require(sample.threads.first { $0.id == "thr_8" })
        let summary = try #require(thread.summary)
        #expect(FeedWords.caption(for: thread) == HomeWords.oneLine(summary))
        thread.summary = "  Line one\n\nline   two  "
        #expect(FeedWords.caption(for: thread) == "Line one line two")
        // No summary, no caption: the post's mail says it.
        thread.summary = " \n "
        #expect(FeedWords.caption(for: thread) == nil)
        thread.summary = nil
        #expect(FeedWords.caption(for: thread) == nil)
    }

    // MARK: Fetching

    @Test func eachThreadIsFetchedOnce() async throws {
        let posts = FeedPosts()
        let fetcher = Fetcher()
        fetcher.answers["thr_4"] = try detail("thr_4")
        let thread = try detail("thr_4").thread
        #expect(posts.state(of: thread) == .loading)

        await posts.load(thread, fetch: fetcher.fetch)
        #expect(posts.state(of: thread) == .shown(try detail("thr_4")))
        // Scrolling back, or coming back from the mail page: nothing is fetched again.
        await posts.load(thread, fetch: fetcher.fetch)
        #expect(fetcher.asked == ["thr_4"])

        // A new summary or a read mark isn't a new message.
        var changed = thread
        changed.summary = "A new summary."
        changed.unread = false
        changed.version += 1
        await posts.load(changed, fetch: fetcher.fetch)
        #expect(fetcher.asked == ["thr_4"])
        #expect(posts.state(of: changed) == .shown(try detail("thr_4")))
    }

    @Test func aNewMessageIsFetchedAgain() async throws {
        let posts = FeedPosts()
        let fetcher = Fetcher()
        let first = try detail("thr_4")
        fetcher.answers["thr_4"] = first
        await posts.load(first.thread, fetch: fetcher.fetch)

        var newer = first
        newer.thread.messageCount += 1
        newer.thread.lastMessageAt = first.thread.lastMessageAt.addingTimeInterval(3600)
        newer.messages.append(newer.messages[0])
        newer.messages[1].id = "msg_4b"
        fetcher.answers["thr_4"] = newer
        // Until the new one arrives, the post keeps what it had.
        #expect(posts.state(of: newer.thread) == .shown(first))
        await posts.load(newer.thread, fetch: fetcher.fetch)
        #expect(fetcher.asked == ["thr_4", "thr_4"])
        #expect(FeedWords.shown(in: posts.detail(for: newer.thread))?.id == "msg_4b")

        // Only the count, or only the time, changing is a new message too.
        var counted = newer.thread
        counted.messageCount += 1
        await posts.load(counted, fetch: fetcher.fetch)
        var timed = counted
        timed.lastMessageAt = timed.lastMessageAt.addingTimeInterval(60)
        await posts.load(timed, fetch: fetcher.fetch)
        #expect(fetcher.asked.count == 4)
    }

    @Test func aThreadOnTheWayIsNotAskedForTwice() async throws {
        let posts = FeedPosts()
        let fetcher = Fetcher()
        let thread = try detail("thr_8").thread
        fetcher.answers["thr_8"] = try detail("thr_8")
        fetcher.holds = true
        let first = Task { await posts.load(thread, fetch: fetcher.fetch) }
        while fetcher.asked.isEmpty { await Task.yield() }
        // The post appears again while its messages are on the way.
        await posts.load(thread, fetch: fetcher.fetch)
        #expect(fetcher.asked == ["thr_8"])
        fetcher.release()
        await first.value
        #expect(posts.detail(for: thread) == (try detail("thr_8")))
    }

    @Test func nothingToShowIsSaidAndTriedAgainLater() async throws {
        let posts = FeedPosts()
        let fetcher = Fetcher()
        let thread = try detail("thr_4").thread
        // Offline with no copy on the device.
        await posts.load(thread, fetch: fetcher.fetch)
        #expect(posts.state(of: thread) == .unavailable)
        // A copy without messages is nothing to show either.
        fetcher.answers["thr_4"] = ThreadDetail(thread: thread, messages: [], drafts: [])
        await posts.load(thread, fetch: fetcher.fetch)
        #expect(posts.state(of: thread) == .unavailable)
        // The next time the post appears it asks again.
        fetcher.answers["thr_4"] = try detail("thr_4")
        await posts.load(thread, fetch: fetcher.fetch)
        #expect(fetcher.asked.count == 3)
        #expect(posts.state(of: thread) == .shown(try detail("thr_4")))
    }

    @Test func aPostThatLeftBeforeItsMessagesCameKeepsNothing() async throws {
        let posts = FeedPosts()
        let fetcher = Fetcher()
        let thread = try detail("thr_4").thread
        fetcher.answers["thr_4"] = try detail("thr_4")
        fetcher.holds = true
        let task = Task { await posts.load(thread, fetch: fetcher.fetch) }
        while fetcher.asked.isEmpty { await Task.yield() }
        // Scrolled away: SwiftUI cancels the post's task.
        task.cancel()
        fetcher.release()
        await task.value
        #expect(posts.state(of: thread) == .loading)
        await posts.load(thread, fetch: fetcher.fetch)
        #expect(fetcher.asked.count == 2)
        #expect(posts.state(of: thread) == .shown(try detail("thr_4")))
    }

    @Test func theFeedIsTheSamplesNewslettersNewestFirst() async throws {
        let store = try await MailStore.sample()
        // The feed shows the Feed tab's list: every newsletter, newest first, in the chosen profile.
        #expect(
            CategoryList(store.lists, tab: .reads, inbox: nil, now: store.now).threads.map(\.id) == ["thr_8", "thr_4"])
        // Looking at a post (here offline, the sample's copy) marks nothing read and opens nothing.
        let detail = await store.detail(threadID: "thr_8")
        #expect(FeedWords.shown(in: detail)?.id == "msg_8a")
        #expect(store.lists.thread(id: "thr_8")?.unread == true)
        #expect(store.openThreadID == nil)
    }
}
