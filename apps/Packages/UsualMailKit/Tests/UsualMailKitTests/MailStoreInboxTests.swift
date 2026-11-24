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

    @Test func theDashboardPageForAnInbox() async throws {
        let store = try await makeStore(SampleServer())
        #expect(
            store.dashboardURL(inboxId: "inb/harbor").absoluteString == "http://mail.local:8787/inboxes/inb%2Fharbor")
    }
}
