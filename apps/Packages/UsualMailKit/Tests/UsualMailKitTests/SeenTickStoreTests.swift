import Foundation
import Testing

@testable import UsualMailKit

/// What the Notifications tab's seen tick asks of the store (owner's words of 2026-11-20; the coordinator's decision:
/// seen is the threads' read state, nothing new on the server): marking a row's threads read (`markRead(opening:)`) and
/// unread again (`markUnread`), both as opening a mail marks it: shown at once, one action for them all, not offered to
/// undo, no teach question, taken back quietly when the server can't be reached.
@MainActor
struct SeenTickStoreTests {
    /// The walking boots' parcel, newest mail first; all read in the sample.
    private let parcel = ["thr_21", "thr_24", "thr_23"]

    private func actions(_ server: SampleServer) -> [URLRequest] {
        server.requests.filter { $0.pathAndQuery == "/v1/actions" }
    }

    /// The Notifications list's copies of `ids`.
    private func listed(_ store: MailStore, _ ids: [String]) -> [MailThread] {
        store.lists.threads(in: .notification, inbox: nil).filter { ids.contains($0.id) }
    }

    /// A store whose person's own last action is set, and whose stand-in then hands a teach prompt out with every
    /// action, so a mark that showed one or took the undo would be seen.
    private func store(_ server: SampleServer) async throws -> (MailStore, RecentAction?) {
        let store = try await makeStore(server)
        await store.loadFromDisk()
        await store.perform(.stack(.setAside), on: ["thr_2"])
        let earlier = store.lastAction
        #expect(earlier != nil)
        let now = SampleData.bundled.now
        server.state.withLock {
            $0.teach = TeachPrompt(
                id: "tch_seen", question: "Always treat this as read?",
                rule: RuleDraft(inboxId: "inb_personal", text: "", match: RuleMatch(from: "a@b.example"), then: []),
                fromActionId: "x", expiresAt: now.addingTimeInterval(86_400))
        }
        return (store, earlier)
    }

    @Test func markingUnreadShowsAtOnceAndIsSilent() async throws {
        let server = SampleServer()
        let (store, earlier) = try await store(server)
        #expect(listed(store, parcel).count == 3 && listed(store, parcel).allSatisfy { !$0.unread })
        let before = actions(server).count

        let gate = server.hold("POST /v1/actions")
        let marking = Task { await store.markUnread(parcel) }
        try await waitUntil("the three show unread before the server answers") {
            listed(store, parcel).allSatisfy(\.unread)
        }
        await gate.open()
        await marking.value

        let marks = actions(server).dropFirst(before)
        #expect(marks.count == 1)
        #expect(
            marks.first?.jsonBody == json(#"{"action":{"kind":"unread"},"threadIds":["thr_21","thr_24","thr_23"]}"#))
        for id in parcel {
            #expect(server.thread(id)?.unread == true, "\(id)")
            #expect(try await store.local.thread(id: id)?.unread == true, "\(id)")
        }
        // As opening a mail: not offered to undo, no teach question, nothing to report.
        #expect(store.lastAction == earlier)
        #expect(store.teachPrompt == nil && store.problem == nil)
    }

    @Test func tickedSeenAndBackLeavesNothingToUndo() async throws {
        let server = SampleServer()
        let (store, earlier) = try await store(server)
        let before = actions(server).count
        // Today's parcel is unread in the sample.
        #expect(listed(store, ["thr_19"]).first?.unread == true)

        await store.markRead(opening: ["thr_19"])
        #expect(listed(store, ["thr_19"]).first?.unread == false)
        await store.markUnread(["thr_19"])
        #expect(listed(store, ["thr_19"]).first?.unread == true)

        #expect(
            actions(server).dropFirst(before).map(\.jsonBody) == [
                json(#"{"action":{"kind":"read"},"threadIds":["thr_19"]}"#),
                json(#"{"action":{"kind":"unread"},"threadIds":["thr_19"]}"#),
            ])
        #expect(server.thread("thr_19")?.unread == true)
        #expect(store.lastAction == earlier)
        #expect(store.teachPrompt == nil && store.problem == nil)
    }

    @Test func offlineTheUnreadIsTakenBackQuietly() async throws {
        let store = MailStore(
            client: APIClient(
                server: testServer, token: "t",
                transport: StubTransport { _ in throw URLError(.notConnectedToInternet) }),
            local: try await LocalStore.sample(), clock: { SampleData.bundled.now })
        await store.loadFromDisk()

        await store.markUnread(parcel)
        #expect(store.problem == nil)
        #expect(listed(store, parcel).count == 3 && listed(store, parcel).allSatisfy { !$0.unread })
        #expect(try await store.local.thread(id: "thr_21")?.unread == false)
        #expect(store.lastAction == nil)
    }
}
