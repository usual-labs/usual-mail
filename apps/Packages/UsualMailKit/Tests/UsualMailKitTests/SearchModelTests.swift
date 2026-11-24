import Foundation
import Testing

@testable import UsualMailKit

/// The search page's model without a view: the pause while typing, the newest answer only, chips, people and paging.
@MainActor
struct SearchModelTests {
    @Test func typingWaitsForAPauseAndCancelsTheWaitBefore() async throws {
        let service = FakeSearch()
        let sleeper = Sleeper()
        let model = searchModel(service, sleeper: sleeper)
        model.text = "i"
        await settle()
        // One character: nothing to search, nothing waited for.
        #expect(model.phase == .idle && sleeper.asked.isEmpty && service.queries.isEmpty)
        model.text = "in"
        await settle()
        #expect(model.phase == .searching && sleeper.asked == [.milliseconds(150)] && sleeper.waiting == 1)
        model.text = "inv"
        await settle()
        // The wait before was cancelled; only the newest waits.
        #expect(sleeper.asked.count == 2 && sleeper.waiting == 1 && service.queries.isEmpty)
        sleeper.release()
        await model.running?.value
        #expect(service.texts == ["inv"] && model.phase == .answered)
        #expect(service.queries.first?.timeZone == "Europe/Berlin")
    }

    @Test func onlyTheNewestAnswerShows() async throws {
        let late = Gate()
        let service = FakeSearch { query in
            if query.text == "in" { await late.wait() }
            return SearchResult(items: [SearchHit(thread: searchThread("for-\(query.text ?? "")"))])
        }
        let model = searchModel(service)
        model.text = "in"
        await settle()
        #expect(service.texts == ["in"])
        model.text = "inv"
        await model.running?.value
        #expect(model.hits.map(\.id) == ["for-inv"])
        // The answer for "in" comes last, and is dropped.
        await late.open()
        await settle()
        #expect(model.hits.map(\.id) == ["for-inv"] && model.phase == .answered)
    }

    @Test func emptyingTheFieldShowsTheHintAgain() async throws {
        let service = FakeSearch { _ in SearchResult(items: [SearchHit(thread: searchThread("thr_1"))]) }
        let model = searchModel(service)
        model.text = "renewal"
        await model.running?.value
        #expect(model.hits.count == 1 && model.hasQuery)
        model.text = ""
        #expect(model.phase == .idle && model.hits.isEmpty && model.understood == nil && !model.hasQuery)
        // An answer of nothing reads as such.
        service.answer = { _ in SearchResult(items: []) }
        model.text = "zzz"
        await model.running?.value
        #expect(model.phase == .answered && model.hits.isEmpty)
    }

    @Test func kindsAndTheProfileSearchAtOnceAndFiltersAloneSearch() async throws {
        let sleeper = Sleeper()
        let service = FakeSearch()
        let model = searchModel(service, sleeper: sleeper)
        model.toggle(.category(.receipt))
        model.toggle(.done)
        await model.running?.value
        // A chip searches without the typing pause; filters alone are a search.
        #expect(sleeper.asked.isEmpty)
        #expect(service.queries.last?.filters == SearchFilters(kinds: [.category(.receipt), .done]))
        #expect(service.queries.last?.text == nil)
        model.scope = "inb_personal"
        await model.running?.value
        #expect(service.queries.last?.filters.inboxIds == ["inb_personal"])
        model.toggle(.done)
        await model.running?.value
        #expect(service.queries.last?.filters.kinds == [.category(.receipt)])
        model.toggle(.category(.receipt))
        #expect(model.phase == .idle && model.filters.kinds == nil)
        #expect(service.queries.count == 3)
    }

    @Test func aFinishedOperatorBecomesAChipWithoutAskingAgain() async throws {
        let service = FakeSearch { query in
            let text = query.text ?? ""
            let from = text.contains("from:dana") || query.filters.from == "dana"
            return SearchResult(
                items: [SearchHit(thread: searchThread("thr_1"))],
                understood: SearchUnderstood(
                    filters: SearchFilters(from: from ? "dana" : nil), text: from ? "renewal" : text))
        }
        let model = searchModel(service)
        // Still being typed: the operator stays in the field, and shows as a chip from what was understood.
        model.text = "renewal from:dana"
        await model.running?.value
        #expect(service.texts == ["renewal from:dana"])
        #expect(model.text == "renewal from:dana" && model.filters.from == nil)
        #expect(model.chips == [.from("dana")])
        // Finished (a space after it): it moves into the chip, and the query meaning the same isn't asked again.
        model.text = "from:dana renewal"
        await model.running?.value
        #expect(service.texts == ["renewal from:dana", "from:dana renewal"])
        #expect(model.text == "renewal" && model.filters.from == "dana" && model.chips == [.from("dana")])
        await settle()
        #expect(service.queries.count == 2)
        // Its ×: the filter goes, and the search runs again without it.
        model.remove(.from("dana"))
        await model.running?.value
        #expect(model.filters.from == nil && model.chips.isEmpty)
        #expect(service.queries.last?.text == "renewal" && service.queries.last?.filters.from == nil)
    }

    @Test func removingATypedChipTakesItOutOfTheField() async throws {
        let service = FakeSearch { query in
            let has = (query.text ?? "").contains("has:attachment")
            return SearchResult(
                items: [], understood: SearchUnderstood(filters: SearchFilters(hasAttachment: has ? true : nil)))
        }
        let model = searchModel(service)
        model.text = "renewal has:attachment"
        await model.running?.value
        #expect(model.chips == [.hasAttachment(true)])
        model.remove(.hasAttachment(true))
        await model.running?.value
        #expect(model.text == "renewal ")
        #expect(service.queries.last?.text == "renewal" && model.chips.isEmpty)
    }

    @Test func aPersonShowsEverythingFromThem() async throws {
        let dana = SearchPerson(
            email: "dana@lumen.example", name: "Dana Whitfield", threads: 4, lastMessageAt: time("2026-11-16T08:40:00Z")
        )
        let service = FakeSearch { query in
            SearchResult(
                items: [], understood: SearchUnderstood(filters: query.filters, text: query.text ?? ""),
                people: query.text == nil ? nil : [dana])
        }
        let model = searchModel(service)
        model.text = "dana"
        await model.running?.value
        #expect(model.people == [dana])
        model.choose(dana)
        await model.running?.value
        // The `from` filter with their address, instead of the text that found them.
        #expect(model.text.isEmpty && model.filters.from == "dana@lumen.example" && model.chosenPerson == dana)
        #expect(
            service.queries.last == SearchQuery(filters: SearchFilters(from: dana.email), timeZone: "Europe/Berlin"))
        #expect(model.chips == [.from("dana@lumen.example")] && model.people.isEmpty)
        // Esc's first press clears it all; nothing is left to search.
        model.clear()
        #expect(
            !model.hasQuery && model.phase == .idle && model.chosenPerson == nil && model.filters == SearchFilters())
    }

    @Test func furtherPagesFollowTheCursor() async throws {
        let service = FakeSearch { query in
            switch query.cursor {
            case nil:
                SearchResult(
                    items: [SearchHit(thread: searchThread("a")), SearchHit(thread: searchThread("b"))],
                    nextCursor: "c2")
            default:
                // A thread already shown isn't shown twice.
                SearchResult(items: [SearchHit(thread: searchThread("b")), SearchHit(thread: searchThread("c"))])
            }
        }
        let model = searchModel(service)
        model.text = "report"
        await model.running?.value
        #expect(model.nextCursor == "c2")
        await model.loadMore()?.value
        #expect(service.queries.last == SearchQuery(text: "report", timeZone: "Europe/Berlin", cursor: "c2"))
        #expect(model.hits.map(\.id) == ["a", "b", "c"] && model.nextCursor == nil && !model.isLoadingMore)
        // The last page: nothing more to load.
        #expect(model.loadMore() == nil)
        #expect(service.queries.count == 2)
    }

    @Test func aLatePageOfAnOldQueryIsDropped() async throws {
        let slow = Gate()
        let service = FakeSearch { query in
            if query.cursor != nil { await slow.wait() }
            return SearchResult(items: [SearchHit(thread: searchThread("\(query.text ?? "")-1"))], nextCursor: "c2")
        }
        let model = searchModel(service)
        model.text = "report"
        await model.running?.value
        let paging = model.loadMore()
        model.text = "invoice"
        await model.running?.value
        await slow.open()
        await paging?.value
        #expect(model.hits.map(\.id) == ["invoice-1"] && !model.isLoadingMore)
    }

    @Test func comingBackAsksAgainKeepingWhatShows() async throws {
        let service = FakeSearch()
        // Done the first time; moved to the inbox while it was read.
        service.answer = { [unowned service] _ in
            SearchResult(items: [SearchHit(thread: searchThread("thr_1", done: service.queries.count == 1))])
        }
        let model = searchModel(service)
        model.text = "renewal"
        await model.running?.value
        #expect(model.hits.first?.thread.done == true)
        model.refresh()
        #expect(model.hits.count == 1)
        await model.running?.value
        // Moved to the inbox while it was read.
        #expect(model.hits.first?.thread.done == false && service.queries.count == 2)
    }

    @Test func aFailureIsSaidInWords() async throws {
        let service = FakeSearch { _ in throw APIError.unreachable("This device is offline.") }
        let model = searchModel(service)
        model.text = "renewal"
        await model.running?.value
        #expect(model.phase == .failed("Can't reach your server. This device is offline."))
    }
}
