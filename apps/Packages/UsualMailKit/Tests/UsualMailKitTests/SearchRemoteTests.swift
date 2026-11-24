import Foundation
import Testing

@testable import UsualMailKit

/// Older mail in the mailbox: only on the button, never as the person types; in the mailboxes that can be searched;
/// each inbox's answer; waiting when the server says too many were asked; opening one.
@MainActor
struct SearchRemoteTests {
    let inboxes = SampleData.bundled.inboxes  // Northwind is Gmail; Harbor & Pine and Personal are IMAP

    static let older = RemoteHit(
        id: "gm:older_contract", inboxId: "inb_northwind", subject: "Contract renewal for 2026",
        from: Address(name: "Dana Whitfield", email: "dana@lumen.example"), lastMessageAt: time("2025-11-12T14:02:00Z"),
        snippet: "Thanks Dana, countersigned and filed.", hasAttachments: true, messageCount: 2, archived: true)

    func answered(_ service: FakeSearch, text: String = "contract", scope: String? = nil) async -> SearchModel {
        let model = searchModel(service)
        model.inboxes = inboxes
        model.scope = scope
        model.text = text
        await model.running?.value
        return model
    }

    @Test func neverWhileTypingOnlyOnTheButton() async throws {
        let service = FakeSearch()
        let model = searchModel(service)
        model.inboxes = inboxes
        for text in ["co", "con", "contract", "contract 2026"] {
            model.text = text
            await model.running?.value
        }
        #expect(service.queries.count == 4 && service.remoteQueries.isEmpty)
        #expect(model.offersRemote && model.remote.status == .offered)
        // Nothing to search: no button.
        model.text = ""
        #expect(!model.offersRemote && model.searchRemote() == nil)
    }

    @Test func theButtonSearchesTheMailboxesThatCanBe() async throws {
        let service = FakeSearch()
        service.remoteAnswer = { _ in
            RemoteSearchResult(
                items: [Self.older], nextCursor: "r2", understood: SearchUnderstood(text: "contract"),
                inboxes: [RemoteInboxState(inboxId: "inb_northwind", state: .ok)])
        }
        let model = await answered(service)
        // Every inbox but the IMAP ones, which can't be searched: only Northwind's, by name.
        #expect(model.remoteScope == ["inb_northwind"])
        await model.searchRemote()?.value
        #expect(
            service.remoteQueries == [
                SearchQuery(
                    text: "contract", filters: SearchFilters(inboxIds: ["inb_northwind"]), timeZone: "Europe/Berlin")
            ])
        #expect(model.remote.status == .answered && model.remote.hits == [Self.older])
        #expect(model.remote.nextCursor == "r2")
        // More, on its own button.
        service.remoteAnswer = { _ in RemoteSearchResult(items: [Self.older]) }
        await model.loadMoreRemote()?.value
        #expect(service.remoteQueries.last?.cursor == "r2" && model.remote.hits.count == 1)
        #expect(model.remote.nextCursor == nil && model.loadMoreRemote() == nil)
        // A new query starts older mail over: the button again, nothing asked.
        model.text = "contract renewal"
        #expect(model.remote.status == .offered && model.remote.hits.isEmpty)
        await model.running?.value
        #expect(service.remoteQueries.count == 2)
    }

    @Test func aProfileWhoseMailboxCantBeSearchedHasNoButton() async throws {
        let service = FakeSearch()
        let model = await answered(service, scope: "inb_harbor")
        #expect(model.remoteScope.isEmpty && !model.offersRemote && model.searchRemote() == nil)
        // An inbox that answered `unsupported` is left out from then on.
        model.scope = "inb_northwind"
        await model.running?.value
        service.remoteAnswer = { _ in
            RemoteSearchResult(items: [], inboxes: [RemoteInboxState(inboxId: "inb_northwind", state: .unsupported)])
        }
        await model.searchRemote()?.value
        #expect(model.remote.status == .answered && !model.offersRemote)
        model.text = "contracts"
        await model.running?.value
        #expect(!model.offersRemote && service.remoteQueries.count == 1)
    }

    @Test func eachInboxsAnswerComesThroughAndOneFailingFailsNone() async throws {
        let states = [
            RemoteInboxState(inboxId: "inb_northwind", state: .ok),
            RemoteInboxState(inboxId: "inb_work", state: .needsSignIn, message: "Sign in with Google again."),
            RemoteInboxState(inboxId: "inb_side", state: .providerError, message: "Gmail is busy."),
            RemoteInboxState(inboxId: "inb_old", state: .paused),
        ]
        let service = FakeSearch()
        service.remoteAnswer = { _ in RemoteSearchResult(items: [Self.older], inboxes: states) }
        let model = await answered(service)
        await model.searchRemote()?.value
        #expect(model.remote.inboxes == states && model.remote.hits == [Self.older])
        // Try again: the same search.
        await model.searchRemote()?.value
        #expect(service.remoteQueries.count == 2 && service.remoteQueries[0] == service.remoteQueries[1])
        // A search failing as a whole says so, and offers it again.
        service.remoteAnswer = { _ in throw APIError.server(code: .internal, message: "Something broke.", status: 500) }
        await model.searchRemote()?.value
        #expect(model.remote.status == .failed("Something broke."))
    }

    @Test func tooManySearchesWaitForRetryAfter() async throws {
        let sleeper = Sleeper()
        let service = FakeSearch()
        service.remoteAnswer = { _ in
            throw APIError.server(code: .rateLimited, message: "Too many", status: 429, retryAfter: 40)
        }
        let model = searchModel(service, sleeper: sleeper)
        model.inboxes = inboxes
        model.toggle(.done)
        await model.running?.value
        await model.searchRemote()?.value
        let now = SampleData.bundled.now
        #expect(model.remoteWaitsUntil == now.addingTimeInterval(40) && model.remote.status == .offered)
        #expect(model.remoteWaits(at: now) && !model.remoteWaits(at: now.addingTimeInterval(40)))
        // While waiting, neither searching nor opening asks.
        #expect(model.searchRemote() == nil)
        #expect(await model.open(Self.older) == nil && service.opened.isEmpty)
        #expect(sleeper.asked == [.seconds(40)])
        sleeper.release()
        await settle()
        #expect(model.remoteWaitsUntil == nil)
        service.remoteAnswer = { _ in RemoteSearchResult(items: []) }
        await model.searchRemote()?.value
        #expect(service.remoteQueries.count == 2 && model.remote.status == .answered)
    }

    @Test func openingAHitBringsItsThreadIn() async throws {
        let service = FakeSearch()
        service.openAnswer = { id in
            ThreadDetail(thread: searchThread("thr_\(id.dropFirst(3))", done: true), messages: [], drafts: [])
        }
        // Waits are held, so the one below stays until the assertion.
        let model = searchModel(service, sleeper: Sleeper())
        #expect(await model.open(Self.older) == "thr_older_contract")
        #expect(service.opened == ["gm:older_contract"] && model.remote.opening == nil)
        // Gone from the mailbox meanwhile: said under it.
        service.openAnswer = { _ in throw APIError.server(code: .notFound, message: "Not found", status: 404) }
        #expect(await model.open(Self.older) == nil)
        #expect(model.remote.problems["gm:older_contract"] == "It's no longer in the mailbox.")
        // Too many: the wait, and its words.
        service.openAnswer = { _ in
            throw APIError.server(code: .rateLimited, message: "Too many", status: 429, retryAfter: nil)
        }
        #expect(await model.open(Self.older) == nil)
        #expect(model.remoteWaitsUntil == SampleData.bundled.now.addingTimeInterval(60))
        #expect(model.remote.problems["gm:older_contract"]?.hasPrefix("The server has had too many tries.") == true)
    }
}
