import Foundation
import UsualMailKit

/// What one of the person's own lists on the rail shows, from the copy (docs/contract.md, "Lists"): To reply is the
/// `reply_later` stack and Pinned the `set_aside` stack, each newest first by `lastMessageAt`, equal times by id
/// descending; Snoozed is the waiting list, by the come-back time, soonest first, equal times by id ascending. The copy
/// keeps that order (`MailLists`); this keeps the chosen profile's part of it. Whatever the category: a receipt on a
/// stack is here as well as on Receipts.
struct RailList: Equatable {
    let place: Place
    let threads: [MailThread]

    /// `place` is one of `Rail.lists`; any other place lists nothing.
    init(_ lists: MailLists, place: Place, inbox inboxId: String?) {
        self.place = place
        switch place {
        case .toReply: threads = lists.threads(on: .replyLater, inbox: inboxId)
        case .pinned: threads = lists.threads(on: .setAside, inbox: inboxId)
        case .snoozed: threads = lists.waiting(inbox: inboxId)
        default: threads = []
        }
    }

    /// What the list says when it has nothing, in Home's quiet way ("Nothing needs you.").
    var emptyWords: String {
        switch place {
        case .toReply: "Nothing to reply to."
        case .pinned: "Nothing pinned."
        case .snoozed: "Nothing snoozed."
        default: ""
        }
    }

    /// The words in a row's time place, always shown: on Snoozed, when it comes back ("until Mon 09:00",
    /// `SnoozeWords`); nil elsewhere, where the time shows on hover as on Home.
    func when(for thread: MailThread, now: Date, timeZone: TimeZone, twelveHour: Bool) -> String? {
        guard place == .snoozed, let comeBack = thread.comeBackAt else { return nil }
        return SnoozeWords.until(comeBack, now: now, timeZone: timeZone, twelveHour: twelveHour)
    }

    /// A row's own words: a receipt's or an invoice's money words (`PaymentWords`), a notification's event
    /// (`EventWords`, when it has a status); nil keeps Home's row, as for a conversation or unsorted mail.
    static func words(
        for thread: MailThread, inbox: Inbox?, today: CalendarDay, twelveHour: Bool, timeZone: TimeZone = .current,
        locale: Locale = .current
    ) -> (any RowWords)? {
        if let money = PaymentWords(thread, locale: locale) { return money }
        return EventWords(thread, inbox: inbox, today: today, twelveHour: twelveHour, timeZone: timeZone)
    }
}
