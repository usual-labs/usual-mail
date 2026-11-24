import Foundation
import UsualMailKit

/// What Home shows: the server's Home list (conversations and what nobody has sorted yet, that are let in, not done,
/// on no stack and not snoozed), split into New, unread, and Seen, read. Newsletters, invoices, receipts,
/// notifications and one-time codes are sorted into their own places and never come here (notifications left Home for
/// their own tab by the owner's decision of 2026-11-19).
struct HomeList: Equatable {
    /// Unread, newest first.
    var new: [MailThread]
    /// Read, newest first.
    var seen: [MailThread]

    init(_ threads: [MailThread]) {
        new = threads.filter(\.unread)
        seen = threads.filter { !$0.unread }
    }

    init(_ lists: MailLists, inbox inboxId: String?) {
        self.init(lists.home(inbox: inboxId))
    }

    var isEmpty: Bool { new.isEmpty && seen.isEmpty }
}

/// Who a row names, with the colour key and the picture its avatar shows (`HomeWords.shownSender`).
struct ShownSender: Equatable {
    /// Who the row names; nil for a thread that names nobody.
    var address: Address?
    /// What the avatar's colour is chosen by (`Avatar.key(for:in:)`).
    var key: String
    /// The thread's sender picture, when the row shows one.
    var avatar: SenderPicture?

    /// The name the row shows: the person's or company's name, else their address.
    var name: String? { address?.displayName }
}

/// The words on a Home item.
enum HomeWords {
    /// Who the conversation is with: the first participant who isn't the inbox itself.
    static func sender(of thread: MailThread, inbox: Inbox?) -> Address? {
        let own = inbox?.address.lowercased()
        return thread.participants.first { $0.email.lowercased() != own } ?? thread.participants.first
    }

    /// Who a row on Home, Receipts, Notifications or the Feed names, and the avatar beside it. With a sender picture
    /// (`thread.avatar`, which is for `thread.sender`), the name comes from that same address too, so an organisation's
    /// logo never sits beside someone else's name: the participant with that address (case aside) gives the name,
    /// else the address itself is shown (its initials then come from its local part). Without a picture, today's rule:
    /// the first participant who isn't the inbox itself (`sender(of:inbox:)`). A screened thread never shows a picture
    /// (the server never sends one for it; ignored here even so), and Screening's rows keep to `sender(of:inbox:)`.
    static func shownSender(of thread: MailThread, inbox: Inbox?) -> ShownSender {
        if let avatar = thread.avatar, !thread.screened,
            let sender = thread.sender?.trimmingCharacters(in: .whitespaces), !sender.isEmpty
        {
            let address =
                thread.participants.first { $0.email.lowercased() == sender.lowercased() } ?? Address(email: sender)
            return ShownSender(address: address, key: Avatar.key(for: address, in: thread), avatar: avatar)
        }
        let address = sender(of: thread, inbox: inbox)
        return ShownSender(address: address, key: Avatar.key(for: address, in: thread))
    }

    /// The line under the title: "Maya Kim - Shared feedback on the homepage…": the server's summary, or the mail's
    /// opening words while there is none, as one run of text: its line breaks and runs of spaces become single
    /// spaces, so the two lines the row gives it are filled. A summary is a model's plain text and is only ever shown
    /// as text. The sender is the one the row's avatar stands for (`shownSender(of:inbox:)`).
    static func line(for thread: MailThread, inbox: Inbox?) -> String {
        let summary = oneLine(thread.summary ?? "")
        let about = summary.isEmpty ? oneLine(thread.snippet) : summary
        guard let sender = shownSender(of: thread, inbox: inbox).name else { return about }
        return about.isEmpty ? sender : "\(sender) - \(about)"
    }

    /// Words with every run of spaces and line breaks made one space.
    static func oneLine(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
    }

    /// When, shown on hover: "now", "6m ago", "3h ago", "Yesterday", "Mon", "13 Nov".
    static func ago(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if calendar.isDate(date, inSameDayAs: now) { return "\(Int(seconds / 3600))h ago" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
            calendar.isDate(date, inSameDayAs: yesterday)
        {
            return "Yesterday"
        }
        let style = Date.FormatStyle(calendar: calendar, timeZone: calendar.timeZone).locale(
            Locale(identifier: "en_GB"))
        if seconds < 6 * 86_400 { return date.formatted(style.weekday(.abbreviated)) }
        return date.formatted(style.day().month(.abbreviated))
    }
}
