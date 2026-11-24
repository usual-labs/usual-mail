import SwiftUI
import UsualMailDesign
import UsualMailKit

/// The search page's words: where a found mail lives, the highlighted subject and excerpt, the chips, and older mail's
/// states. Mail's own words are plain text throughout, never markup.
enum SearchWords {
    /// Before anything is typed: the operators, in one quiet line.
    static let hint = "from:  to:  subject:  has:attachment  is:unread  before:2026/11/01  \"a phrase\"  -word"
    static let nothingFound = "Nothing found"
    static let remoteButton = "Search older mail in Gmail"

    // MARK: Where it lives

    /// The quiet word for where a found mail lives, as the app names its places: "Archived" for done mail (only search
    /// finds it), "Screening" while its sender isn't let in, "Snoozed" while it waits, "To reply" or "Pinned" on a
    /// stack, else its category's place: "Home" (conversations and what nobody has sorted), "Feed" (newsletters),
    /// "Receipts" (invoices and receipts), "Notifications", and "Inbox" for a one-time code, which only the classic
    /// inbox lists.
    static func place(of thread: MailThread, now: Date) -> String {
        if thread.done { return "Archived" }
        if thread.screened { return Place.screening.title }
        if thread.isWaiting(at: now) { return Place.snoozed.title }
        switch thread.stack {
        case .replyLater: return Place.toReply.title
        case .setAside: return Place.pinned.title
        default: break
        }
        switch thread.category.listed {
        case .newsletter: return Tab.reads.title
        case .invoice, .receipt: return Tab.receipts.title
        case .notification: return Tab.notifications.title
        case .otp: return Place.inbox.title
        default: return Tab.home.title
        }
    }

    // MARK: Highlighting

    /// One piece of highlighted text: the server's run as it is, strong where it matched.
    struct Piece: Equatable {
        let text: String
        let strong: Bool
    }

    /// The runs in order, adjacent ones of the same kind joined. Their text is kept exactly: never read as markup.
    static func pieces(_ runs: [SearchRun]) -> [Piece] {
        var pieces: [Piece] = []
        for run in runs where !run.text.isEmpty {
            if let last = pieces.last, last.strong == run.match {
                pieces[pieces.count - 1] = Piece(text: last.text + run.text, strong: run.match)
            } else {
                pieces.append(Piece(text: run.text, strong: run.match))
            }
        }
        return pieces
    }

    /// The runs as one run of text: the matched words in the package's semibold (the design's bold) and ink, the rest
    /// in `weight` and `color`. Made with `AttributedString(_:)`, which takes text as it is.
    static func highlighted(_ runs: [SearchRun], weight: UsualFontWeight = .regular, color: Color) -> AttributedString {
        pieces(runs).reduce(into: AttributedString()) { line, piece in
            var text = AttributedString(piece.text)
            text.font = Theme.sans(12, weight: piece.strong ? .semibold : weight)
            text.foregroundColor = piece.strong ? Theme.ink : color
            line += text
        }
    }

    /// Where an excerpt came from, said before it, for a match outside the mail's own words: the summary, the AI's
    /// facts, an attachment's name, who else is in it, or who wrote. Nothing for the body or the subject.
    static func excerptLabel(_ field: SearchField) -> String? {
        switch field {
        case .summary: "Summary"
        case .facts: "Details"
        case .attachments: "Attachment"
        case .people: "To"
        case .sender: "From"
        default: nil
        }
    }

    /// The row's line after the subject: the excerpt with its label ("Attachment: invoice-118.pdf"), or without a match
    /// outside the subject, the mail's opening words.
    static func excerpt(of hit: SearchHit) -> [SearchRun] {
        guard let excerpt = hit.match?.excerpt, !excerpt.runs.isEmpty else {
            let opening = HomeWords.oneLine(hit.thread.snippet)
            return opening.isEmpty ? [] : [SearchRun(opening)]
        }
        let label = excerptLabel(excerpt.field).map { [SearchRun("\($0): ")] } ?? []
        return label + excerpt.runs
    }

    /// The subject in runs when it matched, else as it is; "(no subject)" without one.
    static func subject(of hit: SearchHit) -> [SearchRun] {
        if let runs = hit.match?.subject, !runs.isEmpty { return runs }
        let subject = HomeWords.oneLine(hit.thread.subject)
        return [SearchRun(subject.isEmpty ? "(no subject)" : subject)]
    }

    // MARK: Chips

    /// A kind's chip: the seven categories in the app's words, then Screening and Archived (`done`).
    static func kind(_ kind: SearchKind) -> String {
        switch kind {
        case .category(let category):
            switch category {
            case .conversation: "Conversations"
            case .newsletter: "Newsletters"
            case .invoice: "Invoices"
            case .receipt: "Receipts"
            case .notification: "Notifications"
            case .otp: "Codes"
            case .uncategorized: "Not sorted"
            case .unknown(let raw): raw
            }
        case .screened: "Screening"
        case .done: "Archived"
        }
    }

    /// A filter's chip: "From Dana Whitfield" (a person chosen from People goes by name), "To hello@…", "Subject:
    /// renewal", "Has attachment", "No attachment", "Unread", "Read", "Since 1 Nov 2026", "Before 1 Nov 2026" (a typed
    /// day starts at midnight where the person is), and a period by the days it covers, "1–31 Oct 2026".
    static func chip(_ chip: SearchChip, person: SearchPerson? = nil, timeZone: TimeZone = .current) -> String {
        switch chip {
        case .from(let value):
            let name = person?.email == value ? person?.name.map(HomeWords.oneLine) : nil
            return "From \(name.flatMap { $0.isEmpty ? nil : $0 } ?? value)"
        case .to(let value): return "To \(value)"
        case .subject(let value): return "Subject: \(value)"
        case .hasAttachment(let has): return has ? "Has attachment" : "No attachment"
        case .unread(let unread): return unread ? "Unread" : "Read"
        case .after(let date): return "Since \(day(date, in: timeZone))"
        case .before(let date): return "Before \(day(date, in: timeZone))"
        case .period(let after, let before): return period(after: after, before: before, in: timeZone)
        }
    }

    /// A period by the days it covers, `after` its first and `before` the day after its last (`before` is exclusive):
    /// "1–31 Oct 2026", "28 Oct – 3 Nov 2026", "15 Dec 2025 – 14 Jan 2026", one day "19 Nov 2026".
    static func period(after: Date, before: Date, in timeZone: TimeZone) -> String {
        let first = CalendarDay(after, in: timeZone)
        let last = CalendarDay(before.addingTimeInterval(-1), in: timeZone)
        if last <= first { return "\(first.dayMonth) \(first.year)" }
        if first.year != last.year { return "\(first.dayMonth) \(first.year) – \(last.dayMonth) \(last.year)" }
        if first.month == last.month { return "\(first.day)–\(last.dayMonth) \(last.year)" }
        return "\(first.dayMonth) – \(last.dayMonth) \(last.year)"
    }

    /// "1 Nov 2026".
    static func day(_ date: Date, in timeZone: TimeZone) -> String {
        let day = CalendarDay(date, in: timeZone)
        return "\(day.dayMonth) \(day.year)"
    }

    // MARK: People

    /// A person's line: their name and address, and how many threads hold mail from them ("3 mails").
    static func person(_ person: SearchPerson) -> (name: String, detail: String) {
        let name = person.name.map(HomeWords.oneLine).flatMap { $0.isEmpty ? nil : $0 }
        let count = person.threads == 1 ? "1 mail" : "\(person.threads) mails"
        return name.map { ($0, "\(person.email) · \(count)") } ?? (person.email, count)
    }

    // MARK: Older mail

    /// What an inbox's answer to a remote search says, and what it offers: nothing for `ok` and `unsupported` (the
    /// button leaves that inbox out from then on); for `paused`, that it is paused; for `needs_sign_in`, Sign in with
    /// Google; for `provider_error`, the provider's words and Try again.
    enum RemoteOffer: Equatable {
        case nothing
        case signIn
        case retry
    }

    static func remote(_ state: RemoteInboxState, inbox: Inbox?) -> (words: String, offer: RemoteOffer)? {
        let name = inbox?.name ?? "This inbox"
        let message = state.message.map(HomeWords.oneLine).flatMap { $0.isEmpty ? nil : $0 }
        switch state.state {
        case .ok, .unsupported: return nil
        case .paused: return ("\(name) is paused, so its older mail wasn't searched.", .nothing)
        case .needsSignIn: return ("\(name) needs you to sign in with Google again.", .signIn)
        case .providerError: return (message ?? "Gmail didn't answer for \(name).", .retry)
        case .unknown: return message.map { ($0, .nothing) }
        }
    }

    /// While the server asks to wait (`Retry-After`): how long, in words.
    static func remoteWait(seconds: Int) -> String {
        "Older mail can be searched 10 times a minute. Try again in \(APIError.wait(seconds: seconds))."
    }

    /// Where an older mail is in the mailbox.
    static func remotePlace(_ hit: RemoteHit) -> String {
        hit.archived ? "Archived in Gmail" : "In Gmail"
    }

    /// Nothing older found, after asking.
    static let nothingOlder = "Nothing older found in Gmail."

    // MARK: Asking in a sentence

    static let ask = "Ask"
    static let asking = "Asking…"
    /// What Ask sends where, said once in its tooltip and to VoiceOver.
    static let askPrivacy = "Only the sentence goes to your AI service, never your mail."

    /// Ask's tooltip: its shortcut and what it sends; while the server asks to wait, that instead.
    static func askTooltip(waiting: Bool) -> String {
        waiting ? "Asked often just now. Try again shortly." : "Ask in a sentence (⌘↩). \(askPrivacy)"
    }

    static let aiSettings = "AI settings…"

    /// The quiet line under the chips after a sentence was asked, and whether it offers the AI settings: nothing when
    /// the AI understood it (the chips say it); "Searched as typed" when it understood nothing; otherwise why the
    /// sentence was searched as typed.
    static func askNote(_ outcome: SearchAskOutcome) -> (words: String, offersSettings: Bool)? {
        switch outcome {
        case .understood:
            return nil
        case .searchedAsTyped:
            return ("Searched as typed", false)
        case .aiNotSetUp:
            return ("Asking needs your server's AI, so this was searched as typed.", true)
        case .aiDidNotAnswer(_, let detail):
            let words = detail.map(HomeWords.oneLine).flatMap { $0.isEmpty ? nil : $0 }
            return (words ?? "The AI didn't answer, so this was searched as typed.", false)
        case .tooMany:
            return ("Asked often just now; try again shortly. This was searched as typed.", false)
        case .refused(let words), .failed(let words):
            return (HomeWords.oneLine(words), false)
        }
    }
}
