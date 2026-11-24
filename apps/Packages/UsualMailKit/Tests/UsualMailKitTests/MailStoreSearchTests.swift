import Foundation
import Testing

@testable import UsualMailKit

/// Search through the store: the server's answers as they come, older mail brought in kept in the copy, and failures
/// left to the search page to word (only a lost connection or token shows elsewhere).
@MainActor
struct MailStoreSearchTests {
    @Test func searchAsksTheServerAndFindsDoneThreadsToo() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        let found = try await store.search(SearchQuery(text: "lumen", timeZone: "Europe/Berlin"))
        // thr_13 is done; search keeps it. Lumen Outdoor's refund (thr_17) by its sender's name. Newest first.
        #expect(found.items.map(\.id) == ["thr_14", "thr_1", "thr_13", "thr_17", "thr_16"])
        #expect(found.items.allSatisfy { $0.match == nil } && found.nextCursor == nil)
        #expect(found.understood.text == "lumen")
        #expect(server.requests.last?.pathAndQuery == "/v1/search?q=lumen&tz=Europe%2FBerlin")
        let inOne = try await store.search(
            SearchQuery(text: "renewal", filters: SearchFilters(inboxIds: ["inb_harbor"])))
        #expect(server.requests.last?.pathAndQuery == "/v1/search?q=renewal&inboxIds=inb_harbor")
        #expect(inOne.items.map(\.id) == ["thr_9"])
    }

    @Test func furtherPagesLoadFromTheCursor() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        // ".example" is in every participant's address: all 28 threads (the three blocked senders' done ones since
        // 2026-11-20 too), six pages of five.
        var pages: [SearchResult] = []
        var cursor: String?
        repeat {
            let page = try await store.search(SearchQuery(text: ".example", cursor: cursor, limit: 5))
            pages.append(page)
            cursor = page.nextCursor
        } while cursor != nil
        #expect(pages.map(\.items.count) == [5, 5, 5, 5, 5, 3])
        let ids = pages.flatMap(\.items).map(\.id)
        #expect(ids.count == 28 && Set(ids).count == 28)
        #expect(server.requests[1].pathAndQuery == "/v1/search?q=.example&cursor=page-5&limit=5")
    }

    @Test func searchWithoutTheServerSaysSoQuietly() async throws {
        let store = MailStore(
            client: APIClient(
                server: testServer, token: "t",
                transport: StubTransport { _ in throw URLError(.notConnectedToInternet) }),
            local: try await LocalStore.sample(), clock: { SampleData.bundled.now })
        await #expect(throws: APIError.self) { try await store.search(SearchQuery(text: "renewal")) }
        #expect(store.problem == nil)
        guard case .offline = store.connection else {
            Issue.record("Expected offline, got \(store.connection)")
            return
        }
    }

    @Test func aRefusalIsTheSearchPagesToWord() async throws {
        let store = MailStore(
            client: APIClient(
                server: testServer, token: "t",
                transport: StubTransport { _ in .error("invalid", "Unknown time zone", status: 400) }),
            local: try await LocalStore.sample(), clock: { SampleData.bundled.now })
        await #expect(throws: APIError.self) { try await store.searchRemote(SearchQuery(text: "lease")) }
        #expect(store.problem == nil)
    }

    @Test func openingOlderMailKeepsItInTheCopyDoneWhenArchivedThere() async throws {
        let older = MailThread(
            id: "thr_old", inboxId: "inb_northwind", subject: "Contract renewal for 2026",
            participants: [Address(name: "Dana Whitfield", email: "dana@lumen.example")],
            lastMessageAt: time("2025-11-12T14:02:00Z"), messageCount: 2, category: .conversation, done: true,
            version: 1)
        let message = Message(
            id: "msg_old", threadId: "thr_old", inboxId: "inb_northwind",
            from: Address(name: "Dana Whitfield", email: "dana@lumen.example"), date: older.lastMessageAt,
            subject: older.subject, text: "Thanks Dana, countersigned and filed.")
        let detail = ThreadDetail(thread: older, messages: [message], drafts: [])
        let transport = StubTransport { request in
            request.pathAndQuery == "/v1/search/remote/gm%3Aabc/open"
                ? .json(detail) : .error("not_found", "No", status: 404)
        }
        let local = try await LocalStore.sample()
        let store = MailStore(
            client: APIClient(server: testServer, token: "t", transport: transport), local: local,
            clock: { SampleData.bundled.now })
        await store.loadFromDisk()
        let opened = try await store.openRemote(id: "gm:abc")
        #expect(opened.thread.id == "thr_old" && opened.thread.done)
        #expect(transport.lastRequest?.httpMethod == "POST")
        #expect(transport.lastRequest?.pathAndQuery == "/v1/search/remote/gm%3Aabc/open")
        // Kept, so the mail page shows it; done, so no list holds it.
        #expect(try await local.detail(threadId: "thr_old")?.messages.map(\.id) == ["msg_old"])
        #expect(store.lists.thread(id: "thr_old") == nil)
        await store.open(threadID: "thr_old", markingRead: false)
        #expect(store.openThread?.thread.subject == "Contract renewal for 2026")
        // An id the mailbox no longer has.
        await #expect(throws: APIError.self) { try await store.openRemote(id: "gm:gone") }
    }
}
