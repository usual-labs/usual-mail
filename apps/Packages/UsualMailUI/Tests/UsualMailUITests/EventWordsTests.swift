import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// A notification's words (owner's request of 2026-11-19: rows that lead with the event and when it matters): the
/// status and when in the title, the sender and what it is about under it; Home's row while there is no status.
struct EventWordsTests {
    let sample = SampleData.bundled
    let gb = Locale(identifier: "en_GB")
    let us = Locale(identifier: "en_US")
    /// The sample's Monday, 16 November 2026.
    let monday = CalendarDay("2026-11-16")!

    private func thread(
        status: String? = "Out for delivery", about: String? = "Parcel from Fernhill Books", date: String? = nil,
        time: String? = nil, end: String? = nil, summary: String? = "Arrives this afternoon", event: Bool = true,
        category: UsualMailKit.Category = .notification,
        sender: Address? = Address(
            name: "Parcelway", email: "updates@parcelway.example")
    ) -> MailThread {
        MailThread(
            id: "thr_x", inboxId: "inb_personal", subject: "Your parcel is on its way", snippet: "Track your parcel",
            participants: sender.map { [$0] } ?? [], lastMessageAt: Date(timeIntervalSince1970: 1_800_000_000),
            category: category, summary: summary,
            event: event
                ? NotificationEvent(
                    status: status, about: about,
                    when: date.map { NotificationEvent.When(date: $0, time: time, endTime: end) }) : nil)
    }

    private func title(
        _ date: String?, _ time: String? = nil, _ end: String? = nil, twelveHour: Bool = false, status: String = "Due"
    ) -> String? {
        EventWords(
            thread(status: status, date: date, time: time, end: end), inbox: nil, today: monday,
            twelveHour: twelveHour, timeZone: TimeZone(identifier: "UTC")!)?.title
    }

    // MARK: The day, against the person's today

    @Test func theDayIn24Hours() {
        #expect(title("2026-11-16") == "Due · today")
        #expect(title("2026-11-17") == "Due · tomorrow")
        #expect(title("2026-11-15") == "Due · yesterday")
        // Within the next 6 days, the weekday alone.
        #expect(title("2026-11-18", "09:40") == "Due · Wed, 09:40")
        #expect(title("2026-11-22") == "Due · Sun")
        // A week on is Monday again: the date, so it is never taken for today.
        #expect(title("2026-11-23", "12:00") == "Due · Mon 23 Nov, 12:00")
        // Further back than yesterday, the date.
        #expect(title("2026-11-13") == "Due · Fri 13 Nov")
        #expect(title("2026-11-14", "15:15", "18:15") == "Due · Sat 14 Nov, 15:15–18:15")
        // Across a month and a year.
        #expect(title("2026-12-01") == "Due · Tue 1 Dec")
        #expect(title("2027-01-04") == "Due · Mon 4 Jan")
    }

    @Test func theDayIn12Hours() {
        #expect(title("2026-11-16", "15:15", "18:15", twelveHour: true) == "Due · today, 3:15–6:15 pm")
        #expect(title("2026-11-17", "09:40", twelveHour: true) == "Due · tomorrow, 9:40 am")
        #expect(title("2026-11-15", "21:05", twelveHour: true) == "Due · yesterday, 9:05 pm")
        #expect(title("2026-11-19", "09:40", twelveHour: true) == "Due · Thu, 9:40 am")
        #expect(title("2026-11-23", "12:00", twelveHour: true) == "Due · Mon 23 Nov, 12:00 pm")
        #expect(title("2026-11-19", twelveHour: true) == "Due · Thu")
    }

    @Test func theOwnersExamples() {
        let moved = thread(status: "Appointment moved", about: nil, date: "2026-11-19", time: "09:40")
        // Thursday 19 November is the weekday from Monday; from a Thursday a week earlier, the date.
        let earlier = CalendarDay("2026-11-12")!
        #expect(
            EventWords(moved, inbox: nil, today: earlier, twelveHour: true)?.title
                == "Appointment moved · Thu 19 Nov, 9:40 am")
        #expect(
            EventWords(moved, inbox: nil, today: monday, twelveHour: true)?.title == "Appointment moved · Thu, 9:40 am")
        let arriving = thread(status: "Arriving", date: "2026-11-16", time: "15:15", end: "18:15")
        #expect(
            EventWords(arriving, inbox: nil, today: monday, twelveHour: true)?.title
                == "Arriving · today, 3:15–6:15 pm")
        #expect(
            EventWords(arriving, inbox: nil, today: monday, twelveHour: false)?.title == "Arriving · today, 15:15–18:15"
        )
    }

    // MARK: Times and windows

    @Test func timesIn12And24Hours() throws {
        func words(_ text: String, twelveHour: Bool) throws -> String {
            try #require(ClockTime(text)).words(twelveHour: twelveHour)
        }
        #expect(try words("09:40", twelveHour: true) == "9:40 am")
        #expect(try words("09:40", twelveHour: false) == "09:40")
        #expect(try words("00:05", twelveHour: true) == "12:05 am")
        #expect(try words("00:05", twelveHour: false) == "00:05")
        #expect(try words("12:00", twelveHour: true) == "12:00 pm")
        #expect(try words("23:59", twelveHour: true) == "11:59 pm")
        #expect(try words("9:40", twelveHour: false) == "09:40")
        // Not a time of day.
        for text in ["24:00", "12:60", "1240", "12:5", "", "ab:cd", "-1:30", "12:30:00", "１２:３０"] {
            #expect(ClockTime(text) == nil, "\(text)")
        }
    }

    @Test func windows() throws {
        func window(_ start: String, _ end: String?, twelveHour: Bool) throws -> String {
            EventWords.times(
                try #require(ClockTime(start)), end.flatMap(ClockTime.init), twelveHour: twelveHour)
        }
        // One am or pm at the end when both share it, an en dash between.
        #expect(try window("15:15", "18:15", twelveHour: true) == "3:15–6:15 pm")
        #expect(try window("08:00", "11:30", twelveHour: true) == "8:00–11:30 am")
        #expect(try window("11:30", "13:00", twelveHour: true) == "11:30 am–1:00 pm")
        #expect(try window("15:15", "18:15", twelveHour: false) == "15:15–18:15")
        #expect(try window("08:00", "11:30", twelveHour: false) == "08:00–11:30")
        // An end that isn't after the start, or none, leaves the start alone.
        #expect(try window("18:15", "15:15", twelveHour: true) == "6:15 pm")
        #expect(try window("15:15", "15:15", twelveHour: false) == "15:15")
        #expect(try window("15:15", nil, twelveHour: false) == "15:15")
    }

    @Test func badTimesAndDatesAreLeftOut() {
        // A time that isn't one: the day alone. An end without a start: the day alone.
        #expect(title("2026-11-16", "3pm") == "Due · today")
        #expect(title("2026-11-16", nil, "18:15") == "Due · today")
        #expect(title("2026-11-16", "15:15", "later") == "Due · today, 15:15")
        // A date that isn't a real one: as if there were none, the mail's own day (15 January 2027).
        for date in ["2026-02-30", "16.11.2026", "2026-11-6", "", "2026-13-01", "２０２６-11-16"] {
            #expect(title(date) == "Due · Fri 15 Jan", "\(date)")
        }
    }

    @Test func theLocalesHours() {
        #expect(EventWords.usesTwelveHours(us))
        #expect(!EventWords.usesTwelveHours(gb))
        #expect(!EventWords.usesTwelveHours(Locale(identifier: "de_DE")))
    }

    // MARK: The subtitle and every fallback

    @Test func theSubtitleIsTheSenderAndWhatItIsAbout() {
        let words = EventWords(thread(date: "2026-11-16"), inbox: nil, today: monday, twelveHour: false)
        #expect(words?.subtitle == "Parcelway - Parcel from Fernhill Books")
        // With nobody to name, what it is about alone.
        let nobody = EventWords(thread(sender: nil), inbox: nil, today: monday, twelveHour: false)
        #expect(nobody?.subtitle == "Parcel from Fernhill Books")
        // Line breaks and runs of spaces from a model become one line.
        let loose = EventWords(
            thread(status: " Out  for\ndelivery ", about: "Parcel\n from  Fernhill"), inbox: nil, today: monday,
            twelveHour: false, timeZone: TimeZone(identifier: "UTC")!)
        #expect(
            loose?.title == "Out for delivery · Fri 15 Jan" && loose?.subtitle == "Parcelway - Parcel from Fernhill")
    }

    @Test func withoutAboutTheSubtitleIsHomesLine() {
        let noAbout = thread(about: nil, date: "2026-11-16")
        let words = EventWords(noAbout, inbox: nil, today: monday, twelveHour: false)
        #expect(words?.subtitle == "Parcelway - Arrives this afternoon")
        #expect(words?.subtitle == HomeWords.line(for: noAbout, inbox: nil))
        // Nor a summary: the snippet, as Home shows it.
        let bare = EventWords(thread(about: "  ", summary: nil), inbox: nil, today: monday, twelveHour: false)
        #expect(bare?.subtitle == "Parcelway - Track your parcel")
    }

    @Test func withAStatusButNoWhenTheTitleSaysTheMailsDay() {
        // The mail came at 2027-01-15 08:00 UTC: its own day, said the way a date would be, so it never reads as now.
        let utc = TimeZone(identifier: "UTC")!
        let words = { (today: String) in
            EventWords(thread(), inbox: nil, today: CalendarDay(today)!, twelveHour: true, timeZone: utc)?.title
        }
        #expect(words("2027-01-15") == "Out for delivery · today")
        #expect(words("2027-01-16") == "Out for delivery · yesterday")
        #expect(words("2027-01-20") == "Out for delivery · Fri 15 Jan")
        #expect(words("2026-11-16") == "Out for delivery · Fri 15 Jan")
        // The day is the person's: 08:00 UTC is still the 14th in Honolulu.
        let honolulu = TimeZone(identifier: "Pacific/Honolulu")!
        #expect(
            EventWords(thread(), inbox: nil, today: CalendarDay("2027-01-15")!, twelveHour: true, timeZone: honolulu)?
                .title == "Out for delivery · yesterday")
        // The mail page's box says the same.
        #expect(
            EventWords(thread(), inbox: nil, today: CalendarDay("2027-01-16")!, twelveHour: true, timeZone: utc)?.lines
                == "Out for delivery · yesterday\nParcel from Fernhill Books")
    }

    @Test func withoutAStatusTheRowStaysHomes() {
        // No event (not read yet), a status of nothing, a digest, an empty status: no words of its own.
        #expect(EventWords(thread(event: false), inbox: nil, today: monday, twelveHour: false) == nil)
        #expect(
            EventWords(thread(status: nil, date: "2026-11-16"), inbox: nil, today: monday, twelveHour: false) == nil)
        #expect(
            EventWords(thread(status: nil, about: nil, summary: nil), inbox: nil, today: monday, twelveHour: false)
                == nil)
        #expect(EventWords(thread(status: " \n "), inbox: nil, today: monday, twelveHour: false) == nil)
        // An event the copy still holds on a thread re-sorted elsewhere is never shown.
        #expect(EventWords(thread(category: .conversation), inbox: nil, today: monday, twelveHour: false) == nil)
        // The rows on Home and Receipts never take them.
        #expect(CategoryList.words(for: thread(), on: .notifications) == nil)
    }

    // MARK: The sample

    @Test func theSamplesNotificationsOnItsMonday() throws {
        func words(_ id: String, _ locale: Locale) throws -> EventWords? {
            let thread = try #require(sample.threads.first { $0.id == id })
            let inbox = sample.inboxes.first { $0.id == thread.inboxId }
            return EventWords(thread, inbox: inbox, now: sample.now, timeZone: berlin, locale: locale)
        }
        #expect(try words("thr_19", gb)?.title == "Out for delivery · today, 15:15–18:15")
        #expect(try words("thr_19", us)?.title == "Out for delivery · today, 3:15–6:15 pm")
        #expect(try words("thr_19", gb)?.subtitle == "Parcelway - Parcel from Fernhill Books")
        #expect(try words("thr_20", gb)?.title == "Appointment confirmed · Mon 23 Nov, 12:00")
        #expect(try words("thr_20", us)?.title == "Appointment confirmed · Mon 23 Nov, 12:00 pm")
        #expect(try words("thr_20", us)?.subtitle == "Moor Dental - Check-up with Dr. Moor")
        #expect(try words("thr_21", gb)?.title == "Delivered · Fri 13 Nov")
        #expect(try words("thr_21", us)?.title == "Delivered · Fri 13 Nov")
        #expect(try words("thr_21", us)?.subtitle == "Parcelway - Parcel with the walking boots")
        // The digest and the notification not read yet keep Home's row.
        #expect(try words("thr_22", gb) == nil)
        #expect(try words("thr_11", us) == nil)
    }

    // MARK: No time zone conversion

    @Test func theMailsDateAndTimeAreNeverConverted() throws {
        let parcel = thread(date: "2026-11-16", time: "23:30")
        // One moment: Monday evening in Los Angeles, Tuesday morning in Berlin and Tokyo.
        let moment = try Date("2026-11-17T04:00:00Z", strategy: .iso8601)
        func title(in zone: String) throws -> String? {
            EventWords(
                parcel, inbox: nil, now: moment, timeZone: try #require(TimeZone(identifier: zone)), locale: gb)?
                .title
        }
        // The day moves with where the person is; the mail's 23:30 stays 23:30.
        #expect(try title(in: "America/Los_Angeles") == "Out for delivery · today, 23:30")
        #expect(try title(in: "Europe/Berlin") == "Out for delivery · yesterday, 23:30")
        #expect(try title(in: "Asia/Tokyo") == "Out for delivery · yesterday, 23:30")
        #expect(try title(in: "Pacific/Kiritimati") == "Out for delivery · yesterday, 23:30")
        #expect(try title(in: "Pacific/Pago_Pago") == "Out for delivery · today, 23:30")
    }

    @Test func thePersonsLocalDate() throws {
        let moment = try Date("2026-11-16T23:30:00Z", strategy: .iso8601)
        #expect(CalendarDay(moment, in: .gmt) == CalendarDay("2026-11-16"))
        #expect(CalendarDay(moment, in: berlin) == CalendarDay("2026-11-17"))
        #expect(CalendarDay(moment, in: try #require(TimeZone(identifier: "America/New_York"))) == monday)
        // Days between dates in one fixed calendar, across the clocks going back in Europe and a leap day.
        #expect(CalendarDay("2026-10-26")!.days(from: CalendarDay("2026-10-24")!) == 2)
        #expect(CalendarDay("2028-03-01")!.days(from: CalendarDay("2028-02-28")!) == 2)
        #expect(CalendarDay("2026-11-15")!.days(from: monday) == -1)
    }

    // MARK: The mail page's box

    @Test func theMailPagesBoxShowsTheEventThenWhatItIsAbout() throws {
        let parcel = try #require(sample.threads.first { $0.id == "thr_19" })
        let inbox = sample.inboxes.first { $0.id == parcel.inboxId }
        func box(_ thread: MailThread, _ locale: Locale = Locale(identifier: "en_GB")) -> String? {
            MailPage.summaryLine(thread, inbox: inbox, locale: locale, now: sample.now, timeZone: berlin)
        }
        #expect(box(parcel) == "Out for delivery · today, 15:15–18:15\nParcel from Fernhill Books")
        #expect(box(parcel, us) == "Out for delivery · today, 3:15–6:15 pm\nParcel from Fernhill Books")
        // Without `about`, the summary; with neither, the title alone; never the same words twice.
        var noAbout = parcel
        noAbout.event?.about = nil
        #expect(
            box(noAbout)
                == "Out for delivery · today, 15:15–18:15\n"
                + "Your Fernhill Books parcel arrives today in the afternoon")
        noAbout.summary = nil
        #expect(box(noAbout) == "Out for delivery · today, 15:15–18:15")
        var echo = parcel
        echo.event = NotificationEvent(status: "Delivered", about: "Delivered")
        #expect(box(echo) == "Delivered · today")
        // The digest keeps "Sender - summary".
        let digest = try #require(sample.threads.first { $0.id == "thr_22" })
        #expect(box(digest) == "Pinboard Social - What the people you follow shared this week")
    }

    private var berlin: TimeZone { TimeZone(identifier: "Europe/Berlin")! }
}
