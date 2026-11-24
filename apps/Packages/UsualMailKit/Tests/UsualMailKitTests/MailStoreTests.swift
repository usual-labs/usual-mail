import Foundation
import Synchronization
import Testing

@testable import UsualMailKit

/// Polls until `condition` holds, for states a running task reaches without telling the test.
@MainActor
func waitUntil(_ what: String, timeout: Duration = .seconds(5), _ condition: () -> Bool) async throws {
    let start = ContinuousClock.now
    while !condition() {
        guard ContinuousClock.now - start < timeout else {
            Issue.record("Timed out waiting until \(what)")
            throw CancellationError()
        }
        try await Task.sleep(for: .milliseconds(5))
    }
}

@MainActor
func makeStore(_ server: SampleServer, local: LocalStore? = nil) async throws -> MailStore {
    let now = SampleData.bundled.now
    let copy: LocalStore
    if let local {
        copy = local
    } else {
        copy = try await LocalStore.sample()
    }
    return MailStore(client: server.client(), local: copy, clock: { now })
}

@MainActor
struct MailStoreLoadingTests {
    @Test func theCopyOnDiskShowsBeforeTheServerAnswers() async throws {
        let gate = Gate()
        var data = SampleData.bundled
        var fresh = data.threads[0]
        fresh.id = "thr_new"
        fresh.lastMessageAt = data.now
        data.threads.append(fresh)
        let server = SampleServer(data, gate: gate)
        let store = try await makeStore(server)

        await store.loadFromDisk()
        #expect(store.hasLoadedFromDisk)
        #expect(
            store.lists.home.map(\.id) == ["thr_14", "thr_1", "thr_2", "thr_12", "thr_16"])

        let refresh = Task { await store.refresh() }
        try await waitUntil("the refresh is waiting on the server") { store.isRefreshing }
        #expect(store.lists.home.count == 5)
        await gate.open()
        await refresh.value
        #expect(store.lists.home.first?.id == "thr_new")
        #expect(store.lists.home.count == 6)
        #expect(store.problem == nil)
    }

    @Test func aRefreshFromAnEmptyCopyFillsEveryList() async throws {
        let server = SampleServer()
        let store = try await makeStore(server, local: LocalStore())
        await store.start()  // no event stream: loads, refreshes once and returns
        #expect(store.lists.inboxes.count == 3)
        #expect(
            store.lists.home.map(\.id) == ["thr_14", "thr_1", "thr_2", "thr_12", "thr_16"])
        #expect(store.lists.screening.map(\.id) == ["thr_5"])
        #expect(store.lists.waiting.map(\.id) == ["thr_9"])
        #expect(store.lists.threads(in: .otp, inbox: nil).map(\.id) == ["thr_15"])
        #expect(store.lists.brief == SampleData.bundled.brief)
        #expect(store.lists.drafts.map(\.id) == ["drf_1"])
        #expect(store.lists.stacks[.setAside]?.map(\.id) == ["thr_10"])
        // act_8 and the AI's records are silent: the refresh fetched them (includeSilent), and Handled leaves them
        // out until asked.
        #expect(store.lists.handled.map(\.id) == ["act_2", "act_1", "act_4", "act_3", "act_21"])
        #expect(store.lists.silentCount == 10)
        #expect(await store.rules(inboxId: "inb_northwind").count == 2)
        #expect(store.counts == SampleData.bundled.counts && store.aiStatus == SampleData.bundled.aiStatus)
        let routes = Set(server.requests.map { $0.url!.path })
        #expect(
            routes.isSuperset(of: [
                "/v1/inboxes", "/v1/home", "/v1/categories/conversation", "/v1/categories/newsletter",
                "/v1/categories/invoice", "/v1/categories/receipt", "/v1/categories/notification",
                "/v1/categories/otp", "/v1/categories/unknown", "/v1/stacks/reply_later", "/v1/stacks/set_aside",
                "/v1/waiting", "/v1/screening", "/v1/counts", "/v1/ai/status", "/v1/ai", "/v1/handled", "/v1/drafts",
                "/v1/briefs/latest",
            ]))
        #expect(!routes.contains { $0.hasPrefix("/v1/piles") || $0 == "/v1/now" })
        #expect(server.requests.contains { $0.pathAndQuery == "/v1/handled?limit=200&includeSilent=true" })
        #expect(server.requests.contains { $0.pathAndQuery == "/v1/categories/unknown?limit=200" })
        #expect(server.requests.contains { $0.pathAndQuery == "/v1/screening?limit=200" })
    }

    @Test func openingAThreadShowsTheCopyThenTheServers() async throws {
        let server = SampleServer()
        let local = try LocalStore()
        let thread = SampleData.bundled.threads[0]
        try await local.write { try $0.upsert(threads: [thread]) }
        let store = try await makeStore(server, local: local)
        await store.open(threadID: "thr_1")
        #expect(store.openThread?.messages.map(\.id) == ["msg_1a", "msg_1b"])
        #expect(store.openThread?.drafts.map(\.id) == ["drf_1"])
        await store.open(threadID: nil)
        #expect(store.openThread == nil)
    }

    @Test func aRefusedTokenSignsOut() async throws {
        let server = SampleServer()
        server.failOnce("GET /v1/inboxes", with: .error("unauthorized", "Bad token", status: 401))
        let store = try await makeStore(server)
        var signedOut = false
        store.onUnauthorized = { signedOut = true }
        await store.refresh()
        #expect(signedOut)
    }

    @Test func anUnreachableServerLeavesTheCopyAndSaysOffline() async throws {
        let store = MailStore(
            client: APIClient(
                server: testServer, token: "t", transport: StubTransport { _ in throw URLError(.timedOut) }),
            local: try await LocalStore.sample(), clock: { SampleData.bundled.now })
        await store.start()
        #expect(store.lists.home.count == 5)
        #expect(store.counts == SampleData.bundled.counts)  // from the copy on disk
        #expect(store.problem == nil)
        guard case .offline = store.connection else {
            Issue.record("Expected offline, got \(store.connection)")
            return
        }
    }
}

@MainActor
struct MailStoreConnectionTests {
    final class Switch: Sendable {
        let isOffline = Mutex(true)
    }

    @Test func aRefreshThatWorksClearsOffline() async throws {
        let server = SampleServer()
        let network = Switch()
        let transport = StubTransport { request in
            if network.isOffline.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
            let (data, response) = try await server.data(for: request)
            return StubReply(status: response.statusCode, body: data)
        }
        let now = SampleData.bundled.now
        let store = MailStore(
            client: APIClient(server: testServer, token: "t", transport: transport), local: try LocalStore(),
            clock: { now })
        await store.refresh()
        #expect(store.connection != .live)
        #expect(store.lists.home.isEmpty && store.counts == nil)

        network.isOffline.withLock { $0 = false }
        await store.refresh()
        #expect(store.connection == .live)
        #expect(store.lists.home.count == 5 && store.counts != nil)
    }
}

@MainActor
struct MailStoreActionTests {
    @Test func anActionShowsAtOnceAndStaysWhenTheServerAgrees() async throws {
        let server = SampleServer()
        let gate = server.hold("POST /v1/actions")
        let store = try await makeStore(server)
        await store.loadFromDisk()

        let done = Task { await store.perform(.done, on: ["thr_1"]) }
        try await waitUntil("thr_1 leaves Home") { !store.lists.home.contains { $0.id == "thr_1" } }
        #expect(server.thread("thr_1")?.done == false)  // the server hasn't answered yet
        await gate.open()
        await done.value

        #expect(server.thread("thr_1")?.done == true)
        #expect(!store.lists.home.contains { $0.id == "thr_1" })
        // The server's answer carries the thread as it is now, which replaces what was shown.
        #expect(try await store.local.thread(id: "thr_1") == server.thread("thr_1"))
        #expect(try await store.local.thread(id: "thr_1")?.version == 7)
        let record = try #require(store.lastAction?.records.first)
        #expect(record.threadId == "thr_1" && record.state == .applied)
        #expect(try await store.local.action(id: record.id) == record)
        #expect(store.problem == nil)
        #expect(server.requests.last?.jsonBody == json(#"{"action":{"kind":"done"},"threadIds":["thr_1"]}"#))
    }

    @Test func anActionTheServerRefusesIsTakenBack() async throws {
        let server = SampleServer()
        let gate = server.hold("POST /v1/actions")
        server.failOnce("POST /v1/actions", with: .error("needs_person", "Only a person may", status: 403))
        let store = try await makeStore(server)
        await store.loadFromDisk()

        let file = Task { await store.perform(.categorize(.newsletter), on: ["thr_2", "thr_6"]) }
        try await waitUntil("both show as newsletters") {
            store.lists.threads(in: .newsletter, inbox: nil).count == 4
        }
        await gate.open()
        await file.value

        #expect(store.lists.threads(in: .newsletter, inbox: nil).map(\.id) == ["thr_8", "thr_4"])
        #expect(
            store.lists.home.map(\.id) == ["thr_14", "thr_1", "thr_2", "thr_12", "thr_16"])
        #expect(try await store.local.thread(id: "thr_2")?.category == .conversation)
        #expect(try await store.local.thread(id: "thr_2")?.categorizedBy == .person)
        #expect(store.problem?.message.contains("Only a person may") == true)
        #expect(store.lastAction == nil)
    }

    @Test func undoPutsTheThreadBack() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        await store.perform(.stack(.setAside), on: ["thr_2"])
        #expect(store.lists.stacks[.setAside]?.map(\.id) == ["thr_2", "thr_10"])

        let gate = server.hold("POST /v1/actions/\(store.lastAction!.records[0].id)/undo")
        let undo = Task { await store.undoLastAction() }
        try await waitUntil("thr_2 leaves Set aside") { store.lists.stacks[.setAside]?.map(\.id) == ["thr_10"] }
        await gate.open()
        await undo.value

        #expect(store.lists.stacks[.setAside]?.map(\.id) == ["thr_10"])
        #expect(server.thread("thr_2")?.stack == nil)
        #expect(store.lists.home.contains { $0.id == "thr_2" })
        #expect(try await store.local.thread(id: "thr_2")?.version == 8)  // 6, stacked 7, back 8
        #expect(store.lastAction == nil)
        let record = try #require(server.data.actions.last)
        #expect(try await store.local.action(id: record.id)?.state == .undone)
    }

    @Test func aFailedUndoIsTakenBack() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        await store.perform(.done, on: ["thr_12"])
        let record = try #require(store.lastAction?.records.first)
        server.failOnce("POST /v1/actions/\(record.id)/undo", with: .error("conflict", "Too late", status: 409))
        await store.undo(record)
        #expect(!store.lists.home.contains { $0.id == "thr_12" })
        #expect(try await store.local.action(id: record.id)?.state == .applied)
        #expect(store.problem?.message == "Too late")
    }

    @Test func undoingARulesActionAsksToTeach() async throws {
        let server = SampleServer()
        let sample = SampleData.bundled
        let prompt = TeachPrompt(
            id: "tch_1", question: "Always treat The Weekly Build as a conversation?",
            rule: RuleDraft(
                inboxId: "inb_northwind", text: "The Weekly Build is a conversation",
                match: RuleMatch(listId: "weekly-build.weeklybuild.example"), then: [.categorize(.conversation)]),
            fromActionId: "act_3", expiresAt: sample.now.addingTimeInterval(86_400))
        server.state.withLock { $0.teach = prompt }
        let store = try await makeStore(server)
        await store.loadFromDisk()

        let record = try #require(store.lists.handled.first { $0.id == "act_3" }?.record)
        await store.undo(record)
        #expect(!store.lists.handled.contains { $0.id == "act_3" })  // undone leaves Handled's default view
        #expect(store.teachPrompt == prompt)

        await store.answerTeach(accept: true)
        #expect(store.teachPrompt == nil)
        #expect(await store.rules(inboxId: "inb_northwind").map(\.id).contains("rul_new"))
        #expect(server.requests.last?.jsonBody == json(#"{"accept":true}"#))
    }

    @Test func anExpiredTeachPromptIsNotShown() async throws {
        let server = SampleServer()
        let sample = SampleData.bundled
        server.state.withLock {
            $0.teach = TeachPrompt(
                id: "tch_old", question: "?",
                rule: RuleDraft(inboxId: "inb_northwind", text: "", match: RuleMatch(from: "a@b.example"), then: []),
                fromActionId: "x", expiresAt: sample.now.addingTimeInterval(-1))
        }
        let store = try await makeStore(server)
        await store.loadFromDisk()
        await store.perform(.categorize(.newsletter), on: ["thr_1"])
        #expect(store.teachPrompt == nil)
    }

    @Test func approvingAProposalAppliesIt() async throws {
        let server = SampleServer()
        let gate = server.hold("POST /v1/actions/approve")
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let proposal = try #require(store.lists.proposals(inbox: nil).first)
        #expect(proposal.id == "act_4")

        // Claude Code proposed marking thr_8 done.
        let approve = Task { await store.approve([proposal.record]) }
        try await waitUntil("thr_8 is done") {
            !store.lists.threads(in: .newsletter, inbox: nil).contains { $0.id == "thr_8" }
        }
        #expect(store.lists.handled.first { $0.id == "act_4" }?.record.state == .applied)
        await gate.open()
        await approve.value

        #expect(server.data.actions.first { $0.id == "act_4" }?.state == .applied)
        #expect(try await store.local.thread(id: "thr_8")?.done == true)
        #expect(store.lists.proposals(inbox: nil).isEmpty)
        #expect(try await store.local.action(id: "act_4")?.version == 2)
        #expect(try await store.local.thread(id: "thr_8")?.version == 5)
        #expect(server.requests.last?.jsonBody == json(#"{"actionIds":["act_4"]}"#))
    }

    @Test func rejectingAProposalLeavesTheThread() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let proposal = try #require(store.lists.proposals(inbox: nil).first)
        await store.reject([proposal.record])
        #expect(server.data.actions.first { $0.id == "act_4" }?.state == .rejected)
        #expect(!store.lists.handled.contains { $0.id == "act_4" })
        #expect(store.lists.threads(in: .newsletter, inbox: nil).contains { $0.id == "thr_8" })
        #expect(try await store.local.action(id: "act_4")?.state == .rejected)
    }

    @Test func aProposalThatNoLongerFitsIsTakenBack() async throws {
        let server = SampleServer()
        server.failOnce("POST /v1/actions/approve", with: .error("conflict", "Thread changed", status: 409))
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let proposal = try #require(store.lists.proposals(inbox: nil).first)
        await store.approve([proposal.record])
        #expect(store.lists.proposals(inbox: nil).map(\.id) == ["act_4"])
        #expect(store.lists.threads(in: .newsletter, inbox: nil).contains { $0.id == "thr_8" })
        #expect(store.problem?.message.contains("changed since") == true)
    }

    @Test func lettingASenderInBringsTheThreadIntoHome() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        await store.perform(.allowSender, on: ["thr_5"])
        #expect(server.requests.last?.jsonBody == json(#"{"action":{"kind":"allow_sender"},"threadIds":["thr_5"]}"#))
        #expect(store.lists.screening.isEmpty)
        #expect(store.lists.home.prefix(2).map(\.id) == ["thr_14", "thr_5"])
        #expect(try await store.local.thread(id: "thr_5")?.category == .conversation)  // its category stays
        #expect(store.lastAction?.action == .allowSender)
    }

    @Test func blockingASenderMarksTheThreadDone() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        await store.perform(.blockSender, on: ["thr_5"])
        #expect(server.requests.last?.jsonBody == json(#"{"action":{"kind":"block_sender"},"threadIds":["thr_5"]}"#))
        #expect(store.lists.screening.isEmpty)
        #expect(try await store.local.thread(id: "thr_5")?.done == true)
        await store.undoLastAction()
        #expect(store.lists.screening.map(\.id) == ["thr_5"])
    }

    @Test func pendingChangesSurviveARefresh() async throws {
        let server = SampleServer()
        let gate = server.hold("POST /v1/actions")
        let store = try await makeStore(server)
        await store.loadFromDisk()

        let done = Task { await store.perform(.done, on: ["thr_1"]) }
        try await waitUntil("thr_1 leaves Home") { !store.lists.home.contains { $0.id == "thr_1" } }
        await store.refresh()  // the server still lists thr_1 as not done
        #expect(!store.lists.home.contains { $0.id == "thr_1" })
        await gate.open()
        await done.value
        #expect(!store.lists.home.contains { $0.id == "thr_1" })
    }
}
