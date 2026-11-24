import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The search page's Ask in words and places (the model is tested in UsualMailKit): its icon, label and tooltip with
/// the shortcut and the privacy line, the period an answer's dates show as, the quiet line each outcome leads to, and
/// the AI settings it offers. The button, the shortcut and the progress are covered only by these and the model's
/// tests, never driven on screen.
@MainActor
struct SearchAskPageTests {
    private let berlin = TimeZone(identifier: "Europe/Berlin")!

    private func time(_ text: String) -> Date {
        MailJSON.parseTime(text)!
    }

    @Test func askIsTheSparklesAndAWordWithItsShortcutAndThePrivacyLineInItsTooltip() {
        #expect(Icon.ask.rawValue == "sparkles" && Icon.ask.designed == nil)
        #expect(SearchWords.ask == "Ask" && SearchWords.asking == "Asking…")
        #expect(
            SearchWords.askTooltip(waiting: false)
                == "Ask in a sentence (⌘↩). Only the sentence goes to your AI service, never your mail.")
        #expect(SearchWords.askTooltip(waiting: true) == "Asked often just now. Try again shortly.")
    }

    // MARK: Dates

    @Test func datesShowAsAPeriodItsEndExclusive() {
        // "Last month" in Berlin: 1 October up to (not including) 1 November.
        let october = SearchChip.period(after: time("2026-09-30T22:00:00Z"), before: time("2026-10-31T23:00:00Z"))
        #expect(SearchWords.chip(october, timeZone: berlin) == "1–31 Oct 2026")
        #expect(
            SearchWords.period(after: time("2026-10-27T23:00:00Z"), before: time("2026-11-03T23:00:00Z"), in: berlin)
                == "28 Oct – 3 Nov 2026")
        #expect(
            SearchWords.period(after: time("2025-12-14T23:00:00Z"), before: time("2026-01-14T23:00:00Z"), in: berlin)
                == "15 Dec 2025 – 14 Jan 2026")
        // Yesterday: one day.
        #expect(
            SearchWords.period(after: time("2026-11-18T23:00:00Z"), before: time("2026-11-19T23:00:00Z"), in: berlin)
                == "19 Nov 2026")
        // Only one end: since, or before (the day itself not included).
        #expect(SearchWords.chip(.after(time("2026-02-28T23:00:00Z")), timeZone: berlin) == "Since 1 Mar 2026")
        #expect(SearchWords.chip(.before(time("2026-10-31T23:00:00Z")), timeZone: berlin) == "Before 1 Nov 2026")
        // Both, in order: one chip; out of order, two.
        let after = time("2026-09-30T22:00:00Z")
        let before = time("2026-10-31T23:00:00Z")
        #expect(
            SearchChip.chips(for: SearchFilters(from: "hetzner", after: after, before: before))
                == [.from("hetzner"), .period(after: after, before: before)])
        #expect(
            SearchChip.chips(for: SearchFilters(after: before, before: after))
                == [.after(before), .before(after)])
    }

    // MARK: What each outcome says

    @Test func eachOutcomeHasItsQuietLine() {
        func note(_ outcome: SearchAskOutcome) -> (String, Bool)? {
            SearchWords.askNote(outcome).map { ($0.words, $0.offersSettings) }
        }
        // Understood: the chips say it.
        #expect(note(.understood) == nil)
        #expect(note(.searchedAsTyped)! == ("Searched as typed", false))
        #expect(note(.aiNotSetUp)! == ("Asking needs your server's AI, so this was searched as typed.", true))
        #expect(
            note(.aiDidNotAnswer(.outOfCredit, detail: "Your AI account is out of\ncredit."))!
                == ("Your AI account is out of credit.", false))
        #expect(
            note(.aiDidNotAnswer(.paused, detail: nil))!
                == ("The AI didn't answer, so this was searched as typed.", false))
        #expect(
            note(.tooMany(seconds: 40))!
                == ("Asked often just now; try again shortly. This was searched as typed.", false))
        #expect(
            note(.refused("A sentence is at most 200 characters"))!
                == ("A sentence is at most 200 characters", false))
        #expect(note(.failed("Can't reach your server."))! == ("Can't reach your server.", false))
        #expect(SearchWords.aiSettings == "AI settings…")
    }

    @Test func theAISettingsOpenTheSettingsStackOnTheirTab() {
        var nav = Navigation(place: .tab(.receipts))
        nav.press(.search)
        nav.openSettings(.ai)
        // Settings is a stack: no way back; ⌘K opens search again, over it.
        #expect(nav.place == .settings && nav.settingsTab == .ai && nav.destination == .settings)
        nav.openSearch()
        #expect(nav.place == .search && nav.searchReturnTitle == "Settings")
    }
}
