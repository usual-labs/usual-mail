import Foundation
import Testing

@testable import UsualMailKit

/// An inbox's own page through the store: its guide, trust and agent access, and its rules on and off.
@MainActor
struct MailStoreInboxTests {
    private func loadedStore(_ server: SampleServer) async throws -> MailStore {
        let store = try await makeStore(server)
        await store.loadFromDisk()
        return store
    }

    @Test func changingTheTrustSendsOnlyThatAndKeepsTheAnswer() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        #expect(await store.updateInbox("inb_harbor", InboxPatch(trust: .actWithUndo)))
        let request = try #require(server.requests.last)
        #expect(request.httpMethod == "PATCH" && request.pathAndQuery == "/v1/inboxes/inb_harbor")
        #expect(request.jsonBody == json(#"{"trust":"act_with_undo"}"#))
        let harbor = try #require(store.lists.inbox(id: "inb_harbor"))
        #expect(harbor.trust == .actWithUndo && harbor.version == 7)
        #expect(store.problem == nil)
    }

    @Test func theGuideAndAgentAccessChangeTheSameWay() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        let guide = "Family first. Anything about school needs me.\n\nShops go to Receipts."
        #expect(await store.updateInbox("inb_personal", InboxPatch(guide: guide)))
        #expect(server.requests.last?.jsonBody == ["guide": .string(guide)])
        #expect(await store.updateInbox("inb_personal", InboxPatch(agentAccess: false)))
        #expect(server.requests.last?.jsonBody == json(#"{"agentAccess":false}"#))
        let personal = try #require(store.lists.inbox(id: "inb_personal"))
        #expect(personal.guide == guide && !personal.agentAccess && personal.version == 11)
    }

    @Test func theIconAndPlaceChangeTheSameWay() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        #expect(await store.updateInbox("inb_personal", InboxPatch(icon: .house)))
        #expect(server.requests.last?.jsonBody == json(#"{"icon":"house"}"#))
        let personal = try #require(store.lists.inbox(id: "inb_personal"))
        #expect(personal.icon == .house)

        // Moving it first renumbers the others; their `inbox.changed` events put the list in order.
        #expect(await store.updateInbox("inb_personal", InboxPatch(position: 0)))
        #expect(server.requests.last?.jsonBody == json(#"{"position":0}"#))
        for inbox in server.data.inboxes where inbox.id != "inb_personal" {
            await store.receive(.inboxChanged(inbox))
        }
        #expect(store.lists.inboxes.map(\.id) == ["inb_personal", "inb_northwind", "inb_harbor"])
        #expect(store.lists.inboxes.map(\.position) == [0, 1, 2])
    }

    @Test func aRefusedChangeLeavesTheInboxAndSaysWhy() async throws {
        let server = SampleServer()
        server.failOnce(
            "PATCH /v1/inboxes/inb_harbor", with: .error("provider_error", "The mail server is down.", status: 502))
        let store = try await loadedStore(server)
        #expect(await store.updateInbox("inb_harbor", InboxPatch(trust: .actSilently)) == false)
        #expect(store.lists.inbox(id: "inb_harbor")?.trust == .suggest)
        #expect(store.problem?.message == "The mail server is down.")
    }

    @Test func acceptingAnAgentsSuggestionTurnsItsRuleOn() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        let suggestion = try #require(store.lists.rules(inbox: "inb_personal").first { $0.id == "rul_4" })
        #expect(suggestion.source == .agent && !suggestion.enabled)
        #expect(await store.setRule(suggestion, enabled: true))
        let request = try #require(server.requests.last)
        #expect(request.httpMethod == "PATCH" && request.pathAndQuery == "/v1/rules/rul_4")
        #expect(request.jsonBody == json(#"{"enabled":true}"#))
        #expect(store.lists.rules(inbox: "inb_personal").first?.enabled == true)

        #expect(await store.setRule(try #require(store.lists.rules(inbox: "inb_northwind").first), enabled: false))
        #expect(store.lists.rules(inbox: "inb_northwind").first?.enabled == false)
    }

    @Test func turningASuggestionDownDeletesIt() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        let suggestion = try #require(store.lists.rules(inbox: "inb_personal").first)
        #expect(await store.deleteRule(suggestion))
        #expect(server.requests.last.map { "\($0.httpMethod!) \($0.pathAndQuery)" } == "DELETE /v1/rules/rul_4")
        #expect(store.lists.rules(inbox: "inb_personal").isEmpty)
        // A rule already gone on the server is gone here too, without a problem.
        #expect(await store.deleteRule(suggestion))
        #expect(store.problem == nil)
    }

    @Test func aRefreshDuringARuleChangeDoesNotUndoIt() async throws {
        let server = SampleServer()
        // The refresh reads Personal's rules (rul_4 off), and that answer arrives after the change below.
        let gate = server.holdAnswer("GET /v1/inboxes/inb_personal/rules")
        let store = try await loadedStore(server)
        let refresh = Task { await store.refresh() }
        try await waitUntil("the rules were read") { server.hasAnswered("GET /v1/inboxes/inb_personal/rules") }
        let suggestion = try #require(store.lists.rules(inbox: "inb_personal").first)
        // The answer is version 2; the older list (version 1) doesn't turn it off again.
        #expect(await store.setRule(suggestion, enabled: true))
        await gate.open()
        await refresh.value
        let rule = try #require(store.lists.rules(inbox: "inb_personal").first)
        #expect(rule.enabled && rule.version == 2)
    }

    @Test func checkingForMailAsksEachInboxNotPausedToSyncAndFetchesAgain() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        #expect(await store.updateInbox("inb_personal", InboxPatch(paused: true)))
        let before = server.requests.count
        #expect(await store.checkForMail() == nil)
        let asked = server.requests.dropFirst(before).map { "\($0.httpMethod!) \($0.pathAndQuery)" }
        let syncs = Set(asked.filter { $0.hasSuffix("/sync") })
        #expect(syncs == ["POST /v1/inboxes/inb_northwind/sync", "POST /v1/inboxes/inb_harbor/sync"])
        #expect(asked.contains("GET /v1/inboxes"))
        #expect(store.problem == nil)
    }

    @Test func checkingOneInboxAsksOnlyIt() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        let before = server.requests.count
        await store.checkForMail(inboxId: "inb_harbor")
        let syncs = server.requests.dropFirst(before).map(\.pathAndQuery).filter { $0.hasSuffix("/sync") }
        #expect(syncs == ["/v1/inboxes/inb_harbor/sync"])
    }

    @Test func aSyncRefusedStillFetchesAndSaysNothing() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        // Harbor paused on the server, not yet in this device's copy: its sync answers `conflict`.
        server.state.withLock { state in
            let index = state.data.inboxes.firstIndex { $0.id == "inb_harbor" }!
            state.data.inboxes[index].status = .paused
            state.data.inboxes[index].version += 1
        }
        server.failOnce("POST /v1/inboxes/inb_northwind/sync", with: .error("internal", "Something broke", status: 500))
        #expect(await store.checkForMail() == nil)
        #expect(store.problem == nil)
        // The refresh brought the pause.
        #expect(store.lists.inbox(id: "inb_harbor")?.status == .paused)
    }

    @Test func aPullThatCantReachTheServerSaysSo() async throws {
        let store = MailStore(
            client: APIClient(
                server: testServer, token: "t",
                transport: StubTransport { _ in throw URLError(.notConnectedToInternet) }),
            local: try await LocalStore.sample(), clock: { SampleData.bundled.now })
        await store.loadFromDisk()
        let words = "Can't reach your server. This device is offline."
        #expect(await store.checkForMail() == words)
        #expect(store.problem?.message == words)
        #expect(store.connection == .offline(words))
    }

    @Test func leavingTheListMidPullLetsTheRefreshFinish() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        server.state.withLock { state in
            let index = state.data.inboxes.firstIndex { $0.id == "inb_harbor" }!
            state.data.inboxes[index].name = "Harbor Pine"
            state.data.inboxes[index].version += 1
        }
        let gate = server.holdAnswer("GET /v1/counts")
        let pull = Task { await store.checkForMail() }
        try await waitUntil("the refresh asked for the counts") {
            server.requests.contains { $0.pathAndQuery == "/v1/counts" }
        }
        pull.cancel()
        await gate.open()
        await pull.value
        // The refresh went on to its end and read the lists again, though the pull was cancelled.
        try await waitUntil("the refresh finished") { !store.isRefreshing }
        #expect(store.lists.inbox(id: "inb_harbor")?.name == "Harbor Pine")
    }

    @Test func theDashboardPageForAnInbox() async throws {
        let store = try await makeStore(SampleServer())
        #expect(
            store.dashboardURL(inboxId: "inb/harbor").absoluteString == "http://mail.local:8787/inboxes/inb%2Fharbor")
    }
}
