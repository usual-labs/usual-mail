import Foundation
import Testing

@testable import UsualMailKit

@MainActor
struct MailStoreEventTests {
    let sample = SampleData.bundled

    private func loadedStore(_ server: SampleServer = SampleServer()) async throws -> MailStore {
        let store = try await makeStore(server)
        await store.loadFromDisk()
        return store
    }

    @Test func inboxChangedUpdatesOrAddsTheInbox() async throws {
        let store = try await loadedStore()
        var harbor = sample.inboxes.first { $0.id == "inb_harbor" }!
        harbor.status = .paused
        await store.receive(.inboxChanged(harbor))
        #expect(store.lists.inbox(id: "inb_harbor")?.status == .paused)
        #expect(store.lists.inboxes.count == 3)
    }

    @Test func inboxRemovedTakesItsMailAway() async throws {
        let store = try await loadedStore()
        await store.receive(.triagePending(inboxId: "inb_personal", count: 2))
        await store.receive(.inboxRemoved(inboxId: "inb_personal"))
        #expect(store.lists.inboxes.map(\.id) == ["inb_northwind", "inb_harbor"])
        #expect(!store.lists.home.contains { $0.inboxId == "inb_personal" })
        #expect(store.triagePending["inb_personal"] == nil)
    }

    @Test func threadChangedMovesTheThread() async throws {
        let store = try await loadedStore()
        var thread = sample.threads.first { $0.id == "thr_2" }!
        thread.done = true
        thread.version += 1
        await store.receive(.threadChanged(thread))
        #expect(!store.lists.home.contains { $0.id == "thr_2" })
        var screened = sample.threads.first { $0.id == "thr_5" }!
        screened.screened = false
        screened.version += 1
        await store.receive(.threadChanged(screened))
        #expect(store.lists.home.prefix(2).map(\.id) == ["thr_14", "thr_5"])
        #expect(store.lists.screening.isEmpty)
    }

    @Test func threadRemovedClosesItIfOpen() async throws {
        let store = try await loadedStore()
        await store.open(threadID: "thr_1")
        await store.receive(.threadRemoved(threadId: "thr_1", inboxId: "inb_northwind"))
        #expect(!store.lists.home.contains { $0.id == "thr_1" })
        #expect(store.openThread == nil)
        #expect(try await store.local.detail(threadId: "thr_1") == nil)
    }

    @Test func actionRecordedShowsInHandled() async throws {
        let store = try await loadedStore()
        let record = ActionRecord(
            id: "act_new", threadId: "thr_12", inboxId: "inb_personal", action: .categorize(.newsletter),
            actor: .agent(agentId: "dev_agent_2", name: "Hermes"), reason: "An invitation with no question",
            state: .proposed, at: sample.now, undoable: false)
        await store.receive(.actionRecorded(record))
        #expect(store.lists.handled.first?.record == record)
        #expect(store.lists.proposals(inbox: "inb_personal").map(\.id) == ["act_new"])
    }

    @Test func draftEventsReachTheOpenThread() async throws {
        let store = try await loadedStore()
        await store.open(threadID: "thr_1")
        var draft = sample.drafts[0]
        draft.body = "Shorter."
        await store.receive(.draftChanged(draft))
        #expect(store.openThread?.drafts.first?.body == "Shorter.")
        await store.receive(.draftRemoved(draftId: draft.id, inboxId: draft.inboxId))
        #expect(store.openThread?.drafts.isEmpty == true)
    }

    @Test func aNewerCopyOfTheOpenThreadFetchesItsMessagesAgain() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        await store.open(threadID: "thr_4")
        let picture = SenderPicture(picture: "/v1/avatars/\(String(repeating: "a", count: 32))", fit: .inset, size: 64)
        // The server finds a new picture for the message's sender, which raises its thread's version.
        server.state.withLock { state in
            let index = state.data.messages.firstIndex { $0.id == "msg_4a" }!
            state.data.messages[index].avatar = picture
        }
        let changed = server.change("thr_4") { $0.avatar = picture }
        let asked = server.requests.count
        await store.receive(.threadChanged(changed))
        try await waitUntil("the open mail shows its message's new picture") {
            store.openThread?.messages.first?.avatar == picture
        }
        #expect(store.openThread?.thread.avatar == picture)
        // Its detail once, and it isn't marked read again.
        #expect(server.requests.dropFirst(asked).map(\.pathAndQuery) == ["/v1/threads/thr_4"])

        // The same version again, or a newer copy of a thread that isn't open, fetches nothing.
        await store.receive(.threadChanged(changed))
        await store.receive(.threadChanged(server.change("thr_8") { $0.avatar = nil }))
        try await Task.sleep(for: .milliseconds(50))
        #expect(server.requests.count == asked + 1)
    }

    @Test func triageCountsAreKept() async throws {
        let store = try await loadedStore()
        await store.receive(.triagePending(inboxId: "inb_harbor", count: 3))
        #expect(store.triagePending == ["inb_harbor": 3])
    }

    @Test func aNewBriefIsFetchedAndShown() async throws {
        var data = SampleData.bundled
        data.brief.id = "brf_2"
        data.brief.createdAt = data.now
        let server = SampleServer(data)
        let store = try await loadedStore(server)
        #expect(store.lists.brief?.id == "brf_1")
        await store.receive(.briefReady(briefId: "brf_2"))
        try await waitUntil("the new brief shows") { store.lists.brief?.id == "brf_2" }
        #expect(server.requests.last?.pathAndQuery == "/v1/briefs/brf_2")
    }

    @Test func aRecordForAThreadThisDeviceLacksFetchesTheThread() async throws {
        let server = SampleServer()
        let store = try await makeStore(server, local: try LocalStore())
        let record = try #require(sample.actions.first { $0.id == "act_4" })
        await store.receive(.actionRecorded(record))
        try await waitUntil("the record shows in Handled") { store.lists.handled.map(\.id) == ["act_4"] }
        #expect(server.requests.map(\.pathAndQuery) == ["/v1/threads/thr_8"])
    }

    @Test func unknownEventsChangeNothing() async throws {
        let store = try await loadedStore()
        let before = store.lists
        await store.receive(.unknown(type: "clip.saved"))
        #expect(store.lists == before)
    }

    @Test func anOlderCopyFromAnEventIsIgnored() async throws {
        let store = try await loadedStore()
        var stale = sample.threads.first { $0.id == "thr_1" }!
        stale.done = true
        stale.version -= 1
        await store.receive(.threadChanged(stale))
        #expect(store.lists.home.contains { $0.id == "thr_1" })
        var record = sample.actions.first { $0.id == "act_15" }!  // version 2
        record.state = .applied
        record.version = 1
        await store.receive(.actionRecorded(record))
        #expect(try await store.local.action(id: "act_15")?.state == .undone)
    }

    @Test func anEventDuringARefreshShowsAtOnceAndOutlivesTheRefresh() async throws {
        let server = SampleServer()
        let gate = server.hold("GET /v1/inboxes")
        let store = try await loadedStore(server)
        let refresh = Task { await store.refresh() }
        try await waitUntil("the refresh is running") { store.isRefreshing }

        var thread = sample.threads.first { $0.id == "thr_2" }!
        thread.done = true
        thread.version += 1
        await store.receive(.threadChanged(thread))
        #expect(!store.lists.home.contains { $0.id == "thr_2" })  // shown at once

        await gate.open()
        await refresh.value
        // The refresh's answer still had thr_2 open at version 6; the event's version 7 is newer and stays.
        #expect(!store.lists.home.contains { $0.id == "thr_2" })
        #expect(try await store.local.thread(id: "thr_2")?.version == 7)
    }

    @Test func aRefreshDoesNotRemoveAThreadAnEventBroughtBack() async throws {
        let server = SampleServer()
        let gate = server.hold("GET /v1/inboxes")
        let store = try await loadedStore(server)
        let refresh = Task { await store.refresh() }
        try await waitUntil("the refresh is running") { store.isRefreshing }
        try await waitUntil("the open lists were read") {
            server.requests.contains { $0.url?.path == "/v1/screening" }
        }

        // thr_13 is done in the lists the refresh read; then a reply brings it back.
        var back = sample.threads.first { $0.id == "thr_13" }!
        back.done = false
        back.version += 1
        await store.receive(.threadChanged(back))
        #expect(store.lists.home.contains { $0.id == "thr_13" })

        await gate.open()
        await refresh.value
        #expect(store.lists.home.contains { $0.id == "thr_13" })
    }

    @Test func aRefreshDoesNotBringBackAThreadRemovedMeanwhile() async throws {
        let server = SampleServer()
        let gate = server.hold("GET /v1/inboxes")
        let store = try await loadedStore(server)
        let refresh = Task { await store.refresh() }
        try await waitUntil("the refresh is running") { store.isRefreshing }
        await store.receive(.threadRemoved(threadId: "thr_12", inboxId: "inb_personal"))
        await gate.open()
        await refresh.value
        #expect(!store.lists.home.contains { $0.id == "thr_12" })
        #expect(try await store.local.thread(id: "thr_12") == nil)
    }

    @Test func inboxAndDraftEventsDuringARefreshOutliveItByVersion() async throws {
        let server = SampleServer()
        let gate = server.hold("GET /v1/inboxes")
        let store = try await loadedStore(server)
        let refresh = Task { await store.refresh() }
        try await waitUntil("the drafts were read") { server.requests.contains { $0.url?.path == "/v1/drafts" } }

        var harbor = sample.inboxes.first { $0.id == "inb_harbor" }!
        harbor.status = .paused
        harbor.version += 1
        var draft = sample.drafts[0]
        draft.body = "Rewritten by the agent."
        draft.version += 1
        await store.receive(.inboxChanged(harbor))
        await store.receive(.draftChanged(draft))

        await gate.open()
        await refresh.value
        // The refresh's lists had version 6 of the inbox and 2 of the draft; the events' copies are newer.
        #expect(store.lists.inbox(id: "inb_harbor")?.status == .paused)
        #expect(try await store.local.draft(id: "drf_1") == draft)
    }

    @Test func aDraftSavedDuringARefreshIsNotRemovedByIt() async throws {
        let server = SampleServer()
        let gate = server.hold("GET /v1/inboxes")
        let store = try await loadedStore(server)
        let refresh = Task { await store.refresh() }
        try await waitUntil("the drafts were read") { server.requests.contains { $0.url?.path == "/v1/drafts" } }
        let saved = try #require(
            await store.saveDraft(
                DraftInput(inboxId: "inb_harbor", to: [Address(email: "a@kestrel.example")], subject: "Beans", body: "")
            ))

        await gate.open()
        await refresh.value
        // The refresh's drafts list was read before the draft existed; removal by absence is what versions can't
        // settle, so the refresh watch keeps it.
        #expect(store.lists.drafts.map(\.id).contains(saved.id))
    }

    @Test func anActionsAnswerOlderThanAnEventKeepsTheEvent() async throws {
        let server = SampleServer()
        let gate = server.hold("POST /v1/actions")
        let store = try await loadedStore(server)
        let done = Task { await store.perform(.done, on: ["thr_1"]) }
        try await waitUntil("thr_1 leaves Home") { !store.lists.home.contains { $0.id == "thr_1" } }

        // Before the answer arrives, an event says the thread is at version 10 (its provider moved it back).
        var later = sample.threads.first { $0.id == "thr_1" }!
        later.version = 10
        later.unread = false
        await store.receive(.threadChanged(later))
        await gate.open()
        await done.value
        // The answer carries version 7, older than the event.
        #expect(try await store.local.thread(id: "thr_1") == later)
        #expect(store.lists.home.contains { $0.id == "thr_1" })
    }

    @Test func aThreadChangedEventKeepsPendingChanges() async throws {
        let server = SampleServer()
        let gate = server.hold("POST /v1/actions")
        let store = try await loadedStore(server)
        let file = Task { await store.perform(.categorize(.receipt), on: ["thr_6"]) }
        try await waitUntil("thr_6 shows as a receipt") { store.lists.threads(in: .receipt, inbox: nil).count == 3 }

        var thread = sample.threads.first { $0.id == "thr_6" }!
        thread.unread = false  // another change arrives from the server meanwhile
        thread.version += 1
        await store.receive(.threadChanged(thread))
        let shown = try #require(store.lists.threads(in: .receipt, inbox: nil).first)
        #expect(shown.id == "thr_6" && shown.unread == false && shown.categorizedBy == .person)

        await gate.open()
        await file.value
        #expect(store.lists.threads(in: .receipt, inbox: nil).map(\.id) == ["thr_6", "thr_17", "thr_10"])
    }
}
