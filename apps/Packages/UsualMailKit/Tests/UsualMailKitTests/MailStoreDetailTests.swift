import Foundation
import Testing

@testable import UsualMailKit

/// Looking at a thread without opening it (the feed's posts): the server's copy, stored on the device, never marked
/// read, the open thread left as it was, and the device's copy while offline.
@MainActor
struct MailStoreDetailTests {
    @Test func itIsTheServersCopyStoredOnTheDevice() async throws {
        let server = SampleServer()
        // A new issue in the newsletter's thread that the device hasn't seen.
        let newer = server.state.withLock { state in
            var message = state.data.messages.first { $0.id == "msg_4a" }!
            message.id = "msg_4b"
            message.date = state.data.now
            state.data.messages.append(message)
            let index = state.data.threads.firstIndex { $0.id == "thr_4" }!
            state.data.threads[index].messageCount = 2
            state.data.threads[index].lastMessageAt = state.data.now
            state.data.threads[index].version += 1
            return state.data.detail(threadId: "thr_4")!
        }
        let store = try await makeStore(server)
        await store.loadFromDisk()

        let detail = await store.detail(threadID: "thr_4")
        #expect(detail == newer)
        #expect(detail?.messages.map(\.id) == ["msg_4a", "msg_4b"])
        #expect(server.requests.map(\.pathAndQuery) == ["/v1/threads/thr_4"])
        // Stored as opening stores it, so the lists show the thread as the server has it.
        #expect(try await store.local.detail(threadId: "thr_4")?.messages.map(\.id) == ["msg_4a", "msg_4b"])
        #expect(store.lists.thread(id: "thr_4")?.messageCount == 2)
    }

    @Test func aThreadNotOnTheDeviceIsStoredAndListed() async throws {
        let server = SampleServer()
        let store = try await makeStore(server, local: try LocalStore())
        let detail = await store.detail(threadID: "thr_8")
        #expect(detail?.messages.map(\.id) == ["msg_8a"])
        #expect(store.lists.threads(in: .newsletter, inbox: nil).map(\.id) == ["thr_8"])
    }

    @Test func lookingDoesNotMarkAnUnreadThreadRead() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        #expect(server.thread("thr_4")?.unread == true)

        let detail = await store.detail(threadID: "thr_4")
        #expect(detail?.thread.unread == true)
        #expect(!server.requests.contains { $0.url?.path == "/v1/actions" })
        #expect(server.thread("thr_4")?.unread == true)
        #expect(try await store.local.thread(id: "thr_4")?.unread == true)
        #expect(store.lists.thread(id: "thr_4")?.unread == true)
        #expect(store.lastAction == nil)
    }

    @Test func theOpenThreadIsLeftAsItWas() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()

        _ = await store.detail(threadID: "thr_4")
        #expect(store.openThreadID == nil)
        #expect(store.openThread == nil)

        await store.open(threadID: "thr_1", markingRead: false)
        let open = store.openThread
        _ = await store.detail(threadID: "thr_8")
        #expect(store.openThreadID == "thr_1")
        #expect(store.openThread == open)
        #expect(store.openThread?.thread.id == "thr_1")
    }

    @Test func offlineItIsTheDevicesCopyQuietly() async throws {
        let store = MailStore(
            client: APIClient(
                server: testServer, token: "t",
                transport: StubTransport { _ in throw URLError(.notConnectedToInternet) }),
            local: try await LocalStore.sample(), clock: { SampleData.bundled.now })
        await store.loadFromDisk()

        let detail = await store.detail(threadID: "thr_4")
        #expect(detail?.thread.id == "thr_4")
        #expect(detail?.messages.map(\.id) == ["msg_4a"])
        #expect(store.problem == nil)
        #expect(store.connection == .offline("Can't reach your server. This device is offline."))
        // Nothing on the device and no server: nothing to show.
        #expect(await store.detail(threadID: "thr_missing") == nil)
    }

    @Test func aRefusalRaisesNoProblem() async throws {
        let server = SampleServer()
        server.failOnce("GET /v1/threads/thr_4", with: .error("internal", "Something broke", status: 500))
        let store = try await makeStore(server)
        await store.loadFromDisk()

        let detail = await store.detail(threadID: "thr_4")
        #expect(detail?.messages.map(\.id) == ["msg_4a"])
        #expect(store.problem == nil)
    }
}
