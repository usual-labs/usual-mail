import Foundation
import UsualMailKit

/// A notification's words, on the Notifications tab's rows and in the mail page's box (owner's request of 2026-11-19:
/// "focusing on simplicity, and low noise and only give the important info first"; rows that lead with the event and
/// when it matters). The server sends only the facts (`MailThread.event`); the app composes the words. The status is
/// a model's short English phrase ("Out for delivery", "Appointment moved"), so the title joins it to when with " · "
/// rather than building grammar around it: "Out for delivery · today, 3:15–6:15 pm", "Delivered · yesterday". When is
/// the mail's own local reading, with no time zone: shown as written, the day said against the person's local date.
/// Everything here is plain text from a model and is only ever shown as text.
struct EventWords: Equatable, RowWords {
    /// "{status} · {when}"; without a date of its own, the mail's day instead ("Out for delivery · yesterday"), so a
    /// row never reads as current when it isn't (coordinator's decision of 2026-11-19).
    let title: String
    /// "Parcelway - Parcel from Fernhill Books": the sender, as Home's line names them, and what it is about; Home's
    /// line (the sender and the summary, else the opening words) when the server has no `about`.
    let subtitle: String
    /// What the mail page's box shows under the title: what it is about, else the summary; empty with neither.
    let detail: String

    /// The words of a notification whose event has a status, the day said against `today` and times in 12 or 24
    /// hours; nil for any other thread, and for a notification without a status (a digest, or not read yet), whose
    /// row stays Home's. `timeZone` is the person's, for the mail's own day when the event has no date.
    init?(_ thread: MailThread, inbox: Inbox?, today: CalendarDay, twelveHour: Bool, timeZone: TimeZone = .current) {
        guard thread.category == .notification, let event = thread.event else { return nil }
        let status = HomeWords.oneLine(event.status ?? "")
        guard !status.isEmpty else { return nil }
        if let when = event.when.flatMap({ Self.when($0, today: today, twelveHour: twelveHour) }) {
            title = "\(status) · \(when)"
        } else {
            title = "\(status) · \(Self.day(CalendarDay(thread.lastMessageAt, in: timeZone), today: today))"
        }

        let about = HomeWords.oneLine(event.about ?? "")
        if about.isEmpty {
            subtitle = HomeWords.line(for: thread, inbox: inbox)
        } else if let sender = HomeWords.shownSender(of: thread, inbox: inbox).name {
            subtitle = "\(sender) - \(about)"
        } else {
            subtitle = about
        }
        let summary = HomeWords.oneLine(thread.summary ?? "")
        detail = about.isEmpty ? summary : about
    }

    /// The words as the person sees them now: the day against their local date at `now` in `timeZone`, times in
    /// `locale`'s 12 or 24 hours.
    init?(
        _ thread: MailThread, inbox: Inbox?, now: Date = .now, timeZone: TimeZone = .current,
        locale: Locale = .current
    ) {
        self.init(
            thread, inbox: inbox, today: CalendarDay(now, in: timeZone), twelveHour: Self.usesTwelveHours(locale),
            timeZone: timeZone)
    }

    /// The title over the detail, as the mail page's box shows them: one line each, never the same words twice (a
    /// detail that only repeats the status is left out).
    var lines: String {
        detail.isEmpty || detail == title || title.hasPrefix("\(detail) · ") ? title : "\(title)\n\(detail)"
    }

    /// Whether `locale` (the person's, with their own 12 or 24 hour choice) shows times in 12 hours.
    static func usesTwelveHours(_ locale: Locale) -> Bool {
        switch locale.hourCycle {
        case .zeroToEleven, .oneToTwelve: true
        case .zeroToTwentyThree, .oneToTwentyFour: false
        @unknown default: false
        }
    }

    /// When an event matters, against the person's `today`: "today", "tomorrow", "yesterday", the weekday within the
    /// next 6 days ("Thu"), else the day ("Thu 19 Nov"); then its time, ", 9:40 am" or ", 09:40", or its window,
    /// ", 3:15–6:15 pm" or ", 15:15–18:15". Nil when the date isn't a real "YYYY-MM-DD"; a time that isn't "HH:MM" is
    /// left out, and so is an end that isn't after the start.
    static func when(_ when: NotificationEvent.When, today: CalendarDay, twelveHour: Bool) -> String? {
        guard let day = CalendarDay(when.date) else { return nil }
        let date = Self.day(day, today: today)
        guard let start = when.time.flatMap(ClockTime.init) else { return date }
        return "\(date), \(times(start, when.endTime.flatMap(ClockTime.init), twelveHour: twelveHour))"
    }

    /// A day against the person's `today`: "today", "tomorrow", "yesterday", the weekday within the next 6 days
    /// ("Thu"), else the weekday and date ("Thu 19 Nov").
    static func day(_ day: CalendarDay, today: CalendarDay) -> String {
        switch day.days(from: today) {
        case 0: "today"
        case 1: "tomorrow"
        case -1: "yesterday"
        case 2...6: day.weekday
        default: "\(day.weekday) \(day.dayMonth)"
        }
    }

    /// A time, or a window from `start` to `end`: "9:40 am", "3:15–6:15 pm" with one am or pm when both share it,
    /// "11:30 am–1:00 pm" when they don't; "09:40", "15:15–18:15" in 24 hours. An en dash between.
    static func times(_ start: ClockTime, _ end: ClockTime?, twelveHour: Bool) -> String {
        guard let end, end > start else { return start.words(twelveHour: twelveHour) }
        guard twelveHour else { return "\(start.words(twelveHour: false))–\(end.words(twelveHour: false))" }
        if start.isMorning == end.isMorning {
            return "\(start.words(twelveHour: true, period: false))–\(end.words(twelveHour: true))"
        }
        return "\(start.words(twelveHour: true))–\(end.words(twelveHour: true))"
    }
}

/// A calendar date with no time zone, as a mail states it ("2026-11-19") or as the person's own clock reads it. Its
/// words are the app's English ones, day before month ("Thu 19 Nov"), as `HomeWords.ago` and `PaymentWords.day`
/// write days. Worked out in one fixed Gregorian calendar, never through a moment in another time zone, so a date is
/// never moved a day.
struct CalendarDay: Hashable, Comparable {
    let year: Int
    let month: Int
    let day: Int

    /// "2026-11-19"; nil unless exactly that form and a real date.
    init?(_ text: String) {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
            parts.allSatisfy({ $0.allSatisfy(\.isASCIIDigit) }),
            let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
            DateComponents(year: year, month: month, day: day).isValidDate(in: Self.calendar)
        else { return nil }
        self.year = year
        self.month = month
        self.day = day
    }

    /// The date `moment` falls on for someone in `timeZone`: the person's local date.
    init(_ moment: Date, in timeZone: TimeZone) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: moment)
        year = parts.year ?? 1970
        month = parts.month ?? 1
        day = parts.day ?? 1
    }

    static func < (lhs: CalendarDay, rhs: CalendarDay) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }

    /// Whole days from `other` to this date: 1 for the day after, -1 for the day before.
    func days(from other: CalendarDay) -> Int {
        Self.calendar.dateComponents([.day], from: other.start, to: start).day ?? 0
    }

    /// "Thu".
    var weekday: String {
        start.formatted(Self.style.weekday(.abbreviated))
    }

    /// "19 Nov".
    var dayMonth: String {
        start.formatted(Self.style.day().month(.abbreviated))
    }

    /// The date's first moment in the fixed calendar, only for working out days and words.
    private var start: Date {
        Self.calendar.date(from: DateComponents(year: year, month: month, day: day)) ?? .distantPast
    }

    /// Gregorian, in GMT: no daylight saving, so every day is 24 hours long.
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }()

    private static let style = Date.FormatStyle(calendar: calendar, timeZone: calendar.timeZone).locale(
        Locale(identifier: "en_GB"))
}

/// A time of day as a mail states it ("09:40"), with no time zone.
struct ClockTime: Hashable, Comparable {
    let hour: Int
    let minute: Int

    /// "09:40" or "9:40"; nil unless a real time of day.
    init?(_ text: String) {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, (1...2).contains(parts[0].count), parts[1].count == 2,
            parts.allSatisfy({ $0.allSatisfy(\.isASCIIDigit) }),
            let hour = Int(parts[0]), let minute = Int(parts[1]), (0...23).contains(hour), (0...59).contains(minute)
        else { return nil }
        self.hour = hour
        self.minute = minute
    }

    static func < (lhs: ClockTime, rhs: ClockTime) -> Bool {
        (lhs.hour, lhs.minute) < (rhs.hour, rhs.minute)
    }

    /// Before noon.
    var isMorning: Bool { hour < 12 }

    /// "9:40 am" (or "9:40" without the period) in 12 hours, lower case and no leading zero; "09:40" in 24.
    func words(twelveHour: Bool, period: Bool = true) -> String {
        let minutes = minute < 10 ? "0\(minute)" : "\(minute)"
        guard twelveHour else { return "\(hour < 10 ? "0\(hour)" : "\(hour)"):\(minutes)" }
        let clock = "\(hour % 12 == 0 ? 12 : hour % 12):\(minutes)"
        return period ? "\(clock) \(isMorning ? "am" : "pm")" : clock
    }
}

extension Character {
    /// "0" to "9" only, not other scripts' digits.
    fileprivate var isASCIIDigit: Bool { isASCII && isNumber }
}
