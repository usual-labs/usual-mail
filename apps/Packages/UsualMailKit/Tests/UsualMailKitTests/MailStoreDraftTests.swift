import Foundation
import Testing

@testable import UsualMailKit

/// Writing, sending and deleting drafts through the store, against the stand-in server.
@MainActor
struct MailStoreDraftTests {
    let sample = SampleData.bundled

    private func loadedStore(_ server: SampleServer) async throws -> MailStore {
        let store = try await makeStore(server)
        await store.loadFromDisk()
        return store
    }

    @Test func anAgentsDraftShowsInItsThread() async throws {
        let store = try await loadedStore(SampleServer())
        await store.open(threadID: "thr_1")
        let draft = try #require(store.openThread?.drafts.first)
        #expect(draft.createdBy == .agent(agentId: "dev_agent_1", name: "Claude Code"))
        #expect(draft.state == .draft && draft.inReplyToMessageId == "msg_1b")
    }

    @Test func savingANewMessageStoresTheServersCopy() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        let input = DraftInput(
            inboxId: "inb_harbor", to: [Address(name: "Kestrel Roasters", email: "accounts@kestrel.example")],
            subject: "Beans for December", body: "Could we double the order?")
        let saved = try #require(await store.saveDraft(input))
        let request = try #require(server.requests.last)
        #expect(request.httpMethod == "POST" && request.pathAndQuery == "/v1/drafts")
        #expect(
            request.jsonBody
                == json(
                    #"{"body":"Could we double the order?","inboxId":"inb_harbor","subject":"Beans for December","to":[{"email":"accounts@kestrel.example","name":"Kestrel Roasters"}]}"#
                ))
        #expect(saved.state == .draft && saved.createdBy == .person(deviceId: "dev_test"))
        #expect(store.lists.drafts.map(\.id) == [saved.id, "drf_1"])
    }

    @Test func editingAnAgentsDraftKeepsItsId() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        let draft = sample.drafts[0]
        var input = DraftInput(
            id: draft.id, inboxId: draft.inboxId, threadId: draft.threadId,
            inReplyToMessageId: draft.inReplyToMessageId, to: draft.to, subject: draft.subject, body: draft.body)
        input.body = "Hi Dana,\n\n60 days works. Updated contract to follow.\n\nNorthwind"
        let saved = try #require(await store.saveDraft(input))
        #expect(saved.id == "drf_1")
        #expect(server.requests.last?.jsonBody?["id"] == "drf_1")
        await store.open(threadID: "thr_1")
        #expect(store.openThread?.drafts.map(\.body) == [input.body])
    }

    @Test func sendingSavesThenSends() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        let draft = sample.drafts[0]
        let input = DraftInput(
            id: draft.id, inboxId: draft.inboxId, threadId: draft.threadId,
            inReplyToMessageId: draft.inReplyToMessageId, to: draft.to, subject: draft.subject, body: draft.body)
        let sent = try #require(await store.send(input))
        #expect(sent.state == .sent && sent.error == nil)
        #expect(
            server.requests.suffix(2).map { "\($0.httpMethod!) \($0.pathAndQuery)" } == [
                "POST /v1/drafts", "POST /v1/drafts/drf_1/send",
            ])
        #expect(store.lists.drafts.isEmpty)  // Drafts lists drafts and failed sends only
        // Sent without a note: the server doesn't keep it, so neither does the copy, not even in its thread.
        #expect(try await store.local.draft(id: "drf_1") == nil)
        await store.open(threadID: "thr_1", markingRead: false)
        #expect(store.openThread?.drafts.isEmpty == true)
        #expect(store.problem == nil)
    }

    @Test func aRefusedSendShowsTheDraftFailedWithItsReason() async throws {
        let server = SampleServer()
        server.state.withLock { $0.sendRefusal = "The mail server refused dana@lumen.example." }
        let store = try await loadedStore(server)
        let failed = try #require(await store.send(draftID: "drf_1"))
        #expect(failed.state == .failed)
        #expect(failed.error == "The mail server refused dana@lumen.example.")
        #expect(store.lists.drafts.first?.error == "The mail server refused dana@lumen.example.")
        #expect(store.problem == nil)  // a refused send is not an error response
        await store.open(threadID: "thr_1")
        #expect(store.openThread?.drafts.first?.state == .failed)
    }

    @Test func aSendThatWorksKeepsItsNote() async throws {
        let server = SampleServer()
        server.state.withLock { $0.sendNote = "No copy was saved to Sent." }
        let store = try await loadedStore(server)
        let sent = try #require(await store.send(draftID: "drf_1"))
        #expect(sent.state == .sent && sent.note == "No copy was saved to Sent." && sent.version == 4)
        await store.open(threadID: "thr_1")
        #expect(store.openThread?.drafts.first?.note == "No copy was saved to Sent.")
        #expect(store.lists.drafts.isEmpty)  // kept for its thread only
        #expect(store.problem == nil)
    }

    @Test func aSendTheServerCantTakeSaysWhy() async throws {
        let server = SampleServer()
        server.failOnce(
            "POST /v1/drafts/drf_1/send", with: .error("needs_person", "Only a person may send", status: 403))
        let store = try await loadedStore(server)
        #expect(await store.send(draftID: "drf_1") == nil)
        #expect(store.problem?.message.contains("Only a person may send") == true)
        #expect(try await store.local.draft(id: "drf_1")?.state == .draft)
    }

    @Test func deletingADraftRemovesIt() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        #expect(await store.deleteDraft(sample.drafts[0]))
        #expect(server.requests.last.map { "\($0.httpMethod!) \($0.pathAndQuery)" } == "DELETE /v1/drafts/drf_1")
        #expect(store.lists.drafts.isEmpty)
        #expect(try await store.local.draft(id: "drf_1") == nil)
    }

    @Test func draftEventsUpdateTheList() async throws {
        let store = try await loadedStore(SampleServer())
        var failed = sample.drafts[0]
        failed.state = .failed
        failed.error = "Refused"
        await store.receive(.draftChanged(failed))
        #expect(store.lists.drafts.first?.state == .failed)
        await store.receive(.draftRemoved(draftId: failed.id, inboxId: failed.inboxId))
        #expect(store.lists.drafts.isEmpty)
    }
}
