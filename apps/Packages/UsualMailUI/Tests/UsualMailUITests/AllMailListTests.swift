import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The classic inbox's list (owner's request of 2026-11-19): every mail that isn't done, trashed, removed or snoozed,
/// every kind and screened ones included, newest first, each row in plain mail's words.
@MainActor
struct AllMailListTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    /// 16 November 2026 in GMT, the sample's day, with times in 24 hours.
    private let dates = MailDate(today: CalendarDay("2026-11-16")!, timeZone: .gmt, twelveHour: false)

    private func thread(
        _ id: String, _ category: UsualMailKit.Category = .conversation, minutesAgo: Double = 0,
        inbox: String = "inb_a",
        screened: Bool = false, done: Bool = false, trashed: Bool = false
    ) -> MailThread {
        MailThread(
            id: id, inboxId: inbox, subject: id,
            lastMessageAt: Date(timeIntervalSince1970: 1_800_000_000 - minutesAgo * 60), category: category,
            screened: screened, done: done, trashed: trashed)
    }

    @Test func everyMailNotDoneOfEveryKindScreenedIncludedNewestFirst() async throws {
        let store = try await MailStore.sample()
        let list = AllMailList(store.lists, inbox: nil, now: store.now)
        // Conversations, unsorted mail, a one-time code, the screened question (thr_5), notifications, newsletters,
        // receipts, invoices, the stacked thr_7 and thr_10; never the done thr_3 and thr_13, nor the snoozed thr_9
        // until it comes back (`SnoozedOutOfSightTests`).
        #expect(
            list.threads.map(\.id) == [
                "thr_14", "thr_15", "thr_5", "thr_1", "thr_2", "thr_19", "thr_8", "thr_12", "thr_4", "thr_25", "thr_11",
                "thr_6", "thr_22", "thr_17", "thr_20", "thr_21", "thr_7", "thr_18", "thr_24", "thr_23", "thr_10",
                "thr_16",
            ])
    }

    @Test func oneProfileShowsOneInbox() async throws {
        let store = try await MailStore.sample()
        #expect(
            AllMailList(store.lists, inbox: "inb_harbor", now: store.now).threads.map(\.id) == [
                "thr_8", "thr_6", "thr_7",
            ])
        #expect(
            AllMailList(store.lists, inbox: "inb_northwind", now: store.now).threads.map(\.id) == [
                "thr_14", "thr_15", "thr_5", "thr_1", "thr_2", "thr_4", "thr_16",
            ])
        #expect(AllMailList(store.lists, inbox: "inb_nobody", now: store.now).threads.isEmpty)
    }

    @Test func doneTrashedLeftOutEqualTimesByIdDescendingOnceEach() {
        let lists = MailLists(
            home: [thread("thr_b", minutesAgo: 5), thread("thr_x", minutesAgo: 1, trashed: true)],
            categories: [
                .conversation: [thread("thr_b", minutesAgo: 5), thread("thr_d", minutesAgo: 5)],
                .newsletter: [thread("thr_c", .newsletter, minutesAgo: 5), thread("thr_y", .newsletter, done: true)],
                .otp: [thread("thr_a", .otp, minutesAgo: 30)],
            ],
            stacks: [.replyLater: [thread("thr_e", minutesAgo: 2)]],
            screening: [thread("thr_s", minutesAgo: 3, screened: true), thread("thr_z", done: true)])
        let list = AllMailList(lists, inbox: nil, now: now)
        #expect(list.threads.map(\.id) == ["thr_e", "thr_s", "thr_d", "thr_c", "thr_b", "thr_a"])
        #expect(AllMailList.shows(thread("thr_n"), at: now))
        #expect(AllMailList.shows(thread("thr_n", screened: true), at: now))
        #expect(!AllMailList.shows(thread("thr_n", done: true), at: now))
        #expect(!AllMailList.shows(thread("thr_n", trashed: true), at: now))
        #expect(AllMailList(lists, inbox: "inb_other", now: now).threads.isEmpty)
    }

    @Test func aRowsWordsArePlainMail() async throws {
        let store = try await MailStore.sample()
        let threads = AllMailList(store.lists, inbox: nil, now: store.now).threads
        let rows = Dictionary(
            uniqueKeysWithValues: threads.map {
                ($0.id, AllMailRow($0, inbox: store.lists.inbox(id: $0.inboxId), dates: dates))
            })
        let contract = try #require(rows["thr_1"])
        #expect(contract.sender == "Dana Whitfield")
        #expect(contract.count == "2")
        #expect(contract.label == nil)
        #expect(contract.subject == "Contract renewal for 2027")
        #expect(
            contract.opening == "Could you confirm the renewal terms by Friday? The only change is the notice period.")
        #expect(contract.date == "08:52")
        #expect(contract.hasAttachments && contract.strong)

        let weekly = try #require(rows["thr_4"])
        #expect(weekly.sender == "The Weekly Build" && weekly.count == nil && weekly.label == "Newsletter")
        #expect(weekly.subject == "The Weekly Build, issue 212" && weekly.date == "15 Nov")
        // Its sender picture comes along, as on Home.
        #expect(weekly.avatar != nil)

        let screened = try #require(rows["thr_5"])
        #expect(screened.sender == "Tomas Reyes" && screened.label == "Screening" && screened.date == "09:05")
        #expect(screened.avatar == nil)
        // Never a summary: the mail's own opening words.
        #expect(threads.allSatisfy { rows[$0.id]?.opening == HomeWords.oneLine($0.snippet) })
    }

    @Test func theLabelSaysWhereUsualMailFiledIt() {
        func label(_ category: UsualMailKit.Category, screened: Bool = false) -> String? {
            AllMailRow.label(for: thread("thr_l", category, screened: screened))
        }
        #expect(label(.newsletter) == "Newsletter")
        #expect(label(.receipt) == "Receipt")
        #expect(label(.invoice) == "Invoice")
        #expect(label(.notification) == "Notification")
        #expect(label(.otp) == "Code")
        // Conversations and unsorted mail carry none, a kind this app doesn't know included.
        #expect(label(.conversation) == nil)
        #expect(label(.uncategorized) == nil)
        #expect(label(.unknown("parcel")) == nil)
        // Screened mail says so, whatever its kind.
        #expect(label(.conversation, screened: true) == "Screening")
        #expect(label(.newsletter, screened: true) == "Screening")
    }

    @Test func theCountTheSubjectAndTheOpeningWords() {
        var mail = thread("thr_w")
        mail.messageCount = 3
        mail.subject = "  Lunch\non Friday "
        mail.snippet = "Shall we\n\ntry the   new place?"
        mail.participants = [Address(name: "Maya Kim", email: "maya@lumen.example")]
        let row = AllMailRow(mail, inbox: nil, dates: dates)
        #expect(row.sender == "Maya Kim" && row.count == "3")
        #expect(row.subject == "Lunch on Friday")
        #expect(row.opening == "Shall we try the new place?")

        mail.messageCount = 1
        mail.subject = ""
        mail.snippet = ""
        mail.participants = []
        mail.sender = "noreply@lumen.example"
        let bare = AllMailRow(mail, inbox: nil, dates: dates)
        #expect(bare.count == nil && bare.subject == "(no subject)" && bare.opening.isEmpty)
        // No participant: the thread's own sender address.
        #expect(bare.sender == "noreply@lumen.example")
    }

    @Test func unreadReadsStronger() {
        var mail = thread("thr_u")
        mail.unread = true
        #expect(AllMailRow(mail, inbox: nil, dates: dates).strong)
        mail.unread = false
        #expect(!AllMailRow(mail, inbox: nil, dates: dates).strong)
    }

    @Test func datesGmailsWay() {
        func at(_ text: String) -> Date { MailJSON.parseTime(text)! }
        let today = CalendarDay("2026-11-18")!
        let gmt24 = MailDate(today: today, timeZone: .gmt, twelveHour: false)
        let gmt12 = MailDate(today: today, timeZone: .gmt, twelveHour: true)
        // Today: the time, in the person's 12 or 24 hours.
        #expect(gmt24.words(for: at("2026-11-18T14:05:00Z")) == "14:05")
        #expect(gmt12.words(for: at("2026-11-18T14:05:00Z")) == "2:05 pm")
        #expect(gmt24.words(for: at("2026-11-18T00:07:00Z")) == "00:07")
        #expect(gmt12.words(for: at("2026-11-18T00:07:00Z")) == "12:07 am")
        // This year: the day.
        #expect(gmt24.words(for: at("2026-11-17T23:59:00Z")) == "17 Nov")
        #expect(gmt12.words(for: at("2026-01-02T08:00:00Z")) == "2 Jan")
        // An older year: the full date, day first.
        #expect(gmt24.words(for: at("2025-11-18T10:00:00Z")) == "18/11/2025")
        #expect(gmt24.words(for: at("2024-03-05T10:00:00Z")) == "05/03/2024")
    }

    @Test func datesInThePersonsTimeZone() throws {
        let berlin = try #require(TimeZone(identifier: "Europe/Berlin"))
        let late = MailJSON.parseTime("2026-11-18T23:30:00Z")!
        // Half past midnight on the 19th in Berlin: today there, yesterday in GMT.
        #expect(
            MailDate(today: CalendarDay("2026-11-19")!, timeZone: berlin, twelveHour: false).words(for: late) == "00:30"
        )
        #expect(
            MailDate(today: CalendarDay("2026-11-19")!, timeZone: .gmt, twelveHour: false).words(for: late) == "18 Nov")
        // New Year's Eve in GMT is already next year in Berlin.
        let eve = MailJSON.parseTime("2025-12-31T23:30:00Z")!
        #expect(
            MailDate(today: CalendarDay("2026-02-01")!, timeZone: berlin, twelveHour: false).words(for: eve) == "1 Jan")
        #expect(
            MailDate(today: CalendarDay("2026-02-01")!, timeZone: .gmt, twelveHour: false).words(for: eve)
                == "31/12/2025")
        // The clock's own moment gives the day in that zone.
        let now = MailJSON.parseTime("2026-11-18T23:30:00Z")!
        #expect(
            MailDate(now: now, timeZone: berlin, locale: Locale(identifier: "de_DE")).today == CalendarDay("2026-11-19")
        )
        #expect(!MailDate(now: now, timeZone: berlin, locale: Locale(identifier: "de_DE")).twelveHour)
        #expect(MailDate(now: now, timeZone: berlin, locale: Locale(identifier: "en_US")).twelveHour)
    }
}
