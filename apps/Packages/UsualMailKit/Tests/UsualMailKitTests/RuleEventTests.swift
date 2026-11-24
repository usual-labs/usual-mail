import Foundation
import Testing

@testable import UsualMailKit

/// Rules have versions and events since the fourth revision (docs/contract.md, "Rules and learning"): the copy keeps
/// the higher version wherever it came from, `rule.changed` and `rule.removed` apply at once, and a refresh still
/// learns of a removal only by absence, so the refresh watch covers that and nothing else.
@MainActor
struct RuleEventTests {
    let sample = SampleData.bundled

    private func loadedStore(_ server: SampleServer = SampleServer()) async throws -> MailStore {
        let store = try await makeStore(server)
        await store.loadFromDisk()
        return store
    }

    @Test func ruleChangedShowsAtOnceAndKeepsTheHigherVersion() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        // Hits from a batch of new mail: one event for the rule, with its new count.
        let sorted = server.changeRule("rul_1") { $0.hits = 17 }
        await store.receive(.ruleChanged(sorted))
        #expect(store.lists.rules(inbox: "inb_northwind").first { $0.id == "rul_1" }?.hits == 17)

        // An older copy arriving late changes nothing.
        var stale = sorted
        stale.hits = 15
        stale.version -= 1
        await store.receive(.ruleChanged(stale))
        #expect(try await store.local.rule(id: "rul_1")?.hits == 17)
    }

    @Test func aRuleAnAgentSuggestsArrivesWithItsName() async throws {
        let store = try await loadedStore()
        let suggestion = Rule(
            id: "rul_9", inboxId: "inb_harbor", text: "The roaster's invoices are receipts",
            match: RuleMatch(domain: "kestrel.example"), then: [.categorize(.receipt)], source: .agent, enabled: false,
            createdBy: .agent(agentId: "dev_agent_2", name: "Hermes"), createdAt: sample.now)
        await store.receive(.ruleChanged(suggestion))
        let shown = try #require(store.lists.rules(inbox: "inb_harbor").first { $0.id == "rul_9" })
        #expect(shown.createdBy == .agent(agentId: "dev_agent_2", name: "Hermes") && !shown.enabled)
    }

    @Test func ruleRemovedTakesItAway() async throws {
        let store = try await loadedStore()
        await store.receive(.ruleRemoved(ruleId: "rul_4", inboxId: "inb_personal"))
        #expect(store.lists.rules(inbox: "inb_personal").isEmpty)
        #expect(try await store.local.rule(id: "rul_4") == nil)
    }

    @Test func aRuleMadeDuringARefreshIsNotRemovedForBeingMissing() async throws {
        let server = SampleServer()
        // The refresh reads Harbor & Pine's rules before the agent's suggestion exists, and the answer waits.
        let gate = server.holdAnswer("GET /v1/inboxes/inb_harbor/rules")
        let store = try await loadedStore(server)
        let refresh = Task { await store.refresh() }
        try await waitUntil("the rules were read") { server.hasAnswered("GET /v1/inboxes/inb_harbor/rules") }
        let suggestion = Rule(
            id: "rul_9", inboxId: "inb_harbor", text: "Suppliers are conversations",
            match: RuleMatch(to: "a@b.example"),
            then: [.categorize(.conversation)], source: .agent, enabled: false,
            createdBy: .agent(agentId: "dev_agent_2", name: "Hermes"), createdAt: sample.now)
        await store.receive(.ruleChanged(suggestion))
        await gate.open()
        await refresh.value
        // Versions can't say a rule missing from an older list is new; the refresh watch keeps it.
        #expect(store.lists.rules(inbox: "inb_harbor").map(\.id).contains("rul_9"))
    }

    @Test func aRuleRemovedDuringARefreshIsNotBroughtBack() async throws {
        let server = SampleServer()
        let gate = server.holdAnswer("GET /v1/inboxes/inb_personal/rules")
        let store = try await loadedStore(server)
        let refresh = Task { await store.refresh() }
        try await waitUntil("the rules were read") { server.hasAnswered("GET /v1/inboxes/inb_personal/rules") }
        // The list on its way still has rul_4; a removal leaves no copy to compare versions with.
        await store.receive(.ruleRemoved(ruleId: "rul_4", inboxId: "inb_personal"))
        await gate.open()
        await refresh.value
        #expect(try await store.local.rule(id: "rul_4") == nil)
    }

    @Test func aRefreshRemovesARuleGoneElsewhere() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        server.state.withLock { $0.data.rules.removeAll { $0.id == "rul_3" } }
        await store.refresh()
        #expect(store.lists.rules(inbox: "inb_harbor").isEmpty)
    }

    @Test func answeringATeachPromptStoresTheRuleWithItsMaker() async throws {
        let server = SampleServer()
        server.state.withLock {
            $0.teach = TeachPrompt(
                id: "tch_1", question: "Always treat mail from The Weekly Build as a conversation?",
                rule: RuleDraft(
                    inboxId: "inb_northwind", text: "The Weekly Build is a conversation",
                    match: RuleMatch(domain: "weeklybuild.example"), then: [.categorize(.conversation)]),
                fromActionId: "act_3", expiresAt: sample.now.addingTimeInterval(3600))
        }
        let store = try await loadedStore(server)
        await store.perform(.categorize(.conversation), on: ["thr_4"])
        await store.answerTeach(accept: true)
        let rule = try #require(store.lists.rules(inbox: "inb_northwind").first { $0.id == "rul_new" })
        #expect(rule.createdBy == .person(deviceId: "dev_test") && rule.source == .correction && rule.version == 1)
    }
}
