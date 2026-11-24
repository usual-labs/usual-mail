import Foundation

/// When a snoozed mail comes back, in the place a row's hover time takes and always shown (Snoozed's rows): "until
/// 18:00" today, "until tomorrow 09:00", the weekday within the next six days ("until Mon 09:00"), else the day and
/// month ("until 3 Dec, 09:00"). The day is the person's local date in their time zone, the time in their 12 or 24
/// hours ("until 6:00 pm"), in the app's way of writing days and times (`CalendarDay`, `ClockTime`, as `EventWords`).
enum SnoozeWords {
    static func until(_ comeBack: Date, now: Date, timeZone: TimeZone, twelveHour: Bool) -> String {
        let day = CalendarDay(comeBack, in: timeZone)
        let time = ClockTime(comeBack, in: timeZone).words(twelveHour: twelveHour)
        switch day.days(from: CalendarDay(now, in: timeZone)) {
        case 0: return "until \(time)"
        case 1: return "until tomorrow \(time)"
        case 2...6: return "until \(day.weekday) \(time)"
        default: return "until \(day.dayMonth), \(time)"
        }
    }
}

extension ClockTime {
    /// The time of day `moment` shows on a clock in `timeZone`, to the minute.
    init(_ moment: Date, in timeZone: TimeZone) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute], from: moment)
        self.init(hour: parts.hour ?? 0, minute: parts.minute ?? 0)
    }
}
