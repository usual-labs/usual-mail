import Foundation
import Synchronization
import Testing

@testable import UsualMailKit

/// The blocked senders (docs/contract.md, "Blocked senders"): the sample's three, the routes, `sender.changed`, and
/// unblocking with its undo.
struct BlockedSenderModelTests {
    let sample = SampleData.bundled

    @Test func theSamplesThreeDecodeNewestBlockFirst() throws {
        let senders = sample.blockedSenders
        #expect(senders.count == 3)
        // One blocked by an agent through an approved proposal, with 1 message since.
        #expect(
            senders[0]
                == BlockedSender(
                    inboxId: "inb_harbor", address: "outreach@linkboost.example", name: "Linkboost",
                    blockedAt: time("2026-11-13T12:00:00Z"),
                    blockedBy: .agent(agentId: "dev_agent_1", name: "Claude Code"),
                    messagesSinceBlocked: 1, lastMessageAt: time("2026-11-15T06:10:00Z")))
        // One by the person with 3, one by the person with 0.
        #expect(senders[1].blockedBy == .person(deviceId: "dev_mac_1") && senders[1].messagesSinceBlocked == 3)
        #expect(senders[1].name == "BrightBuy Deals" && senders[1].blockedAt == time("2026-11-12T08:00:00Z"))
        #expect(senders[2].blockedBy == .person(deviceId: "dev_mac_1") && senders[2].messagesSinceBlocked == 0)
        #expect(senders[2].address == "sales@growthpipe.example")
        // The list keeps the server's order.
        #expect(BlockedSenderList(senders.reversed()).items == senders)
    }

    @Test func aSenderIsTheirInboxAndAddressWithoutCase() {
        let at = time("2026-11-10T10:00:00Z")
        let a = BlockedSender(inboxId: "inb_a", address: "Deals@Shop.example", blockedAt: at)
        let b = BlockedSender(inboxId: "inb_a", address: "deals@shop.example", blockedAt: at, messagesSinceBlocked: 2)
        let other = BlockedSender(inboxId: "inb_b", address: "deals@shop.example", blockedAt: at)
        #expect(a.id == b.id && a.id != other.id)
        // One row per sender: the later item wins.
        #expect(BlockedSenderList([a, b, other]).items.map(\.messagesSinceBlocked) == [0, 2])
    }

    @Test func theEventDecodesAndEncodesAsCoreHasIt() throws {
        let blocked = try MailJSON.decoder().decode(
            MailEvent.self,
            from: Data(
                #"""
                {"type":"sender.changed","inboxId":"inb_harbor","address":"outreach@linkboost.example","blocked":true,
                 "sender":{"inboxId":"inb_harbor","address":"outreach@linkboost.example","name":"Linkboost",
                 "blockedAt":"2026-11-13T12:00:00Z","messagesSinceBlocked":2,"lastMessageAt":"2026-11-16T08:00:00Z"}}
                """#.utf8))
        guard case .senderChanged(let change) = blocked else {
            Issue.record("Not a sender change: \(blocked)")
            return
        }
        #expect(change.blocked && change.sender?.messagesSinceBlocked == 2 && change.sender?.blockedBy == nil)
        #expect(blocked.type == "sender.changed")
        let unblocked = MailEvent.senderChanged(
            SenderChange(inboxId: "inb_harbor", address: "outreach@linkboost.example", blocked: false))
        #expect(
            try encodedJSON(unblocked)
                == json(
                    #"{"type":"sender.changed","inboxId":"inb_harbor","address":"outreach@linkboost.example","blocked":false}"#
                ))
        let back = try MailJSON.decoder().decode(MailEvent.self, from: MailJSON.encoder().encode(blocked))
        #expect(back == blocked)
    }

    @Test func theRoutesAsCoreNamesThem() async throws {
        let transport = StubTransport { request in
            switch request.url?.path {
            case "/v1/senders": .json(Page(items: SampleData.bundled.blockedSenders))
            default: .json(ActResult(records: []))
            }
        }
        let client = APIClient(server: testServer, token: "tok_1", transport: transport)
        #expect(try await client.senders(ListQuery(inboxId: "inb_harbor", limit: 200)).items == sample.blockedSenders)
        #expect(transport.lastRequest?.httpMethod == "GET")
        #expect(transport.lastRequest?.pathAndQuery == "/v1/senders?state=blocked&inboxId=inb_harbor&limit=200")
        _ = try await client.allowSender(inboxId: "inb_harbor", address: "outreach@linkboost.example")
        let allow = try #require(transport.lastRequest)
        #expect(allow.httpMethod == "POST" && allow.pathAndQuery == "/v1/senders/allow")
        #expect(allow.jsonBody == json(#"{"inboxId":"inb_harbor","address":"outreach@linkboost.example"}"#))
    }
}

/// The store's list: loaded page by page, kept by `sender.changed`, and unblocking with the undo strip.
@MainActor
struct BlockedSenderStoreTests {
    let sample = SampleData.bundled

    /// A store whose server answers the senders' routes with `allow` and `senders`, and an undo with its record.
    private func store(
        senders: @escaping @Sendable (URLRequest) -> StubReply = { _ in
            .json(Page(items: SampleData.bundled.blockedSenders))
        },
        allow: @escaping @Sendable () -> StubReply = { .json(ActResult(records: [])) }
    ) async throws -> (MailStore, StubTransport) {
        let transport = StubTransport { request in
            switch (request.httpMethod, request.url?.path ?? "") {
            case ("GET", "/v1/senders"): return senders(request)
            case ("POST", "/v1/senders/allow"): return allow()
            case ("POST", let path) where path.hasSuffix("/undo"):
                var record = Self.unblockRecord
                record.state = .undone
                record.undoable = false
                return .json(ActResult(records: [record]))
            default: return .error("not_found", "Not here.", status: 404)
            }
        }
        let client = APIClient(server: testServer, token: "tok_1", transport: transport)
        let now = SampleData.bundled.now
        let store = MailStore(client: client, local: try await LocalStore.sample(), clock: { now })
        await store.loadFromDisk()
        return (store, transport)
    }

    nonisolated static let unblockRecord = ActionRecord(
        id: "act_allow_1", threadId: "thr_28", inboxId: "inb_harbor", action: .allowSender,
        actor: .person(deviceId: "dev_mac_1"), state: .applied, at: SampleData.bundled.now, undoable: true)

    @Test func theListLoadsEveryPage() async throws {
        let (store, transport) = try await store { request in
            let first = !(request.url?.query ?? "").contains("cursor=")
            let items = SampleData.bundled.blockedSenders
            return first ? .json(Page(items: Array(items.prefix(2)), nextCursor: "c2")) : .json(Page(items: [items[2]]))
        }
        #expect(store.blockedSenders == nil)
        await store.loadBlockedSenders()
        #expect(store.blockedSenders?.items == sample.blockedSenders)
        #expect(
            transport.requests.map(\.pathAndQuery) == [
                "/v1/senders?state=blocked&limit=200", "/v1/senders?state=blocked&cursor=c2&limit=200",
            ])
    }

    @Test func theProfileFilter() {
        let list = BlockedSenderList(sample.blockedSenders)
        #expect(list.items(in: nil).count == 3)
        #expect(list.items(in: "inb_personal").map(\.address) == ["deals@brightbuy.example"])
        #expect(list.items(in: "inb_nowhere").isEmpty)
    }

    @Test func blockedFalseRemovesTheRow() async throws {
        let (store, _) = try await store()
        await store.loadBlockedSenders()
        await store.receive(
            .senderChanged(SenderChange(inboxId: "inb_personal", address: "Deals@BrightBuy.example", blocked: false)))
        #expect(
            store.blockedSenders?.items.map(\.address) == ["outreach@linkboost.example", "sales@growthpipe.example"])
    }

    @Test func blockedTrueReplacesTheRowAndSortsAgain() async throws {
        let (store, _) = try await store()
        await store.loadBlockedSenders()
        // More mail from Growthpipe: its count rises.
        var growthpipe = sample.blockedSenders[2]
        growthpipe.messagesSinceBlocked = 4
        await store.receive(
            .senderChanged(
                SenderChange(
                    inboxId: growthpipe.inboxId, address: growthpipe.address, blocked: true, sender: growthpipe)))
        #expect(store.blockedSenders?.items.map(\.messagesSinceBlocked) == [1, 3, 4])
        // Blocked again just now: first, once, with its new count.
        growthpipe.blockedAt = sample.now
        growthpipe.messagesSinceBlocked = 0
        await store.receive(
            .senderChanged(
                SenderChange(
                    inboxId: growthpipe.inboxId, address: growthpipe.address, blocked: true, sender: growthpipe)))
        #expect(store.blockedSenders?.items.first == growthpipe && store.blockedSenders?.items.count == 3)
        // A newly blocked sender joins in its place.
        let fresh = BlockedSender(
            inboxId: "inb_northwind", address: "promo@new.example", blockedAt: time("2026-11-12T09:00:00Z"))
        await store.receive(
            .senderChanged(SenderChange(inboxId: "inb_northwind", address: fresh.address, blocked: true, sender: fresh))
        )
        #expect(
            store.blockedSenders?.items.map(\.address) == [
                "sales@growthpipe.example", "outreach@linkboost.example", "promo@new.example",
                "deals@brightbuy.example",
            ])
    }

    @Test func anEventDuringTheLoadIsAppliedOnTopOfIt() async throws {
        let gate = Gate()
        let transport = StubTransport { request in
            await gate.wait()
            return .json(Page(items: SampleData.bundled.blockedSenders))
        }
        let now = sample.now
        let store = MailStore(
            client: APIClient(server: testServer, token: "tok_1", transport: transport),
            local: try await LocalStore.sample(), clock: { now })
        let load = Task { await store.loadBlockedSenders() }
        while transport.requests.isEmpty { await Task.yield() }
        await store.receive(
            .senderChanged(SenderChange(inboxId: "inb_harbor", address: "outreach@linkboost.example", blocked: false)))
        await gate.open()
        await load.value
        #expect(store.blockedSenders?.items.count == 2)
    }

    @Test func eventsWaitUntilTheListIsLoaded() async throws {
        let (store, _) = try await store()
        await store.receive(
            .senderChanged(SenderChange(inboxId: "inb_harbor", address: "outreach@linkboost.example", blocked: false)))
        #expect(store.blockedSenders == nil)
    }

    @Test func anAgentsDeviceGetsNoListAndNoProblem() async throws {
        let (store, _) = try await store(senders: { _ in .error("needs_person", "Only a person.", status: 403) })
        await store.loadBlockedSenders()
        #expect(store.blockedSenders == nil && store.problem == nil)
    }

    @Test func unblockingOffersItsUndo() async throws {
        let (store, transport) = try await store(allow: {
            .json(
                ActResult(
                    records: [Self.unblockRecord], threads: [SampleData.bundled.threads.first { $0.id == "thr_28" }!]))
        })
        await store.loadBlockedSenders()
        let linkboost = sample.blockedSenders[0]
        let refusal = await store.unblock(linkboost)
        #expect(refusal == nil)
        #expect(store.blockedSenders?.contains(linkboost.id) == false)
        let allow = try #require(transport.requests.last)
        #expect(allow.pathAndQuery == "/v1/senders/allow")
        #expect(allow.jsonBody == json(#"{"inboxId":"inb_harbor","address":"outreach@linkboost.example"}"#))
        // The strip: "Unblocked." with Undo, which undoes records[0].
        #expect(store.lastAction?.records.map(\.id) == ["act_allow_1"])
        #expect(store.lastAction?.words == "Unblocked." && store.lastAction?.action == .allowSender)
        await store.undoLastAction()
        let undo = try #require(transport.requests.last)
        #expect(undo.httpMethod == "POST" && undo.pathAndQuery == "/v1/actions/act_allow_1/undo")
        // The row is back at once, before the server's `sender.changed`.
        #expect(store.blockedSenders?.items == sample.blockedSenders)
        #expect(store.lastAction == nil)
    }

    @Test func anUnblockWithoutARecordHasNoUndo() async throws {
        let (store, transport) = try await store()
        await store.loadBlockedSenders()
        // An earlier action's strip is replaced: this one can't be undone.
        store.lastAction = RecentAction(action: .done, records: [Self.unblockRecord])
        await store.unblock(sample.blockedSenders[2])
        #expect(store.lastAction == nil)
        #expect(store.blockedSenders?.items.count == 2)
        #expect(!transport.requests.contains { $0.url?.path.hasSuffix("/undo") == true })
    }

    @Test func aRefusedUnblockPutsTheRowBack() async throws {
        let (store, _) = try await store(allow: { .error("invalid", "That isn't an address.", status: 400) })
        await store.loadBlockedSenders()
        let refusal = await store.unblock(sample.blockedSenders[1])
        #expect(refusal?.contains("That isn't an address.") == true)
        #expect(store.blockedSenders?.items == sample.blockedSenders)
        #expect(store.lastAction == nil)
    }

    @Test func theSampleShowsItsThree() async throws {
        let store = try await MailStore.sample()
        #expect(store.isSample && store.blockedSenders?.items == sample.blockedSenders)
        // With no server, asking again keeps them.
        await store.loadBlockedSenders()
        #expect(store.blockedSenders?.items.count == 3)
        await store.loadServerInfo()
        #expect(store.serverInfo == nil)
    }

    @Test func theServersVersions() async throws {
        let transport = StubTransport { _ in .json(ServerInfo(name: "usual-mail", version: "0.4.2", apiVersion: 1)) }
        let now = sample.now
        let store = MailStore(
            client: APIClient(server: testServer, token: "tok_1", transport: transport),
            local: try await LocalStore.sample(), clock: { now })
        await store.loadServerInfo()
        #expect(store.serverInfo?.version == "0.4.2" && store.serverInfo?.apiVersion == 1)
        #expect(transport.lastRequest?.pathAndQuery == "/v1/info")
        #expect(transport.lastRequest?.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func theSourceLinkWaitsForTheRepositoryToBePublic() {
        #expect(!ProjectLinks.isPublished && ProjectLinks.sourceCode == nil)
        #expect(ProjectLinks.sourceCode(published: true)?.absoluteString == "https://github.com/usual-labs/usual-mail")
        #expect(ProjectLinks.website.absoluteString == "https://mail.usual.dev")
    }
}
