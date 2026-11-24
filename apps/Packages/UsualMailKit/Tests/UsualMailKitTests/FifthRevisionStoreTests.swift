import Foundation
import Testing

@testable import UsualMailKit

/// Categorizing and letting senders in through the store, against the stand-in server (docs/contract.md, "Actions
/// and undo").
@MainActor
struct CategorizeTests {
    let sample = SampleData.bundled

    private func loadedStore(_ server: SampleServer) async throws -> MailStore {
        let store = try await makeStore(server)
        await store.loadFromDisk()
        return store
    }

    @Test func categorizingShowsAtOnceAndTheServerSaysWhoDecided() async throws {
        let server = SampleServer()
        let gate = server.hold("POST /v1/actions")
        let store = try await loadedStore(server)
        #expect(store.lists.home.contains { $0.id == "thr_14" })

        let file = Task { await store.perform(.categorize(.newsletter), on: ["thr_14"]) }
        try await waitUntil("thr_14 leaves Home") { !store.lists.home.contains { $0.id == "thr_14" } }
        let shown = try #require(store.lists.threads(in: .newsletter, inbox: nil).first { $0.id == "thr_14" })
        #expect(shown.categorizedBy == .person && shown.unread && !shown.done)
        await gate.open()
        await file.value

        #expect(
            server.requests.last?.jsonBody
                == json(#"{"action":{"category":"newsletter","kind":"categorize"},"threadIds":["thr_14"]}"#))
        let stored = try #require(try await store.local.thread(id: "thr_14"))
        #expect(stored == server.thread("thr_14") && stored.version == 2 && stored.categorizedBy == .person)
        #expect(store.lists.threads(in: .newsletter, inbox: "inb_northwind").map(\.id) == ["thr_14", "thr_4"])
        #expect(store.lastAction?.action == .categorize(.newsletter))
    }

    @Test func undoingACategorizePutsTheCategoryBackAndThePersonDecidedIt() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        await store.perform(.categorize(.receipt), on: ["thr_6"])  // the AI called it an invoice
        #expect(store.lists.threads(in: .receipt, inbox: nil).map(\.id) == ["thr_6", "thr_17", "thr_10"])

        let record = try #require(store.lastAction?.records.first)
        let gate = server.hold("POST /v1/actions/\(record.id)/undo")
        let undo = Task { await store.undoLastAction() }
        try await waitUntil("thr_6 is an invoice again") {
            store.lists.threads(in: .invoice, inbox: nil).map(\.id) == ["thr_6", "thr_18"]
        }
        #expect(store.lists.thread(id: "thr_6")?.categorizedBy == .person)  // no longer the AI's to decide
        await gate.open()
        await undo.value

        let thread = try #require(try await store.local.thread(id: "thr_6"))
        #expect(thread.category == .invoice && thread.categorizedBy == .person && thread.version == 5)
        #expect(store.lists.threads(in: .receipt, inbox: nil).map(\.id) == ["thr_17", "thr_10"])
        #expect(try await store.local.action(id: record.id)?.state == .undone)
    }

    @Test func aRefusedCategorizeIsTakenBack() async throws {
        let server = SampleServer()
        server.failOnce("POST /v1/actions", with: .error("invalid", "Nobody can choose unknown", status: 400))
        let store = try await loadedStore(server)
        await store.perform(.categorize(.uncategorized), on: ["thr_8"])
        #expect(store.lists.threads(in: .newsletter, inbox: nil).map(\.id) == ["thr_8", "thr_4"])
        #expect(try await store.local.thread(id: "thr_8")?.categorizedBy == .ai)
        #expect(store.problem?.message == "Nobody can choose unknown")
    }

    @Test func aOneTimeCodeLeavesScreeningAndLosesItsSummary() async throws {
        let store = try await loadedStore(SampleServer())
        await store.perform(.categorize(.otp), on: ["thr_5"])
        #expect(store.lists.screening.isEmpty)
        let code = try #require(store.lists.threads(in: .otp, inbox: nil).first { $0.id == "thr_5" })
        #expect(!code.screened && code.summary == nil)
    }

    @Test func lettingASenderInClearsScreeningOnTheirThreads() async throws {
        var data = sample
        // A second thread from thr_5's sender, also screened.
        var second = try #require(data.threads.first { $0.id == "thr_5" })
        second.id = "thr_5b"
        second.subject = "Following up on pricing"
        second.lastMessageAt = time("2026-11-16T09:20:00Z")
        data.threads.append(second)
        var message = try #require(data.messages.first { $0.id == "msg_5a" })
        message.id = "msg_5b"
        message.threadId = "thr_5b"
        data.messages.append(message)
        let server = SampleServer(data)
        let local = try LocalStore()
        let (inboxes, threads) = (data.inboxes, data.threads)
        try await local.write { writer in
            try writer.replaceInboxes(inboxes)
            try writer.upsert(threads: threads)
        }
        let store = try await makeStore(server, local: local)
        await store.loadFromDisk()
        #expect(store.lists.screening.map(\.id) == ["thr_5b", "thr_5"])

        await store.perform(.allowSender, on: ["thr_5"])
        #expect(server.requests.last?.jsonBody == json(#"{"action":{"kind":"allow_sender"},"threadIds":["thr_5"]}"#))
        // Every thread of that sender in that inbox at once, by `sender`: both are conversations in Home.
        #expect(store.lists.screening.isEmpty)
        #expect(store.lists.home.prefix(3).map(\.id) == ["thr_14", "thr_5b", "thr_5"])
        #expect(server.thread("thr_5b")?.screened == false)
        // Its `thread.changed` confirms the other thread.
        await store.receive(.threadChanged(try #require(server.thread("thr_5b"))))
        #expect(store.lists.screening.isEmpty)
        #expect(store.lists.home.prefix(3).map(\.id) == ["thr_14", "thr_5b", "thr_5"])

        // Undo screens the named thread again.
        await store.undoLastAction()
        #expect(store.lists.screening.map(\.id) == ["thr_5"])
        #expect(try await store.local.thread(id: "thr_5")?.screened == true)
    }

    @Test func approvingAProposedCategoryKeepsItsProposerAsDecider() async throws {
        var data = sample
        let index = try #require(data.actions.firstIndex { $0.id == "act_4" })
        data.actions[index].action = .categorize(.receipt)  // Claude Code proposes thr_8 is a receipt
        let server = SampleServer(data)
        let store = try await makeStore(server, local: try LocalStore())
        await store.refresh()
        let proposal = try #require(store.lists.proposals(inbox: nil).first)
        let gate = server.hold("POST /v1/actions/approve")
        let approve = Task { await store.approve([proposal.record]) }
        try await waitUntil("thr_8 shows as a receipt") {
            store.lists.threads(in: .receipt, inbox: nil).contains { $0.id == "thr_8" }
        }
        #expect(store.lists.thread(id: "thr_8")?.categorizedBy == .agent)
        await gate.open()
        await approve.value
        #expect(try await store.local.thread(id: "thr_8")?.categorizedBy == .agent)
    }
}

/// The counts and the AI's status and settings through the store: from a refresh and from events, the higher version
/// kept, on disk for offline, and the settings only as a person's device gets them.
@MainActor
struct CountsAndAITests {
    let sample = SampleData.bundled

    @Test func aRefreshFetchesTheCountsAndTheAI() async throws {
        let server = SampleServer()
        let store = try await makeStore(server, local: try LocalStore())
        #expect(store.counts == nil && store.aiStatus == nil && store.aiSettings == nil)
        await store.refresh()
        #expect(store.counts == sample.counts && store.aiStatus == sample.aiStatus && store.aiSettings == sample.ai)
        let paths = Set(server.requests.map(\.pathAndQuery))
        #expect(paths.isSuperset(of: ["/v1/counts", "/v1/ai/status", "/v1/ai"]))
        // Kept on disk: another store on the same copy shows them offline.
        let offline = MailStore(
            client: APIClient(server: testServer, token: "t", transport: OfflineTransport()), local: store.local,
            clock: { SampleData.bundled.now })
        await offline.loadFromDisk()
        #expect(offline.counts == sample.counts && offline.aiStatus == sample.aiStatus)
    }

    @Test func eventsKeepTheHigherVersion() async throws {
        let store = try await makeStore(SampleServer())
        await store.loadFromDisk()
        #expect(store.counts == sample.counts)
        var counts = sample.counts
        counts.all.home = 6
        counts.version += 1
        await store.receive(.countsChanged(counts))
        #expect(store.counts?.all.home == 6)
        var stale = sample.counts
        stale.all.home = 2
        await store.receive(.countsChanged(stale))  // older than what the device has
        #expect(store.counts?.all.home == 6)

        var refused = sample.aiStatus
        refused.state = .keyRefused
        refused.detail = "The gateway refused the key."
        refused.version += 1
        await store.receive(.aiStatusChanged(refused))
        #expect(store.aiStatus?.state == .keyRefused && store.aiStatus?.detail == "The gateway refused the key.")
        var older = sample.aiStatus
        older.version -= 1
        await store.receive(.aiStatusChanged(older))
        #expect(store.aiStatus?.state == .keyRefused)

        var paused = sample.ai
        paused.paused = true
        paused.version += 1
        await store.receive(.aiSettingsChanged(paused))
        #expect(store.aiSettings?.paused == true)
    }

    @Test func anEventDuringARefreshOutlivesTheRefreshsOlderCounts() async throws {
        let server = SampleServer()
        let gate = server.holdAnswer("GET /v1/counts")
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let refresh = Task { await store.refresh() }
        try await waitUntil("the counts were read") { server.hasAnswered("GET /v1/counts") }
        var newer = sample.counts
        newer.all.unread = 7
        newer.version += 2
        await store.receive(.countsChanged(newer))
        await gate.open()
        await refresh.value
        #expect(store.counts == newer)
    }

    @Test func refusedSettingsAreLeftOutQuietly() async throws {
        let server = SampleServer()
        server.failOnce(
            "GET /v1/ai", with: .error("needs_person", "Only a person may see the AI's settings", status: 403))
        let store = try await makeStore(server, local: try LocalStore())
        await store.refresh()
        #expect(store.aiSettings == nil && store.problem == nil)
        #expect(store.counts == sample.counts && store.aiStatus == sample.aiStatus)
    }

    @Test func removingAnInboxDropsItsCounts() async throws {
        let store = try await makeStore(SampleServer())
        await store.loadFromDisk()
        await store.receive(.inboxRemoved(inboxId: "inb_northwind"))
        #expect(store.counts?.inboxes.map(\.inboxId) == ["inb_harbor", "inb_personal"])
        #expect(store.counts?.all.home == 1 && store.counts?.all.screened == 0)
        #expect(store.counts?.counts(for: "inb_northwind") == nil)
    }

    @Test func changingTheSettingsSendsThePatchAndKeepsNoKey() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let patch = AiSettingsPatch(
            credentials: .set(AiCredentials(.direct(.anthropic), apiKey: "not-a-real-key")), paused: true)
        #expect(await store.updateAiSettings(patch))
        let request = try #require(server.requests.last)
        #expect(request.httpMethod == "PATCH" && request.pathAndQuery == "/v1/ai")
        #expect(request.jsonBody?["credentials"]?["apiKey"] == "not-a-real-key")
        #expect(request.jsonBody?["historyDays"] == nil)
        let settings = try #require(store.aiSettings)
        #expect(settings.connection == .direct(.anthropic) && settings.paused && settings.version == 6)
        let stored = String(
            decoding: try StoredJSON.encode(try #require(try await store.local.status().aiSettings)), as: UTF8.self)
        #expect(!stored.contains("not-a-real-key"))

        let status = try #require(await store.testAi())
        #expect(server.requests.last.map { "\($0.httpMethod!) \($0.pathAndQuery)" } == "POST /v1/ai/test")
        #expect(status.version == 59 && store.aiStatus == status)
    }

    @Test func aRefusedSettingsChangeSaysWhyWithoutTheKey() async throws {
        let server = SampleServer()
        server.failOnce("PATCH /v1/ai", with: .error("invalid", "The key not-a-real-key is malformed", status: 400))
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let patch = AiSettingsPatch(credentials: .set(AiCredentials(.gateway(.vercel), apiKey: "not-a-real-key")))
        #expect(await store.updateAiSettings(patch) == false)
        #expect(store.problem?.message == "The key ••• is malformed")
        #expect(store.aiSettings == sample.ai)
    }

    @Test func theSampleStoreShowsTheCountsAndTheAI() async throws {
        let store = try await MailStore.sample()
        #expect(store.counts == sample.counts && store.aiStatus == sample.aiStatus && store.aiSettings == sample.ai)
        #expect(store.firstSyncWindow == sample.firstSync && store.aiUsage == sample.aiUsage)
        #expect(store.counts?.counts(for: "inb_northwind")?.home == store.lists.home(inbox: "inb_northwind").count)
        #expect(store.lists.home(inbox: nil).map(\.id) == ["thr_14", "thr_1", "thr_2", "thr_12", "thr_16"])
    }
}
