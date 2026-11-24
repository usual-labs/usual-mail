import Foundation
import UsualMailKit

/// The Notifications tab in three parts, in this order (owner's "Yes, build both" of 2026-11-19; docs/contract-ai.md,
/// "Notification events": the server sends none, each client works them out): **Today**, an event on the person's
/// current local date; **Coming up**, a later date; **Earlier**, a past date or no date at all (no event, no status,
/// a digest). The date is the mail's own local reading, compared with the person's local date as it is, never
/// converted. The tab's mail is the notifications list (`CategoryList`): let in, not done, never trashed, not snoozed.
/// Each part holds rows (`NotificationRow`): one per notification group and one per thread without a group; a row's
/// part and place are those of the thread it shows, the group's newest mail.
struct NotificationSections: Equatable {
    /// By time, a missing time last, then the newest mail.
    let today: [NotificationRow]
    /// Soonest date first, then by time, a missing time last, then the newest mail.
    let comingUp: [NotificationRow]
    /// Newest mail first.
    let earlier: [NotificationRow]

    /// A titled part of the tab.
    struct Part: Equatable, Identifiable {
        let title: String
        let rows: [NotificationRow]
        var id: String { title }
    }

    /// Groups `threads` (any order) into rows and sorts them into the three parts against the person's `today`.
    init(_ threads: [MailThread], today: CalendarDay) {
        var now: [NotificationRow] = []
        var later: [NotificationRow] = []
        var before: [NotificationRow] = []
        for row in NotificationRow.rows(threads) {
            guard let day = Self.day(of: row.shown) else {
                before.append(row)
                continue
            }
            if day == today {
                now.append(row)
            } else if day > today {
                later.append(row)
            } else {
                before.append(row)
            }
        }
        self.today = now.sorted { Self.soonest($0.shown, $1.shown) }
        comingUp = later.sorted { Self.soonest($0.shown, $1.shown) }
        earlier = before.sorted { NotificationRow.newest($0.shown, $1.shown) }
    }

    /// The notifications the copy lists at `now`, in one inbox or all, sorted against the person's `today`. A snoozed
    /// thread is left out until it comes back (`CategoryList`), so a group whose newest mail is snoozed shows its next,
    /// counts only the threads shown, and a group whose every thread is snoozed has no row.
    init(_ lists: MailLists, inbox inboxId: String?, today: CalendarDay, now: Date) {
        self.init(CategoryList(lists, tab: .notifications, inbox: inboxId, now: now).threads, today: today)
    }

    /// The parts that have mail, in order; an empty part isn't shown.
    var parts: [Part] {
        [
            Part(title: "Today", rows: today), Part(title: "Coming up", rows: comingUp),
            Part(title: "Earlier", rows: earlier),
        ]
        .filter { !$0.rows.isEmpty }
    }

    var isEmpty: Bool { today.isEmpty && comingUp.isEmpty && earlier.isEmpty }

    /// Every row, in the order shown.
    var rows: [NotificationRow] { today + comingUp + earlier }

    /// Every thread, row by row in the order shown, each row's newest first.
    var all: [MailThread] { rows.flatMap(\.threads) }

    /// The date a thread's event matters on; nil without one, or when it isn't a real date.
    static func day(of thread: MailThread) -> CalendarDay? {
        thread.event?.when.flatMap { CalendarDay($0.date) }
    }

    /// The time a thread's event starts at; nil without one.
    private static func time(of thread: MailThread) -> ClockTime? {
        thread.event?.when?.time.flatMap(ClockTime.init)
    }

    /// Soonest first: by date, then time with a missing time last, then the newest mail.
    private static func soonest(_ lhs: MailThread, _ rhs: MailThread) -> Bool {
        let (leftDay, rightDay) = (day(of: lhs), day(of: rhs))
        if leftDay != rightDay, let leftDay, let rightDay { return leftDay < rightDay }
        switch (time(of: lhs), time(of: rhs)) {
        case (let left?, let right?) where left != right: return left < right
        case (.some, nil): return true
        case (nil, .some): return false
        default: return NotificationRow.newest(lhs, rhs)
        }
    }
}
