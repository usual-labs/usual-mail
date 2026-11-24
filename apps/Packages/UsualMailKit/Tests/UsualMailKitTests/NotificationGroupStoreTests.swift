import Foundation
import Testing

@testable import UsualMailKit

/// What the Notifications tab asks of the store for a group's row (docs/contract.md, "Notification groups"): an action
/// on the row reaches every thread in the group with one undo, and opening the row marks every thread read as one
/// action, the way opening one thread does, without marking its newest twice.
@MainActor
struct NotificationGroupStoreTests {
    /// The walking boots' parcel, newest mail first: delivered, out for delivery, arriving.
    private let parcel = ["thr_21", "thr_24", "thr_23"]

    private func actions(_ server: SampleServer) -> [URLRequest] {
        server.requests.filter { $0.pathAndQuery == "/v1/actions" }
    }

    @Test func anActionOnAGroupReachesEveryThreadWithOneUndo() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()

        await store.perform(.done, on: parcel)
        #expect(actions(server).count == 1)
        #expect(
            actions(server).last?.jsonBody
                == json(#"{"action":{"kind":"done"},"threadIds":["thr_21","thr_24","thr_23"]}"#))
        for id in parcel {
            #expect(server.thread(id)?.done == true, "\(id)")
            #expect(!store.lists.threads(in: .notification, inbox: nil).contains { $0.id == id }, "\(id)")
        }
        // Each recorded, one undo for them all.
        let recent = try #require(store.lastAction)
        #expect(recent.action == .done && Set(recent.records.map(\.threadId)) == Set(parcel))

        await store.undoLastAction()
        for id in parcel {
            #expect(server.thread(id)?.done == false, "\(id)")
            #expect(store.lists.threads(in: .notification, inbox: nil).contains { $0.id == id }, "\(id)")
        }
        #expect(store.lastAction == nil)
    }

    @Test func openingAGroupMarksEveryUnreadThreadReadAsOneAction() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        for id in ["thr_21", "thr_23"] {
            await store.receive(.threadChanged(server.change(id) { $0.unread = true }))
        }
        await store.perform(.stack(.setAside), on: ["thr_2"])
        let earlier = store.lastAction
        let before = actions(server).count

        // The row's newest opens while the group is marked, as the tab does it.
        let gate = server.hold("POST /v1/actions")
        let marking = Task { await store.markRead(opening: ["thr_21", "thr_23"]) }
        let opening = Task { await store.open(threadID: "thr_21") }
        try await waitUntil("both show as read") {
            store.lists.threads(in: .notification, inbox: nil).filter { ["thr_21", "thr_23"].contains($0.id) }
                .allSatisfy { !$0.unread }
        }
        await gate.open()
        await marking.value
        await opening.value

        let marks = actions(server).dropFirst(before)
        #expect(marks.count == 1)
        #expect(marks.first?.jsonBody == json(#"{"action":{"kind":"read"},"threadIds":["thr_21","thr_23"]}"#))
        #expect(server.thread("thr_21")?.unread == false && server.thread("thr_23")?.unread == false)
        #expect(try await store.local.thread(id: "thr_23")?.unread == false)
        #expect(store.openThread?.thread.id == "thr_21" && store.openThread?.thread.unread == false)
        // As opening one thread: not offered to undo.
        #expect(store.lastAction == earlier)

        // Afterwards opening one of them on its own marks as usual: nothing, since it is read.
        await store.open(threadID: "thr_23")
        #expect(actions(server).count == before + 1)
    }

    @Test func openingAThreadBehindTheRowMarksOnlyThatOne() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        for id in parcel {
            await store.receive(.threadChanged(server.change(id) { $0.unread = true }))
        }
        await store.open(threadID: "thr_24")
        #expect(
            actions(server).map(\.jsonBody)
                == [json(#"{"action":{"kind":"read"},"threadIds":["thr_24"]}"#)])
        #expect(server.thread("thr_21")?.unread == true && server.thread("thr_23")?.unread == true)
    }
}
