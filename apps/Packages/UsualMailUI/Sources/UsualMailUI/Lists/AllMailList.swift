import Foundation
import UsualMailKit

/// The classic inbox (owner's request of 2026-11-19: "a mirror of what they see in their gmail account"): every
/// thread of the chosen profile that isn't snoozed, whatever its kind and whether or not its sender is let in, as
/// plain mail: no summaries, no money or event words, no sections, no grouping. Newest first by `lastMessageAt`, equal
/// times by id descending, as the contract's lists are ordered.
///
/// Filtered and sorted once per change of the copy; a row's words (`AllMailRow`) are worked out only when the row is
/// drawn.
struct AllMailList: Equatable {
    /// Newest first.
    let threads: [MailThread]

    /// Whether the page lists a thread at `now`: one that isn't trashed or done, and isn't snoozed. Archived (done)
    /// mail isn't listed, by the owner's decision of 2026-11-19; a snoozed one only once it comes back, by the
    /// coordinator's of 2026-11-20 (only Snoozed lists it while it waits, `MailThread.isWaiting(at:)`); a removed
    /// thread has already left the copy.
    static func shows(_ thread: MailThread, at now: Date) -> Bool {
        !thread.trashed && !thread.done && !thread.isWaiting(at: now)
    }

    /// Every thread the copy's lists hold (the categories' and the stacks', waiting and screening: every thread that
    /// isn't done) that the page shows at `now`, in one inbox or all.
    init(_ lists: MailLists, inbox inboxId: String?, now: Date) {
        threads = lists.everyThread
            .filter { (inboxId == nil || $0.inboxId == inboxId) && Self.shows($0, at: now) }
            .sorted { $0.lastMessageAt != $1.lastMessageAt ? $0.lastMessageAt > $1.lastMessageAt : $0.id > $1.id }
    }
}

/// One mail's words on the classic inbox: who, how many messages, where Usual Mail filed it, the subject and the mail's
/// own opening words, and when. Never a summary.
struct AllMailRow: Equatable {
    /// Who the row names (`HomeWords.shownSender`): their name, else their address.
    let sender: String
    /// How many messages the thread has, when more than one ("3").
    let count: String?
    /// Where Usual Mail filed it, for filed kinds only (`label(for:)`).
    let label: String?
    /// On one line; "(no subject)" without one.
    let subject: String
    /// The mail's own opening words (`snippet`) on one line; empty when there are none.
    let opening: String
    /// When the newest message came, Gmail's way (`MailDate`).
    let date: String
    /// The avatar's name, colour key and sender picture, as Home's rows have them.
    let avatarName: String
    let avatarKey: String
    let avatar: SenderPicture?
    let hasAttachments: Bool
    /// Unread the classic way: the sender, the subject and the date stronger (the package's semibold, the design's
    /// bold) and the sender in ink. A read row's sender is regular in the secondary tone, its subject regular in ink.
    let strong: Bool

    init(_ thread: MailThread, inbox: Inbox?, dates: MailDate) {
        let shown = HomeWords.shownSender(of: thread, inbox: inbox)
        let name = shown.name.map(HomeWords.oneLine) ?? ""
        let sender = name.isEmpty ? HomeWords.oneLine(thread.sender ?? "") : name
        self.sender = sender.isEmpty ? "(no sender)" : sender
        count = thread.messageCount > 1 ? "\(thread.messageCount)" : nil
        label = Self.label(for: thread)
        let subject = HomeWords.oneLine(thread.subject)
        self.subject = subject.isEmpty ? "(no subject)" : subject
        opening = HomeWords.oneLine(thread.snippet)
        date = dates.words(for: thread.lastMessageAt)
        avatarName = shown.name ?? thread.subject
        avatarKey = shown.key
        avatar = shown.avatar
        hasAttachments = thread.hasAttachments
        strong = thread.unread
    }

    /// The quiet word for where Usual Mail filed a thread: "Screening" while its sender isn't let in, else its kind
    /// when it is a filed one ("Newsletter", "Receipt", "Invoice", "Notification", "Code" for a one-time code). Nil for
    /// conversations and unsorted mail.
    static func label(for thread: MailThread) -> String? {
        if thread.screened { return "Screening" }
        switch thread.category {
        case .newsletter: return "Newsletter"
        case .receipt: return "Receipt"
        case .invoice: return "Invoice"
        case .notification: return "Notification"
        case .otp: return "Code"
        default: return nil
        }
    }
}

/// A mail's date on the classic inbox, Gmail's way, for someone in `timeZone` whose date is `today`: the time today
/// ("14:05", or "2:05 pm" in 12 hours), the day this year ("18 Nov"), the full date before that ("18/11/2025"). The
/// words are the app's English, day before month, as `CalendarDay` writes days.
struct MailDate: Equatable {
    let today: CalendarDay
    let timeZone: TimeZone
    let twelveHour: Bool
    /// Gregorian in `timeZone`, made once for the whole list.
    private let calendar: Calendar

    init(today: CalendarDay, timeZone: TimeZone, twelveHour: Bool) {
        self.today = today
        self.timeZone = timeZone
        self.twelveHour = twelveHour
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        self.calendar = calendar
    }

    /// As the person sees it at `now`: their date in `timeZone`, times in `locale`'s 12 or 24 hours.
    init(now: Date, timeZone: TimeZone = .current, locale: Locale = .current) {
        self.init(
            today: CalendarDay(now, in: timeZone), timeZone: timeZone,
            twelveHour: EventWords.usesTwelveHours(locale))
    }

    func words(for date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let year = parts.year ?? 1970
        let month = parts.month ?? 1
        let day = parts.day ?? 1
        if year == today.year && month == today.month && day == today.day {
            return ClockTime(hour: parts.hour ?? 0, minute: parts.minute ?? 0).words(twelveHour: twelveHour)
        }
        if year == today.year { return "\(day) \(Self.months[month - 1])" }
        return "\(Self.twoDigits(day))/\(Self.twoDigits(month))/\(year)"
    }

    private static func twoDigits(_ number: Int) -> String {
        number < 10 ? "0\(number)" : "\(number)"
    }

    /// The months' short names in the app's English ("Nov"), from the same formatting `CalendarDay` uses, worked out
    /// once.
    private static let months: [String] = (1...12).map { month in
        CalendarDay(month < 10 ? "2026-0\(month)-15" : "2026-\(month)-15")?.dayMonth.split(separator: " ").last
            .map(String.init) ?? ""
    }
}

extension ClockTime {
    /// A time of day from its parts, which must be a real time.
    init(hour: Int, minute: Int) {
        self.hour = hour
        self.minute = minute
    }
}
