import Foundation
import Testing

@testable import UsualMailKit

/// The first sync's window (docs/contract-sync.md, "Sync") and the AI's usage (docs/contract-ai.md, "Usage"): their
/// shapes, their routes, and the store's copy of each, which only a person's device gets.
struct FirstSyncAndUsageModelTests {
    let sample = SampleData.bundled

    @Test func theSampleWindowAndWhereItCameFrom() throws {
        #expect(sample.firstSync == FirstSyncWindow(days: 30, setBy: .settings, changeable: true))
        let decode = { (text: String) in try MailJSON.decoder().decode(FirstSyncWindow.self, from: Data(text.utf8)) }
        // The server's own default is spelled `default` on the wire.
        let fixed = try decode(#"{"days":30,"setBy":"default","changeable":false}"#)
        #expect(fixed.setBy == .serverDefault && !fixed.changeable)
        #expect(try decode(#"{"days":7,"setBy":"environment","changeable":false}"#).setBy == .environment)
        // A source a newer server sends is kept whole.
        let newer = try decode(#"{"days":14,"setBy":"policy","changeable":true}"#)
        #expect(newer.setBy == .unknown("policy") && !newer.setBy.isKnown)
        #expect(try encodedJSON(fixed) == json(#"{"changeable":false,"days":30,"setBy":"default"}"#))
        #expect(try encodedJSON(FirstSyncWindowPatch(days: 7)) == json(#"{"days":7}"#))
    }

    @Test func theSampleUsageByJobAndModel() throws {
        let usage = sample.aiUsage
        #expect(usage.since == time("2026-10-20T07:12:00Z") && usage.timeZone == "Europe/Berlin")
        let today = usage.rows(in: .today)
        #expect(
            today == [
                AiUsageRow(
                    job: .categorize, model: "example/decision-1", requests: 14, inputTokens: 6300, outputTokens: 42),
                AiUsageRow(
                    job: .summarize, model: "example/text-small-2", requests: 11, failed: 1, inputTokens: 24800,
                    outputTokens: 610, tokensPartial: true, cost: AiUsageCost(amount: 0.0031), costPartial: true),
            ])
        #expect(today[0].cost == nil && today[1].cost?.currency == "USD")
        // A model changed in the period gives two rows of the same job.
        #expect(
            usage.rows(in: .last7Days).map { "\($0.job.rawValue) \($0.model)" } == [
                "categorize example/decision-1", "summarize example/text-small-1", "summarize example/text-small-2",
            ])
        #expect(usage.rows(in: .last30Days).count == 3)
        // What wasn't reported is written back as null, as core has it.
        let written = try encodedJSON(today[0])
        #expect(written["cost"] == .null && written["costPartial"] == false)
        let silent = AiUsageRow(job: .summarize, model: "m", requests: 2, failed: 2)
        #expect(try encodedJSON(silent)["inputTokens"] == .null && encodedJSON(silent)["outputTokens"] == .null)
    }

    @Test func theRoutesAsCoreNamesThem() async throws {
        let transport = StubTransport { request in
            switch request.url?.path {
            case "/v1/ai/usage": .json(SampleData.bundled.aiUsage)
            default: .json(SampleData.bundled.firstSync)
            }
        }
        let client = APIClient(server: testServer, token: "tok_1", transport: transport)
        #expect(try await client.firstSync() == sample.firstSync)
        #expect(transport.lastRequest.map { "\($0.httpMethod!) \($0.pathAndQuery)" } == "GET /v1/first-sync")
        _ = try await client.updateFirstSync(FirstSyncWindowPatch(days: 7))
        let patch = try #require(transport.lastRequest)
        #expect(patch.httpMethod == "PATCH" && patch.pathAndQuery == "/v1/first-sync")
        #expect(patch.jsonBody == json(#"{"days":7}"#))
        // The time zone's slash is escaped.
        #expect(try await client.aiUsage(timeZone: "Europe/Berlin") == sample.aiUsage)
        #expect(transport.lastRequest?.pathAndQuery == "/v1/ai/usage?tz=Europe%2FBerlin")
        #expect(transport.lastRequest?.httpMethod == "GET")
    }
}

@MainActor
struct FirstSyncAndUsageStoreTests {
    let sample = SampleData.bundled
    let berlin = TimeZone(identifier: "Europe/Berlin")!

    @Test func theRefreshBringsTheWindowForAPerson() async throws {
        let store = try await makeStore(SampleServer())
        #expect(store.firstSyncWindow == nil)
        await store.refresh()
        #expect(store.firstSyncWindow == sample.firstSync && store.problem == nil)
    }

    @Test func anAgentsTokenLeavesTheWindowAndTheUsageNilQuietly() async throws {
        let server = SampleServer()
        let refusal = StubReply.error("needs_person", "Only a person may see this", status: 403)
        server.failOnce("GET /v1/first-sync", with: refusal)
        let store = try await makeStore(server)
        await store.refresh()
        #expect(store.firstSyncWindow == nil && store.problem == nil)
        #expect(store.counts == sample.counts)

        server.failOnce("GET /v1/first-sync", with: refusal)
        await store.loadFirstSyncWindow()
        server.failOnce("GET /v1/ai/usage", with: refusal)
        await store.loadAiUsage(timeZone: berlin)
        #expect(store.firstSyncWindow == nil && store.aiUsage == nil && store.problem == nil)
    }

    @Test func loadingTheWindowAsksTheServer() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFirstSyncWindow()
        #expect(store.firstSyncWindow == sample.firstSync)
        #expect(server.requests.last.map { "\($0.httpMethod!) \($0.pathAndQuery)" } == "GET /v1/first-sync")
    }

    @Test func changingTheWindowKeepsTheServersAnswer() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFirstSyncWindow()
        #expect(await store.updateFirstSync(days: 7))
        #expect(server.requests.last?.jsonBody == json(#"{"days":7}"#))
        #expect(store.firstSyncWindow == FirstSyncWindow(days: 7, setBy: .settings, changeable: true))
        #expect(store.problem == nil)
    }

    @Test func aRefusedWindowSaysWhyAndKeepsTheOldOne() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFirstSyncWindow()
        #expect(await store.updateFirstSync(days: 0) == false)
        #expect(store.problem?.message == "Days must be a whole number from 1 to 36500")
        #expect(store.firstSyncWindow == sample.firstSync)

        // Set where the server runs: `conflict`.
        store.dismissProblem()
        server.state.withLock { $0.data.firstSync = FirstSyncWindow(days: 14, setBy: .environment, changeable: false) }
        await store.loadFirstSyncWindow()
        #expect(await store.updateFirstSync(days: 30) == false)
        #expect(store.problem?.message == "The first sync's window is set where the server runs")
        #expect(store.firstSyncWindow?.days == 14 && store.firstSyncWindow?.changeable == false)
    }

    @Test func aWindowSavedDuringARefreshIsNotTakenBack() async throws {
        let server = SampleServer()
        let gate = server.holdAnswer("GET /v1/first-sync")
        let store = try await makeStore(server)
        let refresh = Task { await store.refresh() }
        try await waitUntil("the window was read") { server.hasAnswered("GET /v1/first-sync") }
        #expect(await store.updateFirstSync(days: 7))
        await gate.open()
        await refresh.value
        #expect(store.firstSyncWindow?.days == 7)
    }

    @Test func usageComesInThePersonsTimeZone() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        #expect(store.aiUsage == nil)
        await store.loadAiUsage(timeZone: berlin)
        let usage = try #require(store.aiUsage)
        #expect(usage == sample.aiUsage && store.problem == nil)
        #expect(server.requests.last?.pathAndQuery == "/v1/ai/usage?tz=Europe%2FBerlin")
    }

    @Test func aFailedUsageFetchKeepsWhatWasShown() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadAiUsage(timeZone: berlin)
        server.failOnce("GET /v1/ai/usage", with: .error("internal", "Something broke", status: 500))
        await store.loadAiUsage(timeZone: berlin)
        #expect(store.aiUsage == sample.aiUsage)
        #expect(store.problem?.message == "Something broke")
    }
}
