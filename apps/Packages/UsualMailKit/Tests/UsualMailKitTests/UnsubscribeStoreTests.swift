import Foundation
import Testing

@testable import UsualMailKit

/// The store's unsubscribing (docs/contract.md, "Unsubscribing"): the person's block first, with its undo strip, then the
/// request; the answer and `unsubscribe.changed` on the sender's row in the Blocked tab; a refused block asking nothing,
/// a refused request said as any refusal is.
@MainActor
struct UnsubscribeStoreTests {
    let sample = SampleData.bundled
    /// Coffee Roasters Monthly, a Feed post in Harbor.
    let roasters = SenderKey(inboxId: "inb_harbor", address: "news@roastersmonthly.example")

    private func sent(_ server: SampleServer) -> [String] {
        server.requests.map { "\($0.httpMethod!) \($0.pathAndQuery)" }
    }

    @Test func itBlocksThenAsks() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let answer = try #require(await store.unsubscribe(threadID: "thr_8"))
        #expect(answer.state == .working && answer.key == roasters && answer.threadId == "thr_8")
        #expect(sent(server) == ["POST /v1/actions", "POST /v1/threads/thr_8/unsubscribe"])
        #expect(server.requests[0].jsonBody?["action"] == json(#"{"kind":"block_sender"}"#))
        #expect(server.requests[1].httpBody == nil)
        // The block shows as any block does: the post archived, the strip offering to unblock.
        #expect(try await store.local.thread(id: "thr_8")?.done == true)
        #expect(
            store.lastAction?.action == .blockSender
                && store.lastAction?.words == "Blocked, and asking them to stop. Undo only unblocks.")
        #expect(store.problem == nil)
        // The Blocked tab: their row carries the request, and the server's work moves it on.
        await store.loadBlockedSenders()
        let row = try #require(store.blockedSenders?.items.first)
        #expect(row.id == roasters && row.unsubscribe == answer)
        let done = server.moveUnsubscribe(roasters) {
            $0.state = .done
            $0.way = .oneClick
        }
        await store.receive(.unsubscribeChanged(done))
        #expect(store.blockedSenders?.items.first?.unsubscribe?.state == .done)
        // A copy from before, arriving late, doesn't take it back.
        await store.receive(.unsubscribeChanged(answer))
        #expect(store.blockedSenders?.items.first?.unsubscribe?.way == .oneClick)
        // Undo unblocks; the request stays asked.
        await store.undoLastAction()
        #expect(sent(server).last?.hasSuffix("/undo") == true)
        #expect(server.unsubscribe(for: roasters)?.state == .done)
    }

    /// With the Blocked tab loaded, the answer waits for the sender's row, which `sender.changed` brings after.
    @Test func theAnswerWaitsForItsRow() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        await store.loadBlockedSenders()
        await store.unsubscribe(threadID: "thr_8")
        #expect(store.blockedSenders?.contains(roasters) == false)
        let row = BlockedSender(inboxId: "inb_harbor", address: roasters.address, blockedAt: sample.now)
        await store.receive(
            .senderChanged(SenderChange(inboxId: "inb_harbor", address: roasters.address, blocked: true, sender: row)))
        #expect(store.blockedSenders?.items.first?.unsubscribe?.state == .working)
    }

    @Test func anEventDuringTheLoadIsAppliedOnTopOfIt() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let answer = try #require(await store.unsubscribe(threadID: "thr_8"))
        let gate = server.holdAnswer("GET /v1/senders")
        let load = Task { await store.loadBlockedSenders() }
        try await waitUntil("the load has its answer") { server.hasAnswered("GET /v1/senders") }
        var failed = answer
        failed.state = .failed
        failed.detail = "Their mail offers no way to unsubscribe."
        failed.version = answer.version + 2
        await store.receive(.unsubscribeChanged(failed))
        await gate.open()
        await load.value
        #expect(store.blockedSenders?.items.first?.unsubscribe == failed)
    }

    @Test func aRefusedRequestIsSaidAndTheBlockStays() async throws {
        let server = SampleServer()
        server.failOnce(
            "POST /v1/threads/thr_8/unsubscribe", with: .error("invalid", "This thread has no sender.", status: 400))
        let store = try await makeStore(server)
        await store.loadFromDisk()
        #expect(await store.unsubscribe(threadID: "thr_8") == nil)
        #expect(store.problem?.message == "This thread has no sender.")
        #expect(try await store.local.thread(id: "thr_8")?.done == true)
        #expect(store.lastAction?.action == .blockSender)
    }

    /// A server older than 0.1.5 (the security review of 2026-11-27): once it said its version, the swipe only blocks
    /// and the strip says why; one that didn't say, whose route is missing, is told in the same words, not as a 404.
    @Test func anOlderServerOnlyBlocksAndSaysSo() async throws {
        #expect(MailStore.version("0.1.5", isAtLeast: "0.1.5") && MailStore.version("0.2.0-dev", isAtLeast: "0.1.5"))
        #expect(!MailStore.version("0.1.4", isAtLeast: "0.1.5") && MailStore.version("weird", isAtLeast: "0.1.5"))
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        #expect(store.serverUnsubscribes, "not known yet: asking answers for itself")
        store.serverInfo = ServerInfo(name: "usual-mail", version: "0.1.4", apiVersion: 1)
        #expect(!store.serverUnsubscribes)
        #expect(await store.unsubscribe(threadID: "thr_8") == nil)
        #expect(sent(server) == ["POST /v1/actions"])
        #expect(store.lastAction?.words == MailStore.oldServerWords)

        let unknown = SampleServer()
        unknown.failOnce(
            "POST /v1/threads/thr_8/unsubscribe", with: .error("not_found", "No such route", status: 404))
        let asked = try await makeStore(unknown)
        await asked.loadFromDisk()
        #expect(await asked.unsubscribe(threadID: "thr_8") == nil)
        #expect(asked.problem?.message == MailStore.oldServerWords)
    }

    @Test func aRefusedBlockAsksNothing() async throws {
        let server = SampleServer()
        server.failOnce("POST /v1/actions", with: .error("forbidden", "Not in this inbox.", status: 403))
        let store = try await makeStore(server)
        await store.loadFromDisk()
        #expect(await store.unsubscribe(threadID: "thr_8") == nil)
        #expect(sent(server) == ["POST /v1/actions"])
        #expect(store.problem?.message == "Not in this inbox.")
        #expect(try await store.local.thread(id: "thr_8")?.done == false)
        #expect(server.unsubscribe(for: roasters) == nil)
    }

    @Test func theSampleAsksNothing() async throws {
        let store = try await MailStore.sample()
        #expect(await store.unsubscribe(threadID: "thr_8") == nil)
        #expect(store.blockedSenders?.items == sample.blockedSenders)
    }
}

/// Settings' Browser Use key: saved through the AI's settings, its state the server's test, never kept on the device,
/// a refusal said by the setting without the key, and removed with `null`.
@MainActor
struct BrowserAgentSetupTests {
    @Test func savingSendsTheKeyOnceAndKeepsTheState() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let setup = BrowserAgentSetup(store: store)
        #expect(setup.settings == nil && !setup.isBusy)
        #expect(await setup.save(key: "  not-a-real-key \n"))
        let request = try #require(server.requests.last)
        #expect(request.httpMethod == "PATCH" && request.pathAndQuery == "/v1/ai")
        #expect(request.jsonBody == json(#"{"browserAgent":{"service":"browser_use","apiKey":"not-a-real-key"}}"#))
        #expect(setup.settings == BrowserAgentSettings(service: .browserUse, state: .working))
        #expect(setup.refusal == nil && store.problem == nil && !setup.isBusy)
        let stored = String(
            decoding: try StoredJSON.encode(try #require(try await store.local.status().aiSettings)), as: UTF8.self)
        #expect(stored.contains("browser_use") && !stored.contains("not-a-real-key"))
        // An empty key sends nothing.
        #expect(await setup.save(key: "  ") == false)
        #expect(server.requests.count == 1)
    }

    @Test func aRefusedKeyIsTheServersStateToShow() async throws {
        let server = SampleServer()
        server.state.withLock {
            $0.browserAgentTest = BrowserAgentSettings(
                service: .browserUse, state: .keyRefused, detail: "Browser Use refused the key.")
        }
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let setup = BrowserAgentSetup(store: store)
        #expect(await setup.save(key: "not-a-real-key"))
        #expect(setup.settings?.state == .keyRefused && setup.settings?.detail == "Browser Use refused the key.")
    }

    @Test func aRefusalIsSaidHereWithoutTheKey() async throws {
        let server = SampleServer()
        server.failOnce("PATCH /v1/ai", with: .error("invalid", "The key not-a-real-key is malformed", status: 400))
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let setup = BrowserAgentSetup(store: store)
        #expect(await setup.save(key: "not-a-real-key") == false)
        #expect(setup.refusal == "The key ••• is malformed" && store.problem == nil)
        #expect(setup.settings == nil)
    }

    @Test func removingSendsNull() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let setup = BrowserAgentSetup(store: store)
        await setup.save(key: "not-a-real-key")
        #expect(await setup.remove())
        #expect(server.requests.last?.jsonBody == json(#"{"browserAgent":null}"#))
        #expect(setup.settings == nil && store.aiSettings != nil)
    }
}
