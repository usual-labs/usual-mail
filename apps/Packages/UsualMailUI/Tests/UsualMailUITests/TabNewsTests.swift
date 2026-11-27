import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The dot on a tab holding mail not seen yet (`TabNews`; the owner's words of 2026-11-27): unread mail that came while
/// the tab wasn't looked at lights it; looking at the tab, or reading the mail, puts it out; mail unread from before the
/// dots began lights nothing; and what is kept is kept on this device.
@MainActor
struct TabNewsTests {
    /// A new defaults domain, removed after.
    private final class Domain {
        let suite = "UsualMailTests-\(UUID().uuidString)"
        var defaults: UserDefaults { UserDefaults(suiteName: suite)! }

        deinit { UserDefaults().removePersistentDomain(forName: suite) }
    }

    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func thread(
        _ id: String, _ category: UsualMailKit.Category, inbox: String = "inb_northwind", minutesAgo: Double = 10,
        unread: Bool = true
    ) -> MailThread {
        var thread = MailThread(
            id: id, inboxId: inbox, subject: id, lastMessageAt: now.addingTimeInterval(-minutesAgo * 60),
            category: category)
        thread.unread = unread
        return thread
    }

    private func lists(home: [MailThread] = [], _ threads: [MailThread]) -> MailLists {
        MailLists(home: home, categories: Dictionary(grouping: threads, by: \.category))
    }

    @Test func mailFromBeforeLightsNothingAndNewMailLightsItsTab() {
        let domain = Domain()
        let news = TabNews(defaults: domain.defaults)
        let before = lists(home: [thread("thr_h", .conversation)], [thread("thr_n", .notification)])
        // Not started: no dots at all.
        #expect(news.dots(in: before, inbox: nil, now: now, except: .home).isEmpty)
        news.update(lists: before, inbox: nil, now: now, looking: .home)
        #expect(news.dots(in: before, inbox: nil, now: now, except: .home).isEmpty)
        // A notification and a newsletter come while Home shows.
        let after = lists(
            home: [thread("thr_h", .conversation)],
            [
                thread("thr_n", .notification), thread("thr_n2", .notification, minutesAgo: 1),
                thread("thr_f", .newsletter, minutesAgo: 1),
            ])
        news.update(lists: after, inbox: nil, now: now, looking: .home)
        #expect(news.dots(in: after, inbox: nil, now: now, except: .home) == [.notifications, .reads])
        // The chosen tab never has one.
        #expect(news.dots(in: after, inbox: nil, now: now, except: .notifications) == [.reads])
    }

    @Test func lookingAtTheTabOrReadingTheMailPutsItOut() {
        let domain = Domain()
        let news = TabNews(defaults: domain.defaults)
        news.update(lists: lists([thread("thr_old", .newsletter)]), inbox: nil, now: now, looking: .home)
        let came = lists([thread("thr_old", .newsletter), thread("thr_f", .newsletter, minutesAgo: 1)])
        news.update(lists: came, inbox: nil, now: now, looking: .home)
        #expect(news.dots(in: came, inbox: nil, now: now, except: .home) == [.reads])
        // Read elsewhere (opened from search, or on the Mac): no longer unread, no dot.
        let read = lists([thread("thr_old", .newsletter), thread("thr_f", .newsletter, minutesAgo: 1, unread: false)])
        #expect(news.dots(in: read, inbox: nil, now: now, except: .home).isEmpty)
        // Looked at: seen, unread or not.
        news.update(lists: came, inbox: nil, now: now, looking: .reads)
        #expect(news.dots(in: came, inbox: nil, now: now, except: .home).isEmpty)
        // New mail in the same thread counts again.
        let newer = lists([thread("thr_old", .newsletter), thread("thr_f", .newsletter, minutesAgo: 0)])
        news.update(lists: newer, inbox: nil, now: now, looking: .home)
        #expect(news.dots(in: newer, inbox: nil, now: now, except: .home) == [.reads])
    }

    @Test func aProfileSeesOnlyItsOwnAndLookingInOneLeavesTheOthersNew() {
        let domain = Domain()
        let news = TabNews(defaults: domain.defaults)
        news.update(lists: lists([thread("thr_x", .receipt)]), inbox: nil, now: now, looking: .home)
        let came = lists([
            thread("thr_x", .receipt), thread("thr_a", .receipt, inbox: "inb_a", minutesAgo: 1),
            thread("thr_b", .invoice, inbox: "inb_b", minutesAgo: 1),
        ])
        news.update(lists: came, inbox: "inb_a", now: now, looking: .home)
        #expect(news.dots(in: came, inbox: "inb_a", now: now, except: .home) == [.receipts])
        // Receipts looked at in inb_a's profile: inb_b's invoice is still new there.
        news.update(lists: came, inbox: "inb_a", now: now, looking: .receipts)
        #expect(news.dots(in: came, inbox: "inb_a", now: now, except: .home).isEmpty)
        #expect(news.dots(in: came, inbox: "inb_b", now: now, except: .home) == [.receipts])
        #expect(news.dots(in: came, inbox: nil, now: now, except: .home) == [.receipts])
    }

    @Test func itIsKeptOnTheDeviceAndForgetsWhatTheCopyNoLongerHolds() {
        let domain = Domain()
        let news = TabNews(defaults: domain.defaults)
        let shown = lists([thread("thr_n", .notification)])
        news.update(lists: shown, inbox: nil, now: now, looking: .notifications)
        let came = lists([thread("thr_n", .notification), thread("thr_n2", .notification, minutesAgo: 1)])
        news.update(lists: came, inbox: nil, now: now, looking: .home)
        // Started again, as the app is: the same dots.
        let again = TabNews(defaults: domain.defaults)
        #expect(again.dots(in: came, inbox: nil, now: now, except: .home) == [.notifications])
        // Archived away: forgotten, so what is kept stays as small as the copy.
        again.update(
            lists: lists([thread("thr_n2", .notification, minutesAgo: 1)]), inbox: nil, now: now, looking: .home)
        #expect(again.seen[.notifications] == [])
        // An empty copy (signed out, a fresh start) forgets nothing.
        again.update(lists: MailLists(), inbox: nil, now: now, looking: .home)
        #expect(again.seen[.notifications] == [])
        #expect(again.seen[.home] == [])
    }
}
