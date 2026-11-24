import Foundation
import Testing

@testable import UsualMailKit

/// The person's own lists (To reply, Pinned, Snoozed) follow their actions at once, before the server answers, and the
/// server's answer and Undo keep them right (owner's words of 2026-11-20: "when I set something manually to snooze,
/// reply or pin, it should appear in those lists").
@MainActor
struct MailStoreListMoveTests {
    private func pinned(_ store: MailStore) -> [String] { store.lists.threads(on: .setAside, inbox: nil).map(\.id) }
    private func toReply(_ store: MailStore) -> [String] { store.lists.threads(on: .replyLater, inbox: nil).map(\.id) }
    private func snoozed(_ store: MailStore) -> [String] { store.lists.waiting(inbox: nil).map(\.id) }
    private func inHome(_ store: MailStore, _ id: String) -> Bool { store.lists.home.contains { $0.id == id } }

    @Test func aPinnedThreadJoinsPinnedAndLeavesHomeAtOnce() async throws {
        let server = SampleServer()
        let gate = server.hold("POST /v1/actions")
        let store = try await makeStore(server)
        await store.loadFromDisk()
        #expect(inHome(store, "thr_2"))

        let pin = Task { await store.perform(.stack(.setAside), on: ["thr_2"]) }
        // Newest first: the design-role candidates (16 Nov) above the train tickets (11 Nov).
        try await waitUntil("thr_2 shows in Pinned") { pinned(store) == ["thr_2", "thr_10"] }
        #expect(!inHome(store, "thr_2"))
        #expect(server.thread("thr_2")?.stack == nil)  // the server hasn't answered yet
        await gate.open()
        await pin.value

        #expect(server.thread("thr_2")?.stack == .setAside)
        #expect(pinned(store) == ["thr_2", "thr_10"] && !inHome(store, "thr_2"))
        #expect(store.lastAction?.action == .stack(.setAside))
    }

    @Test func unpinnedItLeavesPinnedAndComesBackToHomeAtOnceWithUndo() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        await store.perform(.stack(.setAside), on: ["thr_2"])
        #expect(pinned(store) == ["thr_2", "thr_10"])

        let gate = server.hold("POST /v1/actions")
        let unpin = Task { await store.perform(.unstack, on: ["thr_2"]) }
        try await waitUntil("thr_2 leaves Pinned") { pinned(store) == ["thr_10"] }
        #expect(inHome(store, "thr_2"))
        await gate.open()
        await unpin.value
        #expect(pinned(store) == ["thr_10"] && inHome(store, "thr_2"))
        #expect(server.thread("thr_2")?.stack == nil)

        // The usual undo puts it back on Pinned.
        #expect(store.lastAction?.action == .unstack)
        await store.undoLastAction()
        #expect(pinned(store) == ["thr_2", "thr_10"] && !inHome(store, "thr_2"))
        #expect(server.thread("thr_2")?.stack == .setAside)
    }

    @Test func removedFromToReplyItComesBackToHome() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        #expect(toReply(store) == ["thr_7"] && !inHome(store, "thr_7"))

        await store.perform(.unstack, on: ["thr_7"])
        #expect(toReply(store).isEmpty && inHome(store, "thr_7"))
        // And back again, through Reply later.
        await store.perform(.stack(.replyLater), on: ["thr_7"])
        #expect(toReply(store) == ["thr_7"] && !inHome(store, "thr_7"))
    }

    @Test func aPinnedReceiptLeavesPinnedForReceiptsOnly() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        // The train tickets are a receipt: on Pinned and in the receipts list, never in Home.
        #expect(store.lists.threads(in: .receipt, inbox: nil).map(\.id).contains("thr_10"))
        await store.perform(.unstack, on: ["thr_10"])
        #expect(pinned(store).isEmpty && !inHome(store, "thr_10"))
        #expect(store.lists.threads(in: .receipt, inbox: nil).map(\.id).contains("thr_10"))
    }

    @Test func aSnoozedThreadJoinsSnoozedSoonestFirstAndLeavesHomeAtOnce() async throws {
        let server = SampleServer()
        let gate = server.hold("POST /v1/actions")
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let tuesday = try #require(MailJSON.parseTime("2026-11-17T08:00:00Z"))

        let snooze = Task { await store.perform(.comeBack(at: tuesday), on: ["thr_1"]) }
        // Tuesday's above the lease renewal's Thursday.
        try await waitUntil("thr_1 shows in Snoozed") { snoozed(store) == ["thr_1", "thr_9"] }
        #expect(!inHome(store, "thr_1"))
        await gate.open()
        await snooze.value

        #expect(server.thread("thr_1")?.comeBackAt == tuesday)
        #expect(snoozed(store) == ["thr_1", "thr_9"] && !inHome(store, "thr_1"))
        // Snoozed again to another time: it moves within the list.
        let friday = try #require(MailJSON.parseTime("2026-11-20T08:00:00Z"))
        await store.perform(.comeBack(at: friday), on: ["thr_1"])
        #expect(snoozed(store) == ["thr_9", "thr_1"])
    }

    @Test func unsnoozedItLeavesSnoozedAndComesBackToHomeAtOnceWithUndo() async throws {
        let server = SampleServer()
        let gate = server.hold("POST /v1/actions")
        let store = try await makeStore(server)
        await store.loadFromDisk()
        #expect(snoozed(store) == ["thr_9"] && !inHome(store, "thr_9"))

        let unsnooze = Task { await store.perform(.cancelComeBack, on: ["thr_9"]) }
        try await waitUntil("thr_9 leaves Snoozed") { snoozed(store).isEmpty }
        #expect(inHome(store, "thr_9"))
        await gate.open()
        await unsnooze.value
        #expect(snoozed(store).isEmpty && inHome(store, "thr_9"))
        #expect(server.thread("thr_9")?.comeBackAt == nil)

        #expect(store.lastAction?.action == .cancelComeBack)
        await store.undoLastAction()
        #expect(snoozed(store) == ["thr_9"] && !inHome(store, "thr_9"))
    }

    /// Dragged from Pinned onto To reply in the Mac app: the stack is replaced, at once and on the server.
    @Test func aPinnedThreadPutOnToReplyLeavesPinned() async throws {
        let server = SampleServer()
        let gate = server.hold("POST /v1/actions")
        let store = try await makeStore(server)
        await store.loadFromDisk()
        #expect(pinned(store) == ["thr_10"] && toReply(store) == ["thr_7"])

        let move = Task { await store.perform(.stack(.replyLater), on: ["thr_10"]) }
        try await waitUntil("thr_10 moves to To reply") { toReply(store) == ["thr_7", "thr_10"] }
        #expect(pinned(store).isEmpty)
        await gate.open()
        await move.value
        #expect(server.thread("thr_10")?.stack == .replyLater)
        #expect(toReply(store) == ["thr_7", "thr_10"] && pinned(store).isEmpty && !inHome(store, "thr_10"))
        #expect(store.lastAction?.action == .stack(.replyLater))
    }

    /// A notification group's row dragged onto Pinned: every thread of the group, as one action with one undo.
    @Test func aGroupIsPinnedAsOneAction() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        let group = ["thr_21", "thr_24", "thr_23"]

        await store.perform(.stack(.setAside), on: group)
        #expect(pinned(store) == ["thr_21", "thr_24", "thr_23", "thr_10"])
        #expect(group.allSatisfy { server.thread($0)?.stack == .setAside })
        await store.undoLastAction()
        #expect(pinned(store) == ["thr_10"])
    }

    @Test func aRefusedPinIsTakenBackFromPinned() async throws {
        let server = SampleServer()
        let gate = server.hold("POST /v1/actions")
        server.failOnce("POST /v1/actions", with: .error("conflict", "Changed elsewhere", status: 409))
        let store = try await makeStore(server)
        await store.loadFromDisk()

        let pin = Task { await store.perform(.stack(.setAside), on: ["thr_1"]) }
        try await waitUntil("thr_1 shows in Pinned") { pinned(store).contains("thr_1") }
        await gate.open()
        await pin.value
        #expect(pinned(store) == ["thr_10"] && inHome(store, "thr_1"))
    }
}
