import Foundation
import Testing

@testable import UsualMailKit

/// Handled keeps the records of trashed threads, each with its thread, and a client keeps a trashed thread while it
/// holds a record for it (docs/contract.md, "Lists"). The server lists no trashed thread anywhere but Handled, so a
/// refresh must not take that missing for gone.
struct TrashedThreadReconcileTests {
    let sample = SampleData.bundled

    /// The sample after an agent's trash of thr_8 was approved (act_4) and the person trashed thr_12 themselves.
    private func trashed() throws -> (data: SampleData, threads: [MailThread], records: [ActionRecord]) {
        var data = sample
        let eight = try #require(data.threads.firstIndex { $0.id == "thr_8" })
        data.threads[eight].trashed = true
        data.threads[eight].version += 1
        let twelve = try #require(data.threads.firstIndex { $0.id == "thr_12" })
        data.threads[twelve].trashed = true
        data.threads[twelve].version += 1
        let proposal = try #require(data.actions.firstIndex { $0.id == "act_4" })
        data.actions[proposal].action = .trash
        data.actions[proposal].state = .applied
        data.actions[proposal].undoable = true
        data.actions[proposal].version += 1
        let own = ActionRecord(
            id: "act_own", threadId: "thr_12", inboxId: "inb_personal", action: .trash,
            actor: .person(deviceId: "dev_test"), state: .applied, at: data.now, undoable: true)
        data.actions.append(own)
        return (data, [data.threads[eight], data.threads[twelve]], [data.actions[proposal], own])
    }

    @Test func aTrashedThreadStaysWithItsMessagesWhileARecordIsHeld() async throws {
        let store = try await LocalStore.sample()
        let (data, threads, records) = try trashed()
        try await store.write { writer in
            try writer.upsert(threads: threads)
            try writer.upsert(actions: records)
        }
        // As the server answers now: no list of threads has either one; Handled carries act_4 with its trashed thread;
        // act_own is the person's own, so no list the refresh reads mentions thr_12 at all.
        let fresh = LocalStoreReconcileTests.snapshot(data)
        #expect(!fresh.openThreads.contains { $0.trashed })
        try await store.write { try $0.reconcile(fresh) }

        let agents = try #require(try await store.detail(threadId: "thr_8"))
        #expect(agents.thread.trashed && agents.messages.map(\.id) == ["msg_8a"])
        let own = try #require(try await store.detail(threadId: "thr_12"))
        #expect(own.thread.trashed && own.messages.map(\.id) == ["msg_12a"])
        let lists = try await store.lists(at: sample.now)
        #expect(lists.handled.first { $0.id == "act_4" }?.thread.trashed == true)
        #expect(!lists.home.contains { ["thr_8", "thr_12"].contains($0.id) })
        #expect(!lists.categories.values.joined().contains { ["thr_8", "thr_12"].contains($0.id) })
    }

    @Test func aTrashedThreadWithNoRecordLeaves() async throws {
        let store = try await LocalStore.sample()
        var data = sample
        let index = try #require(data.threads.firstIndex { $0.id == "thr_12" })
        data.threads[index].trashed = true  // trashed at the provider; the device holds no record of it
        data.threads[index].version += 1
        let thread = data.threads[index]
        let fresh = LocalStoreReconcileTests.snapshot(data)
        try await store.write { try $0.upsert(threads: [thread]) }
        try await store.write { try $0.reconcile(fresh) }
        #expect(try await store.thread(id: "thr_12") == nil)
    }

    @Test func aRemovedThreadTakesItsRecordsOutOfHandled() async throws {
        let store = try await LocalStore.sample()
        try await store.write { try $0.removeThread(id: "thr_3") }  // thread.removed
        #expect(try await store.actions(threadId: "thr_3").isEmpty)
        #expect(try await store.handled().map(\.id) == ["act_4", "act_3", "act_21"])
    }
}

/// The same through the store and the stand-in server: approve a trash, refresh, and undo it from Handled.
@MainActor
struct TrashedThreadStoreTests {
    @Test func anApprovedTrashStaysInHandledAfterARefreshAndCanBeUndone() async throws {
        var data = SampleData.bundled
        let proposal = try #require(data.actions.firstIndex { $0.id == "act_4" })
        data.actions[proposal].action = .trash  // the agent proposed to trash thr_8
        let server = SampleServer(data)
        let store = try await makeStore(server, local: try LocalStore())
        await store.refresh()
        await store.open(threadID: "thr_8")
        await store.open(threadID: nil)
        let record = try #require(store.lists.proposals(inbox: nil).first?.record)

        await store.approve([record])
        #expect(store.lists.handled.first { $0.id == "act_4" }?.thread.trashed == true)
        await store.refresh()

        let item = try #require(store.lists.handled.first { $0.id == "act_4" })
        #expect(item.thread.trashed && item.record.state == .applied && item.record.undoable)
        #expect(try await store.local.detail(threadId: "thr_8")?.messages.map(\.id) == ["msg_8a"])
        #expect(!store.lists.threads(in: .newsletter, inbox: nil).contains { $0.id == "thr_8" })

        await store.undo(item.record)
        #expect(store.lists.threads(in: .newsletter, inbox: nil).contains { $0.id == "thr_8" })
        #expect(server.thread("thr_8")?.trashed == false)
        #expect(store.problem == nil)
    }

    @Test func thePersonsOwnTrashIsKeptThroughARefreshForItsUndo() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        await store.perform(.trash, on: ["thr_12"])
        #expect(!store.lists.home.contains { $0.id == "thr_12" })
        await store.refresh()
        #expect(try await store.local.thread(id: "thr_12")?.trashed == true)
        // The thread view offers this record's undo.
        let trash = try #require(await store.trashRecord(threadId: "thr_12"))
        #expect(trash.actor == .person(deviceId: "dev_test"))
        await store.undoLastAction()
        #expect(store.lists.home.contains { $0.id == "thr_12" })
        #expect(try await store.local.detail(threadId: "thr_12")?.messages.map(\.id) == ["msg_12a"])
        #expect(await store.trashRecord(threadId: "thr_12") == nil)  // undone
    }
}
