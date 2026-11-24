import Foundation
import SwiftUI
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The search page's words, keys and place in the window (the model itself is tested in UsualMailKit): where a found
/// mail lives, the highlighted runs, the chips, older mail's states, the arrows, Enter and Esc, and how the page opens
/// and leaves. Typing and clicking themselves are covered only here, never driven on screen.
@MainActor
struct SearchPageTests {
    private let now = MailJSON.parseTime("2026-11-18T10:00:00Z")!

    private func thread(
        category: UsualMailKit.Category = .conversation, done: Bool = false, screened: Bool = false,
        stack: Stack? = nil, comeBackAt: Date? = nil
    ) -> MailThread {
        MailThread(
            id: "thr_x", inboxId: "inb_northwind", subject: "Contract renewal", snippet: "Hi, attached.",
            lastMessageAt: now, category: category, screened: screened, done: done, stack: stack,
            comeBackAt: comeBackAt)
    }

    // MARK: Where it lives

    @Test func eachMailSaysWhereItLivesInTheAppsWords() {
        #expect(SearchWords.place(of: thread(), now: now) == "Home")
        #expect(SearchWords.place(of: thread(category: .uncategorized), now: now) == "Home")
        #expect(SearchWords.place(of: thread(category: .newsletter), now: now) == "Feed")
        #expect(SearchWords.place(of: thread(category: .invoice), now: now) == "Receipts")
        #expect(SearchWords.place(of: thread(category: .receipt), now: now) == "Receipts")
        #expect(SearchWords.place(of: thread(category: .notification), now: now) == "Notifications")
        // A one-time code is listed only on the classic inbox; a category this app doesn't know is unsorted.
        #expect(SearchWords.place(of: thread(category: .otp), now: now) == "Inbox")
        #expect(SearchWords.place(of: thread(category: .unknown("travel")), now: now) == "Home")
        // The person's own lists come before the category.
        #expect(SearchWords.place(of: thread(category: .receipt, stack: .replyLater), now: now) == "To reply")
        #expect(SearchWords.place(of: thread(stack: .setAside), now: now) == "Pinned")
        let later = now.addingTimeInterval(3600)
        #expect(SearchWords.place(of: thread(stack: .setAside, comeBackAt: later), now: now) == "Snoozed")
        // Come back already: where it lives again.
        #expect(SearchWords.place(of: thread(comeBackAt: now.addingTimeInterval(-60)), now: now) == "Home")
        #expect(SearchWords.place(of: thread(screened: true, comeBackAt: later), now: now) == "Screening")
        // Done comes first: only search finds it.
        #expect(
            SearchWords.place(of: thread(category: .newsletter, done: true, screened: true), now: now) == "Archived")
    }

    // MARK: Highlighting

    @Test func runsAreDrawnInOrderStrongWhereMatchedAndNeverAsMarkup() {
        let runs = [
            SearchRun("Your "), SearchRun("invoice", match: true), SearchRun(""), SearchRun(" **is** <b>due</b>"),
            SearchRun(" [here](https://x.example)"),
        ]
        // Empty runs drop out; neighbours of a kind join.
        #expect(
            SearchWords.pieces(runs) == [
                .init(text: "Your ", strong: false), .init(text: "invoice", strong: true),
                .init(text: " **is** <b>due</b> [here](https://x.example)", strong: false),
            ])
        let line = SearchWords.highlighted(runs, color: Theme.secondary)
        // The text is exactly the runs': no markdown or HTML read.
        #expect(String(line.characters) == "Your invoice **is** <b>due</b> [here](https://x.example)")
        let drawn = line.runs.map { (String(line[$0.range].characters), $0.font, $0.link) }
        #expect(drawn.map(\.0) == ["Your ", "invoice", " **is** <b>due</b> [here](https://x.example)"])
        #expect(drawn.map(\.1) == [Theme.sans(12), Theme.sans(12, weight: .semibold), Theme.sans(12)])
        #expect(drawn.allSatisfy { $0.2 == nil })
        #expect(line.runs.map(\.foregroundColor) == [Theme.secondary, Theme.ink, Theme.secondary])
        // An unread row's subject is strong all through, matched words too: one run.
        let unread = SearchWords.highlighted(
            [SearchRun("Re: "), SearchRun("lease", match: true)], weight: .semibold, color: Theme.ink)
        #expect(unread.runs.map(\.font) == [Theme.sans(12, weight: .semibold)])
        #expect(String(unread.characters) == "Re: lease")
    }

    @Test func theRowsLineIsTheSubjectThenTheExcerptWithWhereItCameFrom() {
        let base = thread()
        let subject = [SearchRun("Contract "), SearchRun("renewal", match: true)]
        let file = SearchExcerpt(field: .attachments, runs: [SearchRun("Lumen-"), SearchRun("Renewal", match: true)])
        let hit = SearchHit(
            thread: base, match: SearchMatch(fields: [.subject, .attachments], subject: subject, excerpt: file))
        #expect(SearchWords.subject(of: hit) == subject)
        #expect(SearchWords.excerpt(of: hit) == [SearchRun("Attachment: ")] + file.runs)
        // From the mail's own words: no label.
        let body = SearchHit(
            thread: base,
            match: SearchMatch(fields: [.body], excerpt: SearchExcerpt(field: .body, runs: [SearchRun("x")])))
        #expect(SearchWords.excerpt(of: body) == [SearchRun("x")])
        #expect(SearchWords.subject(of: body) == [SearchRun("Contract renewal")])
        // Filters alone: no match, so the subject as it is and the opening words.
        let plain = SearchHit(thread: base)
        #expect(SearchWords.excerpt(of: plain) == [SearchRun("Hi, attached.")])
        var untitled = base
        untitled.subject = "  "
        untitled.snippet = ""
        #expect(SearchWords.subject(of: SearchHit(thread: untitled)) == [SearchRun("(no subject)")])
        #expect(SearchWords.excerpt(of: SearchHit(thread: untitled)).isEmpty)
        #expect(
            [SearchField.summary, .facts, .attachments, .people, .sender, .body, .subject, .unknown("x")].map(
                SearchWords.excerptLabel) == ["Summary", "Details", "Attachment", "To", "From", nil, nil, nil])
    }

    // MARK: Chips and people

    @Test func chipsSayTheirFilterAndTheKindsAreAllOffered() {
        let utc = TimeZone(identifier: "UTC")!
        let dana = SearchPerson(email: "dana@lumen.example", name: "Dana Whitfield", threads: 4, lastMessageAt: now)
        #expect(SearchWords.chip(.from("dana@lumen.example"), person: dana) == "From Dana Whitfield")
        #expect(SearchWords.chip(.from("dana")) == "From dana")
        #expect(SearchWords.chip(.to("hello")) == "To hello")
        #expect(SearchWords.chip(.subject("weekly report")) == "Subject: weekly report")
        #expect(SearchWords.chip(.hasAttachment(true)) == "Has attachment")
        #expect(SearchWords.chip(.hasAttachment(false)) == "No attachment")
        #expect(SearchWords.chip(.unread(true)) == "Unread" && SearchWords.chip(.unread(false)) == "Read")
        // A typed day starts at midnight where the person is.
        let berlin = TimeZone(identifier: "Europe/Berlin")!
        #expect(SearchWords.chip(.after(time("2026-10-31T23:00:00Z")), timeZone: berlin) == "Since 1 Nov 2026")
        #expect(SearchWords.chip(.before(time("2026-11-15T00:00:00Z")), timeZone: utc) == "Before 15 Nov 2026")
        #expect(
            SearchKind.all.map(SearchWords.kind) == [
                "Conversations", "Newsletters", "Invoices", "Receipts", "Notifications", "Codes", "Not sorted",
                "Screening", "Archived",
            ])
        #expect(SearchWords.person(dana) == ("Dana Whitfield", "dana@lumen.example · 4 mails"))
        let nameless = SearchPerson(email: "billing@paperloop.example", threads: 1, lastMessageAt: now)
        #expect(SearchWords.person(nameless) == ("billing@paperloop.example", "1 mail"))
    }

    // MARK: Older mail

    @Test func eachInboxsAnswerHasItsWordsAndWhatItOffers() {
        let inbox = SampleData.bundled.inboxes[0]
        func words(_ state: RemoteInboxStatus, _ message: String? = nil) -> (String, SearchWords.RemoteOffer)? {
            SearchWords.remote(RemoteInboxState(inboxId: inbox.id, state: state, message: message), inbox: inbox)
                .map { ($0.words, $0.offer) }
        }
        #expect(words(.ok) == nil)
        // Unsupported says nothing: the button leaves that inbox out from then on.
        #expect(words(.unsupported, "IMAP can't search the mailbox.") == nil)
        #expect(words(.paused)! == ("Northwind Studio is paused, so its older mail wasn't searched.", .nothing))
        #expect(
            words(.needsSignIn, "Refused")! == ("Northwind Studio needs you to sign in with Google again.", .signIn))
        #expect(words(.providerError, "Gmail is\nbusy.")! == ("Gmail is busy.", .retry))
        #expect(words(.providerError)! == ("Gmail didn't answer for Northwind Studio.", .retry))
        #expect(words(.unknown("throttled"), "Later.")! == ("Later.", .nothing))
        #expect(words(.unknown("throttled")) == nil)
        #expect(
            SearchWords.remoteWait(seconds: 40)
                == "Older mail can be searched 10 times a minute. Try again in 40 seconds.")
        let hit = RemoteHit(
            id: "gm:1", inboxId: inbox.id, subject: "s", from: Address(email: "a@b.example"), lastMessageAt: now,
            archived: true)
        #expect(SearchWords.remotePlace(hit) == "Archived in Gmail")
        var inInbox = hit
        inInbox.archived = false
        #expect(SearchWords.remotePlace(inInbox) == "In Gmail")
    }

    // MARK: Keys

    @Test func theArrowsMoveThroughPeopleThenMailThenOlderMail() {
        let dana = SearchPerson(email: "dana@lumen.example", threads: 1, lastMessageAt: now)
        let rows = SearchKeys.rows(
            people: [dana], hits: [SearchHit(thread: thread())],
            remote: [
                RemoteHit(
                    id: "gm:1", inboxId: "inb_northwind", subject: "s", from: Address(email: "a@b.example"),
                    lastMessageAt: now)
            ])
        #expect(rows == [.person("dana@lumen.example"), .thread("thr_x"), .remote("gm:1")])
        var keys = SearchKeys()
        // Enter with nothing selected opens the first thread, not a person.
        #expect(keys.target(in: rows) == .thread("thr_x"))
        keys.up(in: rows)
        #expect(keys.selected == nil)
        keys.down(in: rows)
        #expect(
            keys.selected == .person("dana@lumen.example") && keys.target(in: rows) == .person("dana@lumen.example"))
        keys.down(in: rows)
        keys.down(in: rows)
        keys.down(in: rows)
        // The last row stays selected.
        #expect(keys.selected == .remote("gm:1"))
        keys.up(in: rows)
        keys.up(in: rows)
        #expect(keys.selected == .person("dana@lumen.example"))
        // Up from the first: back to the field.
        keys.up(in: rows)
        #expect(keys.selected == nil)
        // A new answer without the selected row forgets it; one with it keeps it.
        keys.selected = .thread("thr_x")
        keys.keep(in: rows)
        #expect(keys.selected == .thread("thr_x"))
        keys.keep(in: [.thread("thr_y")])
        #expect(keys.selected == nil)
        #expect(SearchKeys().target(in: []) == nil)
    }

    @Test func escClearsFirstThenLeaves() async throws {
        let service = HeldSearch()
        let model = SearchModel(service: service, sleep: { _ in }, timeZone: { "UTC" })
        model.text = "renewal"
        model.toggle(.done)
        #expect(SearchKeys.escape(hasQuery: model.hasQuery) == .clear)
        model.clear()
        #expect(model.text.isEmpty && model.filters == SearchFilters() && model.phase == .idle)
        #expect(SearchKeys.escape(hasQuery: model.hasQuery) == .leave)
        // A chip alone is something to clear too.
        model.toggle(.category(.receipt))
        #expect(SearchKeys.escape(hasQuery: model.hasQuery) == .clear)
        model.clear()
    }

    // MARK: Opening and leaving

    @Test func searchOpensWideWithoutTheTabsAndLeavesToWhereThePersonWas() {
        var nav = Navigation(place: .tab(.receipts))
        nav.press(.search)
        #expect(nav.place == .search && !nav.showsTabs && nav.wide && nav.destination == .mail)
        // The tabs blur out as the person left them; the bar is the one capsule, "← Receipts".
        #expect(nav.mailPlace == .tab(.receipts) && TopBar.items(place: .search, reading: false) == [.back, .gap])
        #expect(nav.searchReturnTitle == "Receipts")
        // A mail from the results: "← Search" and its actions; back to the results.
        nav.open("thr_1")
        #expect(nav.wide && TopBar.items(place: .search, reading: true).first == .back)
        nav.back()
        #expect(nav.place == .search && nav.reading == nil)
        // The page leaves to where the person was (its capsule, a second Esc).
        nav.back()
        #expect(nav.place == .tab(.receipts) && !nav.wide && nav.showsTabs)
    }

    @Test func commandKGoesToSearchOrBackToItsResults() {
        var nav = Navigation(place: .tab(.home))
        nav.openSearch()
        #expect(nav.place == .search && nav.searchReturnTitle == "Home")
        nav.open("thr_1")
        nav.openSearch()
        #expect(nav.place == .search && nav.reading == nil)
        // Another stack's button leaves search for that stack; ⌘K then opens search over it.
        nav.press(.pinned)
        #expect(nav.place == .pinned)
        nav.openSearch()
        #expect(nav.place == .search && nav.searchReturnTitle == "Pinned")
    }

    @Test func aDoneMailOffersMoveToInbox() {
        let done = thread(done: true)
        #expect(
            BarAction.archive.button(for: done, now: now)
                == BarButton(title: "Move to Inbox", input: .notDone, chosen: true))
        #expect(
            BarAction.archive.button(for: thread(), now: now)
                == BarButton(title: "Archive", input: .done, chosen: false))
        let items = RowMenu.items(for: done, now: now)
        #expect(items.contains(.act("Move to Inbox", .notDone)) && !items.contains(.act("Archive", .done)))
    }
}

/// A search service that never answers: what the page shows before the server does.
@MainActor
private final class HeldSearch: SearchService {
    func search(_ query: SearchQuery) async throws -> SearchResult {
        try await Task.sleep(for: .seconds(600))
        throw CancellationError()
    }

    func searchRemote(_ query: SearchQuery) async throws -> RemoteSearchResult {
        try await Task.sleep(for: .seconds(600))
        throw CancellationError()
    }

    func openRemote(id: String) async throws -> ThreadDetail {
        try await Task.sleep(for: .seconds(600))
        throw CancellationError()
    }

    func askSearch(_ input: SearchAskInput) async throws -> SearchAskResult {
        try await Task.sleep(for: .seconds(600))
        throw CancellationError()
    }
}

extension SearchPageTests {
    fileprivate func time(_ text: String) -> Date {
        MailJSON.parseTime(text)!
    }
}
