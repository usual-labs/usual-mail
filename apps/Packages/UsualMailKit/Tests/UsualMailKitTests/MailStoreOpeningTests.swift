import Foundation
import Testing

@testable import UsualMailKit

/// Opening a thread marks it read, as the person's own `read` action, without making it the action to undo.
@MainActor
struct MailStoreOpeningTests {
    private let readBody = json(#"{"action":{"kind":"read"},"threadIds":["thr_1"]}"#)

    @Test func openingAnUnreadThreadMarksItRead() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        await store.perform(.stack(.setAside), on: ["thr_2"])
        let earlier = store.lastAction

        await store.open(threadID: "thr_1")
        let marks = server.requests.filter { $0.pathAndQuery == "/v1/actions" && $0.jsonBody == readBody }
        #expect(marks.count == 1)
        #expect(server.thread("thr_1")?.unread == false)
        #expect(try await store.local.thread(id: "thr_1")?.unread == false)
        #expect(store.openThread?.thread.unread == false)
        #expect(store.openThread?.messages.allSatisfy { !$0.unread } == true)
        // It isn't offered as the action to undo; the person's own last action still is.
        #expect(store.lastAction == earlier)

        // Opening it again asks nothing more.
        await store.open(threadID: nil)
        await store.open(threadID: "thr_1")
        #expect(server.requests.filter { $0.pathAndQuery == "/v1/actions" }.count == 2)
    }

    @Test func openingAReadThreadChangesNothing() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        await store.open(threadID: "thr_7")  // read
        #expect(!server.requests.contains { $0.url?.path == "/v1/actions" })
    }

    @Test func aThreadNotOnTheDeviceIsMarkedOnceTheServerSaysItIsUnread() async throws {
        let server = SampleServer()
        let store = try await makeStore(server, local: try LocalStore())
        await store.open(threadID: "thr_1")
        #expect(
            server.requests.map(\.pathAndQuery) == ["/v1/threads/thr_1", "/v1/actions"])
        #expect(try await store.local.thread(id: "thr_1")?.unread == false)
    }

    @Test func aTrashedThreadIsNotMarked() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        // Trashed at the provider, unread.
        let thread = server.change("thr_12") { $0.trashed = true }
        await store.receive(.threadChanged(thread))
        await store.open(threadID: "thr_12")
        #expect(!server.requests.contains { $0.url?.path == "/v1/actions" })
    }

    @Test func offlineTheMarkIsTakenBackQuietly() async throws {
        let store = MailStore(
            client: APIClient(
                server: testServer, token: "t",
                transport: StubTransport { _ in throw URLError(.notConnectedToInternet) }),
            local: try await LocalStore.sample(), clock: { SampleData.bundled.now })
        await store.loadFromDisk()
        await store.open(threadID: "thr_1")
        #expect(store.problem == nil)
        #expect(try await store.local.thread(id: "thr_1")?.unread == true)
        #expect(store.openThread?.messages.map(\.id) == ["msg_1a", "msg_1b"])
    }

    @Test func onlyLookingMarksNothing() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.open(threadID: "thr_1", markingRead: false)
        #expect(server.requests.map(\.pathAndQuery) == ["/v1/threads/thr_1"])
    }
}
