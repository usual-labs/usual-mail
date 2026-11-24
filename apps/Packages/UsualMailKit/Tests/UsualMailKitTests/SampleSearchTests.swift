import Foundation
import Testing

@testable import UsualMailKit

/// The sample mode's search (`-UsualMailSample YES`, no server): the sample itself read plainly, so the search page has
/// something to show; everything else stays offline.
@MainActor
struct SampleSearchTests {
    @Test func theTextFindsTheSamplesThreadsWithWhereTheyMatched() async throws {
        let store = try await MailStore.sample()
        let renewal = try await store.search(SearchQuery(text: "Renewal", timeZone: "UTC"))
        // Newest first; the lease's renewal by its subject alone.
        #expect(renewal.items.map(\.id) == ["thr_1", "thr_9"])
        let match = try #require(renewal.items[0].match)
        #expect(match.fields == [.subject, .summary, .attachments, .body])  // the signed PDF is named for it too
        #expect(match.subject == [SearchRun("Contract "), SearchRun("renewal", match: true), SearchRun(" for 2027")])
        // The excerpt from the first of body, summary, facts, attachments, people and sender that matched, the word
        // marked.
        #expect(match.excerpt?.field == .body)
        #expect(match.excerpt?.runs.first?.match == false)
        #expect(match.excerpt?.runs.filter(\.match).map { $0.text.lowercased() }.allSatisfy { $0 == "renewal" } == true)
        #expect(renewal.understood == SearchUnderstood(text: "Renewal") && renewal.people == [])
        #expect(renewal.items[1].match?.excerpt == nil)
    }

    @Test func peopleAndFiltersAsTheServerGivesThem() async throws {
        let store = try await MailStore.sample()
        let dana = try await store.search(SearchQuery(text: "dana"))
        #expect(dana.people?.map(\.email) == ["dana@lumen.example"])
        #expect(dana.people?.first?.name == "Dana Whitfield" && dana.people?.first?.threads == 1)
        // Everything from her: the `from` filter alone, no people.
        let from = try await store.search(SearchQuery(filters: SearchFilters(from: "dana@lumen.example")))
        #expect(from.items.map(\.id) == ["thr_1"] && from.people == nil && from.items[0].match == nil)
        // Archived mail, which only search finds; in one inbox.
        let done = try await store.search(SearchQuery(filters: SearchFilters(kinds: [.done])))
        #expect(done.items.map(\.id) == ["thr_3", "thr_26", "thr_28", "thr_13", "thr_27"])
        let harbor = try await store.search(
            SearchQuery(filters: SearchFilters(inboxIds: ["inb_harbor"], kinds: [.done])))
        #expect(harbor.items.map(\.id) == ["thr_28"])
        // Pages.
        let first = try await store.search(SearchQuery(filters: SearchFilters(kinds: [.done]), limit: 2))
        let second = try await store.search(
            SearchQuery(filters: SearchFilters(kinds: [.done]), cursor: first.nextCursor, limit: 2))
        #expect(first.items.map(\.id) == ["thr_3", "thr_26"] && second.items.map(\.id) == ["thr_28", "thr_13"])
    }

    @Test func olderMailAndEverythingElseStayOffline() async throws {
        let store = try await MailStore.sample()
        await #expect(throws: APIError.self) { try await store.searchRemote(SearchQuery(text: "contract")) }
        await #expect(throws: APIError.self) { try await store.openRemote(id: "gm:older_contract") }
        #expect(store.problem == nil)
    }

    @Test func aLongMatchIsCutAroundTheWord() {
        let text =
            String(repeating: "lorem ipsum ", count: 20) + "invoice " + String(repeating: "dolor sit ", count: 40)
        let runs = SampleSearch.excerpt(text, terms: ["inv"])
        let joined = runs.map(\.text).joined()
        #expect(joined.hasPrefix("…") && joined.hasSuffix("…") && joined.count <= 202)
        #expect(runs.filter(\.match).map(\.text) == ["invoice"])
        #expect(SampleSearch.words("Müller-Straße e-mail") == ["muller", "strasse", "e", "mail"])
        #expect(SampleSearch.has("e", in: "e-mail") && !SampleSearch.has("m", in: "e-mail"))
    }
}
