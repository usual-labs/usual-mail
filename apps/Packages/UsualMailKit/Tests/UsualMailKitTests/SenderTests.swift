import Foundation
import Testing

@testable import UsualMailKit

/// Letting a sender in, or blocking them, changes every thread of theirs in that inbox at once (the thread's
/// `sender`), not only the one the person acted on.
@MainActor
struct SenderTests {
    /// The store with a second thread from the named thread's sender added to the copy.
    private func storeWithSibling(of id: String, as siblingID: String) async throws -> (MailStore, SampleServer) {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        var sibling = try #require(await store.currentThread(id: id))
        sibling.id = siblingID
        sibling.done = false
        await store.save(threads: [sibling])
        await store.reloadLists()
        return (store, server)
    }

    @Test func lettingASenderInUnscreensAllTheirThreads() async throws {
        let (store, _) = try await storeWithSibling(of: "thr_5", as: "thr_5b")
        #expect(store.lists.screening.map(\.id).contains("thr_5b"))
        await store.perform(.allowSender, on: ["thr_5"])
        let sibling = try #require(await store.currentThread(id: "thr_5b"))
        #expect(!sibling.screened)
        #expect(!store.lists.screening.contains { $0.id == "thr_5" || $0.id == "thr_5b" })
    }

    @Test func blockingASenderMarksAllTheirThreadsDone() async throws {
        let (store, _) = try await storeWithSibling(of: "thr_14", as: "thr_14b")
        await store.perform(.blockSender, on: ["thr_14"])
        let sibling = try #require(await store.currentThread(id: "thr_14b"))
        #expect(sibling.done)
        #expect(!store.lists.home.contains { $0.id == "thr_14b" })
    }

    @Test func anotherSendersThreadsAreLeftAlone() async throws {
        let (store, _) = try await storeWithSibling(of: "thr_5", as: "thr_5b")
        let before = try #require(await store.currentThread(id: "thr_1"))
        await store.perform(.allowSender, on: ["thr_5"])
        #expect(try #require(await store.currentThread(id: "thr_1")) == before)
    }
}
