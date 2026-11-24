import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// To reply, Pinned and Snoozed (owner's words of 2026-11-20): each list from the copy in the contract's order, in one
/// profile or all, with each row's words, and what an empty one says.
@MainActor
struct RailListTests {
    let sample = SampleData.bundled
    private let gb = Locale(identifier: "en_GB")
    private let berlin = TimeZone(identifier: "Europe/Berlin")!

    private func time(_ text: String) -> Date { MailJSON.parseTime(text)! }

    private func ids(_ store: MailStore, _ place: Place, inbox: String? = nil) -> [String] {
        RailList(store.lists, place: place, inbox: inbox).threads.map(\.id)
    }

    /// A copy of the sample's dinner question (unsorted, let in, in the personal inbox) under another id, placed.
    private func made(
        _ id: String, stack: Stack? = nil, last: String? = nil, comeBack: String? = nil, screened: Bool = false,
        trashed: Bool = false, done: Bool = false
    ) throws -> MailThread {
        var thread = try #require(sample.threads.first { $0.id == "thr_12" })
        thread.id = id
        thread.stack = stack
        if let last { thread.lastMessageAt = time(last) }
        thread.comeBackAt = comeBack.map(time)
        thread.screened = screened
        thread.trashed = trashed
        thread.done = done
        return thread
    }

    @Test func theSamplesListsAreItsStacksAndWaiting() async throws {
        let store = try await MailStore.sample()
        // The harbour shoot's photos wait to be replied to; the train tickets (a receipt) are pinned; the lease renewal
        // comes back on Thursday 19 November.
        #expect(ids(store, .toReply) == ["thr_7"])
        #expect(ids(store, .pinned) == ["thr_10"])
        #expect(ids(store, .snoozed) == ["thr_9"])
        // None of them is in Home; the pinned receipt is on Receipts too, as the contract's category lists hold it.
        let home = HomeList(store.lists, inbox: nil)
        #expect(!(home.new + home.seen).contains { ["thr_7", "thr_9", "thr_10"].contains($0.id) })
        #expect(
            CategoryList(store.lists, tab: .receipts, inbox: nil, now: store.now).threads.contains { $0.id == "thr_10" }
        )
        // No other place lists anything.
        #expect(RailList(store.lists, place: .settings, inbox: nil).threads.isEmpty)
    }

    @Test func oneProfileShowsOneInbox() async throws {
        let store = try await MailStore.sample()
        #expect(ids(store, .toReply, inbox: "inb_harbor") == ["thr_7"])
        #expect(ids(store, .toReply, inbox: "inb_personal").isEmpty)
        #expect(ids(store, .pinned, inbox: "inb_personal") == ["thr_10"])
        #expect(ids(store, .pinned, inbox: "inb_harbor").isEmpty)
        #expect(ids(store, .snoozed, inbox: "inb_harbor") == ["thr_9"])
        #expect(ids(store, .snoozed, inbox: "inb_northwind").isEmpty)
    }

    @Test func stacksAreNewestFirstAndWaitingSoonestFirstAsTheContractSays() async throws {
        var data = sample
        data.threads += [
            // Pinned: the 15th above two of the 12th, those two by id descending, then the sample's tickets (11th).
            try made("thr_p1", stack: .setAside, last: "2026-11-15T10:00:00Z"),
            try made("thr_p2", stack: .setAside, last: "2026-11-12T09:00:00Z"),
            try made("thr_p3", stack: .setAside, last: "2026-11-12T09:00:00Z"),
            // Screened or trashed: on no list but screening.
            try made("thr_r1", stack: .replyLater, screened: true),
            try made("thr_r2", stack: .replyLater, trashed: true),
            // Snoozed: tomorrow first, then three on Thursday at 08:00 by id ascending, the sample's thr_9 among them.
            try made("thr_s3", comeBack: "2026-11-19T08:00:00Z"),
            try made("thr_s1", comeBack: "2026-11-17T08:00:00Z"),
            try made("thr_s2", comeBack: "2026-11-19T08:00:00Z"),
            // Back already (its time has passed), done, or screened: not waiting.
            try made("thr_s4", comeBack: "2026-11-16T08:00:00Z"),
            try made("thr_s5", comeBack: "2026-11-18T08:00:00Z", done: true),
            try made("thr_s6", comeBack: "2026-11-18T08:00:00Z", screened: true),
        ]
        let store = try await MailStore.sample(data)
        #expect(ids(store, .pinned) == ["thr_p1", "thr_p3", "thr_p2", "thr_10"])
        #expect(ids(store, .toReply) == ["thr_7"])
        #expect(ids(store, .snoozed) == ["thr_s1", "thr_9", "thr_s2", "thr_s3"])
        // The one whose time has passed is back in Home, by that time (08:00, under 09:29 and 08:52).
        #expect(Array(HomeList(store.lists, inbox: nil).new.map(\.id).prefix(3)) == ["thr_14", "thr_1", "thr_s4"])
    }

    @Test func aChangeShowsAtOnce() async throws {
        let store = try await MailStore.sample()
        // The dinner question, put on To reply by another device: it joins To reply and leaves Home.
        var thread = try #require(store.lists.thread(id: "thr_12"))
        thread.stack = .replyLater
        thread.version += 1
        await store.receive(.threadChanged(thread))
        #expect(ids(store, .toReply) == ["thr_12", "thr_7"])
        #expect(!HomeList(store.lists, inbox: nil).new.contains { $0.id == "thr_12" })
        // Pinned instead: one stack at a time.
        thread.stack = .setAside
        thread.version += 1
        await store.receive(.threadChanged(thread))
        #expect(ids(store, .toReply) == ["thr_7"])
        #expect(ids(store, .pinned) == ["thr_12", "thr_10"])
        // Off its stack and snoozed to Wednesday: in Snoozed, before the lease.
        thread.stack = nil
        thread.comeBackAt = time("2026-11-18T07:00:00Z")
        thread.version += 1
        await store.receive(.threadChanged(thread))
        #expect(ids(store, .pinned) == ["thr_10"])
        #expect(ids(store, .snoozed) == ["thr_12", "thr_9"])
        #expect(!HomeList(store.lists, inbox: nil).new.contains { $0.id == "thr_12" })
    }

    @Test func moneyAndEventRowsKeepTheirOwnWordsOthersHomes() async throws {
        let store = try await MailStore.sample()
        let today = CalendarDay(sample.now, in: berlin)
        func words(_ thread: MailThread) -> (any RowWords)? {
            RailList.words(
                for: thread, inbox: store.lists.inbox(id: thread.inboxId), today: today, twelveHour: false,
                timeZone: berlin, locale: gb)
        }
        // The pinned train tickets: their money words, as on Receipts.
        let tickets = try #require(store.lists.thread(id: "thr_10"))
        #expect(words(tickets)?.title == "Paid to Rail Booking")
        #expect(words(tickets)?.subtitle == "Train tickets to Hamburg, Friday 20 November")
        // A notification with an event: its event, as on Notifications.
        let parcel = try #require(store.lists.thread(id: "thr_19"))
        #expect(words(parcel)?.title == "Out for delivery · today, 15:15–18:15")
        #expect(words(parcel)?.subtitle == "Parcelway - Parcel from Fernhill Books")
        // A conversation and a notification without an event status: Home's row.
        #expect(words(try #require(store.lists.thread(id: "thr_7"))) == nil)
        let order = try #require(store.lists.thread(id: "thr_11"))
        #expect(order.event?.status == nil && words(order) == nil)
    }

    @Test func onlySnoozedSaysWhenEachComesBack() async throws {
        let store = try await MailStore.sample()
        let lease = try #require(store.lists.waiting.first)
        let snoozed = RailList(store.lists, place: .snoozed, inbox: nil)
        #expect(snoozed.when(for: lease, now: sample.now, timeZone: berlin, twelveHour: false) == "until Thu 09:00")
        #expect(snoozed.when(for: lease, now: sample.now, timeZone: berlin, twelveHour: true) == "until Thu 9:00 am")
        // To reply and Pinned show the time on hover, as Home does.
        for place in [Place.toReply, .pinned] {
            let list = RailList(store.lists, place: place, inbox: nil)
            #expect(list.when(for: lease, now: sample.now, timeZone: berlin, twelveHour: false) == nil)
        }
    }

    @Test func theEmptyStates() {
        let empty = MailLists()
        #expect(RailList(empty, place: .toReply, inbox: nil).emptyWords == "Nothing to reply to.")
        #expect(RailList(empty, place: .pinned, inbox: nil).emptyWords == "Nothing pinned.")
        #expect(RailList(empty, place: .snoozed, inbox: nil).emptyWords == "Nothing snoozed.")
        for place in Rail.lists {
            #expect(RailList(empty, place: place, inbox: nil).threads.isEmpty)
        }
    }
}

/// When a snoozed mail comes back, in the person's time zone and 12 or 24 hours (`SnoozeWords`).
struct SnoozeWordsTests {
    private let monday = MailJSON.parseTime("2026-11-16T09:30:00Z")!
    private let utc = TimeZone(identifier: "UTC")!
    private let berlin = TimeZone(identifier: "Europe/Berlin")!
    private let losAngeles = TimeZone(identifier: "America/Los_Angeles")!

    private func words(_ comeBack: String, now: Date? = nil, _ zone: TimeZone, twelve: Bool = false) -> String {
        SnoozeWords.until(MailJSON.parseTime(comeBack)!, now: now ?? monday, timeZone: zone, twelveHour: twelve)
    }

    @Test func todayIsTheTimeAlone() {
        #expect(words("2026-11-16T17:00:00Z", utc) == "until 17:00")
        #expect(words("2026-11-16T17:00:00Z", berlin) == "until 18:00")
        #expect(words("2026-11-16T17:00:00Z", berlin, twelve: true) == "until 6:00 pm")
        #expect(words("2026-11-16T11:05:00Z", utc, twelve: true) == "until 11:05 am")
    }

    @Test func tomorrowSaysSo() {
        #expect(words("2026-11-17T08:00:00Z", utc) == "until tomorrow 08:00")
        #expect(words("2026-11-17T08:00:00Z", berlin) == "until tomorrow 09:00")
        #expect(words("2026-11-17T08:00:00Z", utc, twelve: true) == "until tomorrow 8:00 am")
    }

    @Test func withinTheWeekTheWeekday() {
        #expect(words("2026-11-19T08:00:00Z", berlin) == "until Thu 09:00")
        #expect(words("2026-11-19T08:00:00Z", berlin, twelve: true) == "until Thu 9:00 am")
        // Six days ahead is still the weekday; seven is a date.
        #expect(words("2026-11-22T08:00:00Z", utc) == "until Sun 08:00")
        #expect(words("2026-11-23T08:00:00Z", utc) == "until 23 Nov, 08:00")
    }

    @Test func furtherAheadTheDate() {
        #expect(words("2026-12-03T09:00:00Z", utc) == "until 3 Dec, 09:00")
        #expect(words("2026-12-03T09:00:00Z", utc, twelve: true) == "until 3 Dec, 9:00 am")
        #expect(words("2027-01-04T12:30:00Z", utc, twelve: true) == "until 4 Jan, 12:30 pm")
    }

    @Test func theDayIsThePersonsOwn() {
        // 23:30 on Monday in UTC is 00:30 on Tuesday in Berlin; the same moment is "today" in one, "tomorrow" in the
        // other.
        let late = MailJSON.parseTime("2026-11-16T22:30:00Z")!
        #expect(words("2026-11-16T23:30:00Z", now: late, utc) == "until 23:30")
        #expect(words("2026-11-16T23:30:00Z", now: late, berlin) == "until tomorrow 00:30")
        #expect(words("2026-11-16T23:30:00Z", now: late, berlin, twelve: true) == "until tomorrow 12:30 am")
        // Thursday 08:00 in UTC is midnight in Los Angeles, where it is still Monday 01:30.
        #expect(words("2026-11-19T08:00:00Z", losAngeles) == "until Thu 00:00")
        #expect(words("2026-11-19T08:00:00Z", losAngeles, twelve: true) == "until Thu 12:00 am")
    }
}
