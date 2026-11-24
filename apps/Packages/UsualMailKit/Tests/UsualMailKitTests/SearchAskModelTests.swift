import Foundation
import Testing

@testable import UsualMailKit

/// The search page's Ask without a view: offered for a sentence of 1 to 200 characters, sent only on the explicit
/// action, cancelled by typing, only the newest answer shown; an answer shown as text and chips, then one ordinary
/// search; and what each state of the answer, or of its failure, leads to.
@MainActor
struct SearchAskModelTests {
    private let kestrel = SampleData.bundled.searchAsks[1]

    private func found(from: String) -> SearchAskResult {
        SearchAskResult(
            understood: SearchUnderstood(filters: SearchFilters(from: from), text: "mail"), text: "mail", found: true,
            ai: .working)
    }

    // MARK: The control

    @Test func askIsOfferedForASentenceOfOneTo200Characters() async {
        let service = FakeSearch()
        let model = searchModel(service)
        #expect(!model.canAsk)
        model.text = "  \n "
        #expect(!model.canAsk)
        model.text = "x"
        #expect(model.canAsk)
        model.text = String(repeating: "a", count: 200)
        #expect(model.canAsk)
        model.text = String(repeating: "a", count: 201)
        #expect(!model.canAsk && model.ask() == nil)
        // Spaces the server folds into one don't count.
        model.text = String(repeating: "a ", count: 100) + "   \n"
        #expect(model.canAsk)
        model.text = ""
        #expect(model.ask() == nil && service.asks.isEmpty)
    }

    @Test func typingNeverAsksOnlyTheExplicitActionDoes() async {
        let service = FakeSearch()
        let model = searchModel(service)
        for typed in ["in", "invoices", "invoices from Kestrel", "invoices from Kestrel this month"] {
            model.text = typed
            await model.running?.value
        }
        #expect(service.asks.isEmpty && service.texts.count == 4)
        await model.ask()?.value
        #expect(service.asks.map(\.question) == ["invoices from Kestrel this month"])
    }

    @Test func theRequestIsTheSentenceOnOneLineTheProfileAndTheTimeZone() async {
        let service = FakeSearch()
        let model = searchModel(service)
        model.scope = "inb_personal"
        model.text = "  invoices from\nKestrel   this month "
        await model.ask()?.value
        #expect(
            service.asks == [
                SearchAskInput(
                    question: "invoices from Kestrel this month", inboxIds: ["inb_personal"], tz: "Europe/Berlin")
            ])
        // Every inbox: none named.
        model.scope = nil
        await model.ask()?.value
        #expect(service.asks.last?.inboxIds == nil)
    }

    @Test func typingCancelsASentenceOnItsWay() async {
        let held = Gate()
        let service = FakeSearch()
        service.askAnswer = { [kestrel] _ in
            await held.wait()
            return kestrel.answer
        }
        let model = searchModel(service)
        model.text = "invoices from Kestrel"
        await model.running?.value
        let asking = model.ask()
        await settle()
        // On its way: progress shows, Ask can't be pressed again, the field stays editable.
        #expect(model.isAsking && !model.canAsk && service.asks.count == 1)
        // Coming back to the page meanwhile doesn't search over it.
        model.refresh()
        #expect(model.isAsking && service.queries.count == 1)
        // A space alone is typing too: the sentence is cancelled and what is typed is searched.
        model.text = "invoices from Kestrel "
        #expect(!model.isAsking && model.canAsk)
        await model.running?.value
        #expect(service.texts == ["invoices from Kestrel", "invoices from Kestrel"] && model.phase == .answered)
        // Its answer, coming after, is dropped.
        await held.open()
        await asking?.value
        await settle()
        #expect(model.text == "invoices from Kestrel " && model.filters == SearchFilters())
        #expect(model.askOutcome == nil && service.queries.count == 2)
    }

    @Test func onlyTheNewestAnswerShows() async {
        let first = Gate()
        let service = FakeSearch()
        service.askAnswer = { [self] input in
            if input.question == "mail from Dana" {
                await first.wait()
                return found(from: "Dana")
            }
            return found(from: "Kestrel")
        }
        let model = searchModel(service)
        model.text = "mail from Dana"
        let older = model.ask()
        await settle()
        model.text = "mail from Kestrel"
        await model.ask()?.value
        await model.running?.value
        #expect(model.filters.from == "Kestrel" && model.text == "mail")
        await first.open()
        await older?.value
        await settle()
        #expect(model.filters.from == "Kestrel" && model.chips == [.from("Kestrel")])
        #expect(service.asks.count == 2 && service.queries.last?.filters.from == "Kestrel")
    }

    // MARK: An answer

    @Test func anAnswerShowsAsTextAndChipsThenOneOrdinarySearch() async {
        let service = FakeSearch()
        service.askAnswer = { [kestrel] _ in kestrel.answer }
        let model = searchModel(service)
        model.scope = "inb_northwind"
        model.text = kestrel.question
        await model.running?.value
        let searched = service.queries.count
        await model.ask()?.value
        await model.running?.value
        // The answer's text in the field (nothing left here) and its filters as the chips typed operators produce.
        let after = time("2026-10-31T23:00:00Z")
        #expect(model.text == "" && model.askOutcome == .understood && model.phase == .answered)
        #expect(model.filters == SearchFilters(kinds: [.category(.invoice)], from: "Kestrel", after: after))
        #expect(model.chips == [.from("Kestrel"), .after(after)])
        // One normal search with those filters, in the profile.
        #expect(service.queries.count == searched + 1)
        #expect(
            service.queries.last
                == SearchQuery(
                    filters: SearchFilters(
                        inboxIds: ["inb_northwind"], kinds: [.category(.invoice)], from: "Kestrel", after: after),
                    timeZone: "Europe/Berlin"))
        // Removing a chip is an ordinary new search: nothing asked again.
        model.remove(.from("Kestrel"))
        await model.running?.value
        #expect(service.asks.count == 1 && service.queries.count == searched + 2)
        #expect(service.queries.last?.filters.from == nil && service.queries.last?.filters.after == after)
        #expect(model.askOutcome == nil)
    }

    @Test func aPeriodIsOneChipFromItsFirstDayUpToItsEnd() async {
        let after = time("2026-09-30T22:00:00Z")
        let before = time("2026-10-31T23:00:00Z")
        let service = FakeSearch()
        service.askAnswer = { _ in
            SearchAskResult(
                understood: SearchUnderstood(filters: SearchFilters(after: after, before: before), text: "invoices"),
                text: "invoices", found: true, ai: .working)
        }
        let model = searchModel(service)
        model.text = "invoices last month"
        await model.ask()?.value
        await model.running?.value
        #expect(model.chips == [.period(after: after, before: before)])
        #expect(SearchChip.period(after: after, before: before).keys == [.after, .before])
        // Its ×: both go, in one ordinary search.
        model.remove(.period(after: after, before: before))
        await model.running?.value
        #expect(model.filters == SearchFilters() && model.chips.isEmpty)
        #expect(service.queries.last == SearchQuery(text: "invoices", timeZone: "Europe/Berlin"))
        #expect(service.asks.count == 1)
    }

    @Test func anAmountStaysInTheText() async {
        let receipts = SampleData.bundled.searchAsks[3]
        let service = FakeSearch()
        service.askAnswer = { _ in receipts.answer }
        let model = searchModel(service)
        model.text = receipts.question
        await model.ask()?.value
        await model.running?.value
        #expect(model.text == "over 100 euros" && model.chips == [.after(time("2026-02-28T23:00:00Z"))])
        #expect(model.filters.kinds == [.category(.receipt)])
        #expect(service.queries.last?.text == "over 100 euros")
    }

    // MARK: Each state

    @Test func nothingUnderstoodSearchesTheSentenceAsTyped() async {
        let dinner = SampleData.bundled.searchAsks[4]
        let service = FakeSearch()
        service.askAnswer = { _ in dinner.answer }
        let model = searchModel(service)
        model.toggle(.done)
        model.text = dinner.question
        await model.ask()?.value
        await model.running?.value
        #expect(model.askOutcome == .searchedAsTyped && model.chips.isEmpty && model.filters == SearchFilters())
        #expect(service.queries.last == SearchQuery(text: "dinner on saturday", timeZone: "Europe/Berlin"))
    }

    @Test func theAIsStatesSearchAsTypedAndSayWhy() async {
        let service = FakeSearch()
        let model = searchModel(service)
        let sentence = "invoices from Kestrel"
        model.text = sentence
        // Not set up: the AI's settings are offered.
        service.askAnswer = { input in
            SearchAskResult(
                understood: SearchUnderstood(text: input.question), text: input.question, found: false,
                ai: .notSetUp, detail: "Add an AI key to use it.")
        }
        await model.ask()?.value
        await model.running?.value
        #expect(model.askOutcome == .aiNotSetUp && service.queries.last?.text == sentence)
        // Paused, refused, out of credit, unavailable: the server's detail.
        for state in [AiState.paused, .keyRefused, .modelNotFound, .outOfCredit, .unavailable] {
            service.askAnswer = { input in
                SearchAskResult(
                    understood: SearchUnderstood(text: input.question), text: input.question, found: false,
                    ai: state, detail: "Why \(state.rawValue).")
            }
            await model.ask()?.value
            await model.running?.value
            #expect(model.askOutcome == .aiDidNotAnswer(state, detail: "Why \(state.rawValue)."))
            #expect(model.text == sentence && service.queries.last?.text == sentence && model.phase == .answered)
        }
        #expect(service.asks.count == 6)
    }

    @Test func tooManySentencesSayTryAgainShortlySearchAsTypedAndWaitOutRetryAfter() async {
        let sleeper = Sleeper()
        let service = FakeSearch()
        service.askAnswer = { _ in
            throw APIError.server(code: .rateLimited, message: "Too many", status: 429, retryAfter: 40)
        }
        let model = searchModel(service, sleeper: sleeper)
        model.text = "invoices from Kestrel"
        await settle()
        await model.ask()?.value
        await model.running?.value
        await settle()
        #expect(model.askOutcome == .tooMany(seconds: 40) && sleeper.asked.last == .seconds(40))
        // What is typed is searched at once, as typed.
        #expect(service.texts == ["invoices from Kestrel"] && model.phase == .answered)
        #expect(model.askWaitsUntil == SampleData.bundled.now.addingTimeInterval(40) && !model.canAsk)
        sleeper.release()
        await settle()
        #expect(model.askWaitsUntil == nil && model.canAsk)
    }

    @Test func aRefusedSentenceAndAFailureAreSaidAndWhatIsTypedSearched() async {
        let service = FakeSearch()
        service.askAnswer = { _ in
            throw APIError.server(code: .invalid, message: "A sentence is at most 200 characters", status: 400)
        }
        let model = searchModel(service)
        model.text = "invoices from Kestrel"
        await model.running?.value
        await model.ask()?.value
        await model.running?.value
        #expect(model.askOutcome == .refused("A sentence is at most 200 characters"))
        #expect(service.texts == ["invoices from Kestrel", "invoices from Kestrel"])
        service.askAnswer = { _ in throw APIError.unreachable("This device is offline.") }
        await model.ask()?.value
        await model.running?.value
        #expect(model.askOutcome == .failed("Can't reach your server. This device is offline."))
        // The next change ends what was said.
        model.text = "invoices"
        #expect(model.askOutcome == nil)
    }

    @Test func askingTheSampleShowsItsChipsAndSearchesIt() async throws {
        let store = try await MailStore.sample()
        let model = SearchModel(
            service: store, sleep: { _ in }, timeZone: { "Europe/Berlin" }, clock: { SampleData.bundled.now })
        model.text = "the mail where Dana sent the contract pdf"
        await model.ask()?.value
        await model.running?.value
        #expect(model.text == "contract" && model.chips == [.from("Dana"), .hasAttachment(true)])
        #expect(model.askOutcome == .understood && model.hits.map(\.id) == ["thr_1"])
        // Any other sentence: searched as typed, with the sample's note.
        model.text = "dinner with Jonas"
        await model.ask()?.value
        await model.running?.value
        #expect(model.text == "dinner with Jonas" && model.chips.isEmpty)
        #expect(model.askOutcome == .aiDidNotAnswer(.unavailable, detail: SampleSearch.askNeedsServer))
    }
}
