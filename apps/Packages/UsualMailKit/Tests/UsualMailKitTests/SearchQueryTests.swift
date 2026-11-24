import Foundation
import Testing

@testable import UsualMailKit

/// What a search sends: the text as typed, the chips' filters and the profile as parameters, the time zone; and the
/// operators the page reads only to move finished ones into chips and to take one out (`SearchText`).
struct SearchQueryTests {
    @Test func theRoutesTakeTheQueryAsParameters() async throws {
        let transport = StubTransport { request in
            request.httpMethod == "POST"
                ? .json(ThreadDetail(thread: searchThread("thr_old", done: true), messages: [], drafts: []))
                : .raw(#"{"items": [], "understood": {"text": ""}, "inboxes": []}"#)
        }
        let client = APIClient(server: testServer, token: "t", transport: transport)
        let query = SearchQuery(
            text: "fish & chips + 50%",
            filters: SearchFilters(
                inboxIds: ["inb_northwind", "inb_harbor"], kinds: [.category(.receipt), .done],
                from: "dana@lumen.example", to: "hello", subject: "weekly report", hasAttachment: true,
                after: time("2026-10-31T23:00:00Z"), before: time("2026-11-15T23:00:00Z"), unread: false),
            timeZone: "Europe/Berlin", cursor: "c/2", limit: 20)
        _ = try await client.search(query)
        _ = try await client.searchRemote(SearchQuery(text: "contract", timeZone: "UTC"))
        let opened = try await client.openRemote(id: "gm:a/b")
        #expect(opened.thread.done)
        #expect(
            transport.requests.map(\.pathAndQuery) == [
                "/v1/search?q=fish%20%26%20chips%20%2B%2050%25&inboxIds=inb_northwind%2Cinb_harbor"
                    + "&kinds=receipt%2Cdone&from=dana%40lumen.example&to=hello&subject=weekly%20report"
                    + "&hasAttachment=true&unread=false&after=2026-10-31T23%3A00%3A00Z&before=2026-11-15T23%3A00%3A00Z"
                    + "&tz=Europe%2FBerlin&cursor=c%2F2&limit=20",
                "/v1/search/remote?q=contract&tz=UTC",
                "/v1/search/remote/gm%3Aa%2Fb/open",
            ])
        #expect(transport.requests.map(\.httpMethod) == ["GET", "GET", "POST"])
        #expect(transport.requests.allSatisfy { $0.httpBody == nil })
    }

    @Test func theTextGoesAsTypedFromTwoCharactersUpToTwoHundred() {
        let berlin = "Europe/Berlin"
        // One character alone isn't sent (a one-letter word matches only whole): nothing to search.
        #expect(SearchModel.query(text: " a ", filters: SearchFilters(), scope: nil, timeZone: berlin) == nil)
        #expect(SearchModel.query(text: "", filters: SearchFilters(), scope: "inb_harbor", timeZone: berlin) == nil)
        // Two characters start it, trimmed, with the time zone.
        #expect(
            SearchModel.query(text: " re ", filters: SearchFilters(), scope: nil, timeZone: berlin)
                == SearchQuery(text: "re", timeZone: berlin))
        // Typed operators are the server's to read: the text goes as typed.
        let typed = SearchModel.query(
            text: "from:dana before:2026/11/01 -draft \"for 2027\"", filters: SearchFilters(), scope: nil,
            timeZone: berlin)
        #expect(typed?.text == "from:dana before:2026/11/01 -draft \"for 2027\"" && typed?.filters == SearchFilters())
        // Filters alone search; one character beside them isn't sent. The profile is the scope.
        let receipts = SearchModel.query(
            text: "a", filters: SearchFilters(kinds: [.category(.receipt)]), scope: "inb_personal", timeZone: berlin)
        #expect(
            receipts
                == SearchQuery(
                    filters: SearchFilters(inboxIds: ["inb_personal"], kinds: [.category(.receipt)]), timeZone: berlin))
        #expect(receipts?.parameters.map { $0.0 } == ["inboxIds", "kinds", "tz"])
        // At most 200 characters are sent.
        let long = String(repeating: "word ", count: 60)
        let sent = SearchModel.query(text: long, filters: SearchFilters(), scope: nil, timeZone: berlin)
        #expect(sent?.parameters.first?.1.count == SearchQuery.maxText)
    }

    @Test func wordsPhrasesAndOperatorsAreReadAsTheServerReadsThem() {
        let tokens = SearchText.tokens(#"subject:"weekly report" -draft "for 2027" from:dana rech"#)
        #expect(tokens.map(\.value) == ["subject:\"weekly report\"", "draft", "for 2027", "from:dana", "rech"])
        #expect(tokens.map(\.negated) == [false, true, false, false, false])
        #expect(tokens.map(\.quoted) == [false, false, true, false, false])
        // Finished: followed by a space. The last word is still being typed.
        #expect(tokens.map(\.complete) == [true, true, true, true, false])
        #expect(tokens.map { SearchText.key(of: $0) } == [.subject, nil, nil, .from, nil])
        // Names in any case; Gmail's other names for dates; negation only for has: and is:.
        let keys = SearchText.tokens(
            "FROM:a has:attachment -has:attachment is:read older:2026/1/1 newer:x -from:b label:x"
        )
        .map { SearchText.key(of: $0) }
        #expect(keys == [.from, .hasAttachment, .hasAttachment, .unread, .before, .after, nil, nil])
    }

    @Test func aFinishedOperatorTheServerTookMovesIntoAChip() {
        let understood = SearchUnderstood(
            filters: SearchFilters(from: "dana", hasAttachment: true, before: time("2026-10-31T23:00:00Z")),
            text: "renewal before:soon", exclude: ["draft"])
        let settled = SearchText.settle(
            text: "from:dana renewal before:2026/11/01 before:soon -draft has:attachment",
            filters: SearchFilters(kinds: [.done]), understood: understood)
        // from: and before:2026/11/01 are finished and taken; before:soon is plain text; -draft a word left out;
        // has:attachment is still being typed, so it stays (its chip shows from what was understood).
        #expect(settled.text == "renewal before:soon -draft has:attachment")
        #expect(
            settled.filters
                == SearchFilters(kinds: [.done], from: "dana", before: time("2026-10-31T23:00:00Z")))
        // A repeated operator: the server takes the last; both go, the value is the server's.
        let twice = SearchText.settle(
            text: "from:a from:b x", filters: SearchFilters(),
            understood: SearchUnderstood(filters: SearchFilters(from: "b"), text: "x"))
        #expect(twice.text == "x" && twice.filters.from == "b")
        // Nothing understood: nothing moves.
        let plain = SearchText.settle(
            text: "from:dana x", filters: SearchFilters(), understood: SearchUnderstood(text: "from:dana x"))
        #expect(plain.text == "from:dana x" && plain.filters == SearchFilters())
    }

    @Test func removingAChipTakesItsOperatorOutOfTheText() {
        #expect(SearchText.removing(.hasAttachment, from: "renewal has:attachment") == "renewal ")
        #expect(SearchText.removing(.from, from: "from:a renewal FROM:b") == "renewal ")
        #expect(SearchText.removing(.subject, from: #"subject:"weekly report" x"#) == "x")
        #expect(SearchText.removing(.unread, from: "x") == "x")
    }

    @Test func chipsComeInAFixedOrder() {
        let filters = SearchFilters(
            kinds: [.done], from: "dana", subject: "renewal", hasAttachment: false,
            before: time("2026-11-01T00:00:00Z"),
            unread: true)
        #expect(
            SearchChip.chips(for: filters) == [
                .from("dana"), .subject("renewal"), .hasAttachment(false), .unread(true),
                .before(time("2026-11-01T00:00:00Z")),
            ])
    }
}
