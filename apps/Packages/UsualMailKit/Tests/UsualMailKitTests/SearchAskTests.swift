import Foundation
import Testing

@testable import UsualMailKit

/// Asking search in a sentence (docs/contract-search.md, "Asking in a sentence"): the answer's shape as the server sends
/// it, the request, and the sample's five sentences, which the sample mode answers. The model is in
/// SearchAskModelTests.swift.
@MainActor
struct SearchAskTests {
    static let found = #"""
        {
          "understood": {"kinds": ["invoice"], "from": "hetzner", "inboxIds": ["inb_northwind"],
                         "after": "2026-09-30T22:00:00Z", "before": "2026-10-31T23:00:00Z",
                         "text": "over 100 euros", "exclude": ["draft"]},
          "text": "over 100 euros -draft",
          "found": true,
          "ai": "working"
        }
        """#

    // MARK: The answer

    @Test func anAnswerCarriesWhatWasUnderstoodTheTextAndTheAIsState() throws {
        let answer = try MailJSON.decoder().decode(SearchAskResult.self, from: Data(Self.found.utf8))
        #expect(
            answer.understood.filters
                == SearchFilters(
                    inboxIds: ["inb_northwind"], kinds: [.category(.invoice)], from: "hetzner",
                    after: time("2026-09-30T22:00:00Z"), before: time("2026-10-31T23:00:00Z")))
        // An amount has no filter: it stays in the text, as written.
        #expect(answer.understood.text == "over 100 euros" && answer.understood.exclude == ["draft"])
        #expect(answer.text == "over 100 euros -draft" && answer.found && answer.ai == .working)
        #expect(answer.detail == nil)
        // Written back the same: no detail when none came.
        #expect(try encodedJSON(answer) == json(Self.found))
    }

    @Test func everyAIStateDecodesWithItsDetailAndTheSentenceAsTyped() throws {
        let states: [(String, AiState)] = [
            ("not_set_up", .notSetUp), ("paused", .paused), ("key_refused", .keyRefused),
            ("model_not_found", .modelNotFound), ("out_of_credit", .outOfCredit), ("unavailable", .unavailable),
            ("thinking", .unknown("thinking")),
        ]
        for (raw, state) in states {
            let text = #"""
                {"understood": {"from": "anna", "text": "invoices"}, "text": "invoices", "found": false,
                 "ai": "\#(raw)", "detail": "Why, in words."}
                """#
            let answer = try MailJSON.decoder().decode(SearchAskResult.self, from: Data(text.utf8))
            #expect(answer.ai == state && !answer.found && answer.detail == "Why, in words.")
            // The sentence as typed, its own operator (`from:anna`) included.
            #expect(answer.understood == SearchUnderstood(filters: SearchFilters(from: "anna"), text: "invoices"))
            #expect(try encodedJSON(answer) == json(text))
        }
        // Working, and nothing understood: found is false, no detail.
        let nothing = try MailJSON.decoder().decode(
            SearchAskResult.self,
            from: Data(
                #"{"understood": {"text": "dinner on saturday"}, "text": "dinner on saturday", "found": false, "ai": "working"}"#
                    .utf8))
        #expect(nothing.ai == .working && !nothing.found && nothing.detail == nil)
    }

    // MARK: The request

    @Test func askIsAPostOfTheSentenceTheProfilesInboxAndTheTimeZone() async throws {
        let answer = try MailJSON.decoder().decode(SearchAskResult.self, from: Data(Self.found.utf8))
        let transport = StubTransport { _ in .json(answer) }
        let client = APIClient(server: testServer, token: "t", transport: transport)
        let result = try await client.askSearch(
            SearchAskInput(question: "invoices from Hetzner", inboxIds: ["inb_northwind"], tz: "Europe/Berlin"))
        #expect(result == answer)
        let request = try #require(transport.lastRequest)
        #expect(request.httpMethod == "POST" && request.pathAndQuery == "/v1/search/ask")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(
            request.jsonBody
                == json(#"{"question": "invoices from Hetzner", "inboxIds": ["inb_northwind"], "tz": "Europe/Berlin"}"#)
        )
        // Every inbox: no inboxIds at all.
        _ = try await client.askSearch(SearchAskInput(question: "invoices", tz: "UTC"))
        #expect(transport.lastRequest?.jsonBody == json(#"{"question": "invoices", "tz": "UTC"}"#))
    }

    @Test func tooManySentencesSayHowLongToWait() async throws {
        let transport = StubTransport { _ in
            var reply = StubReply.error("rate_limited", "Too many sentences", status: 429)
            reply.headers["Retry-After"] = "40"
            return reply
        }
        let client = APIClient(server: testServer, token: "t", transport: transport)
        do {
            _ = try await client.askSearch(SearchAskInput(question: "invoices", tz: "UTC"))
            Issue.record("Expected rate_limited")
        } catch let error as APIError {
            #expect(error.code == .rateLimited && error.retryAfter == 40)
        }
    }

    @Test func aSentenceIsOneLineOfOneTo200CharactersAsTheServerCountsThem() {
        #expect(
            SearchAskInput.oneLine("  invoices from\n\tHetzner   last month ") == "invoices from Hetzner last month")
        #expect(!SearchAskInput.accepts("") && SearchAskInput.accepts("x"))
        #expect(SearchAskInput.accepts(String(repeating: "a", count: 200)))
        #expect(!SearchAskInput.accepts(String(repeating: "a", count: 201)))
        // UTF-16 units, as the server counts: an emoji is two.
        #expect(!SearchAskInput.accepts(String(repeating: "a", count: 199) + "🙂"))
    }

    // MARK: The sample

    @Test func theSamplesFiveSentencesAndTheirAnswers() throws {
        let asks = try SampleData.load().searchAsks
        #expect(
            asks.map(\.question) == [
                "the mail where Dana sent the contract pdf", "invoices from Kestrel this month",
                "unread newsletters this week", "receipts over 100 euros since March", "dinner on saturday",
            ])
        #expect(asks.allSatisfy { $0.tz == "Europe/Berlin" && $0.answer.ai == .working && $0.answer.detail == nil })
        #expect(asks.map(\.answer.found) == [true, true, true, true, false])
        #expect(asks.map(\.answer.text) == ["contract", "", "", "over 100 euros", "dinner on saturday"])
        #expect(asks[0].answer.understood.filters == SearchFilters(from: "Dana", hasAttachment: true))
        #expect(
            asks[1].answer.understood.filters
                == SearchFilters(kinds: [.category(.invoice)], from: "Kestrel", after: time("2026-10-31T23:00:00Z")))
        #expect(
            asks[2].answer.understood.filters
                == SearchFilters(
                    kinds: [.category(.newsletter)], after: time("2026-11-15T23:00:00Z"), unread: true))
        // The amount stays in the text; "since March" is a day in Berlin.
        #expect(
            asks[3].answer.understood
                == SearchUnderstood(
                    filters: SearchFilters(kinds: [.category(.receipt)], after: time("2026-02-28T23:00:00Z")),
                    text: "over 100 euros"))
        #expect(asks[4].answer.understood == SearchUnderstood(text: "dinner on saturday"))
    }

    @Test func theSampleModeAnswersItsOwnSentencesAndSearchesAnyOtherAsTyped() async throws {
        let sample = SampleData.bundled
        let store = try await MailStore.sample()
        for ask in sample.searchAsks {
            #expect(try await store.askSearch(SearchAskInput(question: ask.question, tz: ask.tz)) == ask.answer)
        }
        // The same words, case and spacing aside.
        let shouted = try await store.askSearch(SearchAskInput(question: "  UNREAD newsletters\nthis week "))
        #expect(shouted == sample.searchAsks[2].answer)
        // Any other: searched as typed, saying that asking needs a server.
        let other = try await store.askSearch(SearchAskInput(question: "mail from  my landlord", tz: "UTC"))
        #expect(
            other
                == SearchAskResult(
                    understood: SearchUnderstood(text: "mail from my landlord"), text: "mail from my landlord",
                    found: false, ai: .unavailable,
                    detail: "Asking in a sentence needs your server, so this was searched as typed."))
        #expect(store.problem == nil)
    }

    @Test func theSampleSearchHoldsTheDatesAnAnswerGives() async throws {
        let store = try await MailStore.sample()
        let since = time("2026-11-15T23:00:00Z")
        let week = try await store.search(
            SearchQuery(filters: SearchFilters(kinds: [.category(.newsletter)], after: since, unread: true)))
        #expect(!week.items.isEmpty)
        #expect(week.items.allSatisfy { $0.thread.lastMessageAt >= since && $0.thread.unread })
        #expect(week.understood.filters.after == since)
        let all = try await store.search(SearchQuery(filters: SearchFilters(kinds: [.category(.newsletter)])))
        let before = try await store.search(
            SearchQuery(filters: SearchFilters(kinds: [.category(.newsletter)], before: since)))
        // `before` is exclusive; together the two halves are every newsletter.
        #expect(before.items.allSatisfy { $0.thread.lastMessageAt < since })
        let unreadOrNot = try await store.search(
            SearchQuery(filters: SearchFilters(kinds: [.category(.newsletter)], after: since)))
        #expect(before.items.count + unreadOrNot.items.count == all.items.count)
    }
}
