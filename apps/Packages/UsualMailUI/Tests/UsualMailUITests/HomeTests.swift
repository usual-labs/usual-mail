import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// Home's list, its words and the window's columns. The avatar's tests are in `AvatarTests`.
@MainActor
struct HomeTests {
    let sample = SampleData.bundled

    @Test func homeIsConversationsAndUnsortedMailWithoutNotifications() async throws {
        let store = try await MailStore.sample()
        let list = HomeList(store.lists, inbox: nil)
        let shown = list.new + list.seen
        #expect(!shown.isEmpty)
        for thread in shown {
            #expect(["conversation", "unknown"].contains(thread.category.rawValue))
            #expect(!thread.screened && !thread.done && thread.stack == nil && !thread.trashed)
        }
        let ids = Set(shown.map(\.id))
        // A conversation in Home; a notification (owner's decision of 2026-11-19: they have their own tab), a screened
        // one, a one-time code, a newsletter, an invoice, a stacked and a snoozed one never.
        #expect(ids.contains("thr_1"))
        for id in ["thr_11", "thr_19", "thr_25", "thr_5", "thr_15", "thr_4", "thr_6", "thr_7", "thr_9"] {
            #expect(!ids.contains(id), "\(id) shouldn't be in Home")
        }
        // New is unread, Seen is read. The sample's Home: five threads, as its counts say.
        #expect(list.new.allSatisfy { $0.unread })
        #expect(list.seen.allSatisfy { !$0.unread })
        #expect(list.new.map(\.id) == ["thr_14", "thr_1", "thr_2", "thr_12"])
        #expect(list.seen.map(\.id) == ["thr_16"])
        #expect(shown.count == store.counts?.all.home)
        // The personal inbox's Home is only the dinner question; its eight notifications are on their tab.
        #expect(HomeList(store.lists, inbox: "inb_personal").new.map(\.id) == ["thr_12"])
        #expect(HomeList(store.lists, inbox: "inb_personal").seen.isEmpty)
        #expect(store.counts?.counts(for: "inb_personal")?.home == 1)
    }

    @Test func aNotificationLeavesHomeAndAConversationComesBack() async throws {
        let store = try await MailStore.sample()
        // A conversation re-sorted as a notification leaves Home for the Notifications tab.
        var moved = try #require(store.lists.thread(id: "thr_1"))
        moved.category = .notification
        moved.version += 1
        await store.receive(.threadChanged(moved))
        #expect(!HomeList(store.lists, inbox: nil).new.contains { $0.id == "thr_1" })
        #expect(
            NotificationSections(store.lists, inbox: nil, today: CalendarDay("2026-11-16")!, now: store.now).all
                .contains {
                    $0.id == "thr_1"
                })
        // A notification re-sorted as a conversation comes to Home.
        var parcel = try #require(store.lists.thread(id: "thr_19"))
        parcel.category = .conversation
        parcel.event = nil
        parcel.version += 1
        await store.receive(.threadChanged(parcel))
        #expect(HomeList(store.lists, inbox: nil).new.contains { $0.id == "thr_19" })
    }

    @Test func readMailIsSeenAndKeepsItsOrder() throws {
        var threads = sample.threads.filter { ["thr_1", "thr_2", "thr_12"].contains($0.id) }
        threads[1].unread = false
        let list = HomeList(threads)
        #expect(list.new.map(\.id) == [threads[0].id, threads[2].id])
        #expect(list.seen.map(\.id) == [threads[1].id])
    }

    @Test func oneProfileShowsOneInbox() async throws {
        let store = try await MailStore.sample()
        let list = HomeList(store.lists, inbox: "inb_personal")
        #expect(!list.isEmpty)
        #expect((list.new + list.seen).allSatisfy { $0.inboxId == "inb_personal" })
    }

    @Test func theLineIsWhoThenTheSummaryOrTheSnippet() throws {
        let summarized = try #require(sample.threads.first { $0.id == "thr_1" })
        let inbox = sample.inboxes.first { $0.id == summarized.inboxId }
        let summary = try #require(summarized.summary)
        #expect(HomeWords.sender(of: summarized, inbox: inbox)?.displayName == "Dana Whitfield")
        #expect(HomeWords.line(for: summarized, inbox: inbox) == "Dana Whitfield - \(summary)")
        var plain = summarized
        plain.summary = nil
        #expect(HomeWords.line(for: plain, inbox: inbox) == "Dana Whitfield - \(summarized.snippet)")
        // A summary is shown as it is: markup in it stays text.
        plain.summary = "<b>Pay</b> *now*"
        #expect(HomeWords.line(for: plain, inbox: inbox) == "Dana Whitfield - <b>Pay</b> *now*")
        // One run of text: line breaks and runs of spaces in the opening words become single spaces.
        plain.summary = nil
        plain.snippet = "Hi Dana,\n\n  Could you   confirm\tthe terms?"
        #expect(HomeWords.line(for: plain, inbox: inbox) == "Dana Whitfield - Hi Dana, Could you confirm the terms?")
    }

    @MainActor @Test func aSummaryThatArrivesLaterShowsAtOnce() async throws {
        let store = try await MailStore.sample()
        var thread = try #require(store.lists.home(inbox: nil).first { ($0.summary ?? "").isEmpty })
        thread.summary = "Asks to move the call to Friday."
        thread.version += 1
        await store.receive(.threadChanged(thread))
        let shown = try #require(store.lists.home(inbox: nil).first { $0.id == thread.id })
        let inbox = store.lists.inbox(id: shown.inboxId)
        #expect(HomeWords.line(for: shown, inbox: inbox).hasSuffix(" - Asks to move the call to Friday."))
    }

    @Test func timesOnHover() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = MailJSON.parseTime("2026-11-17T12:00:00Z")!
        func ago(_ text: String) -> String { HomeWords.ago(MailJSON.parseTime(text)!, now: now, calendar: calendar) }
        #expect(ago("2026-11-17T11:59:30Z") == "now")
        #expect(ago("2026-11-17T11:54:00Z") == "6m ago")
        #expect(ago("2026-11-17T09:00:00Z") == "3h ago")
        #expect(ago("2026-11-16T20:00:00Z") == "Yesterday")
        #expect(ago("2026-11-14T10:00:00Z") == "Sat")
        #expect(ago("2026-11-03T10:00:00Z") == "3 Nov")
    }

    @Test func theDesignsColumnsAndNarrowerWindows() {
        let design = MailLayout(size: CGSize(width: 1512, height: 982))
        #expect(design.side == 300)
        #expect(design.center == 700)
        #expect(design.top == 98.2)
        let narrow = MailLayout(size: CGSize(width: 820, height: 560))
        #expect(narrow.side == 56)
        #expect(narrow.center == 688)
        #expect(narrow.top == 56)
        #expect(narrow.railInset == 12)
    }
}
