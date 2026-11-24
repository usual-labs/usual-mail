import Foundation
import Testing

@testable import UsualMailKit

/// Silent records (docs/contract.md, "Trust"): the server marks them (what rules and agents applied alone in an
/// `act_silently` inbox, and everything the server's AI decided), Handled leaves them out until the person asks, and a
/// record that went wrong or carries a note is never silent, so it always shows.
@MainActor
struct SilentRecordTests {
    let sample = SampleData.bundled

    @Test func handledLeavesSilentRecordsOutUntilAsked() async throws {
        let store = try await makeStore(SampleServer())
        await store.loadFromDisk()
        // act_8: Hermes called thr_11 a notification alone in Personal, which acts silently; the AI's nine records
        // are silent too.
        #expect(!store.lists.handled.contains { $0.id == "act_8" })
        #expect(!store.lists.handled.contains { $0.record.actor.kind == "ai" })
        #expect(store.lists.silentCount == 10 && !store.lists.includesSilent)

        await store.showSilent(true)
        #expect(store.lists.includesSilent)
        #expect(store.lists.handled.count == 15)
        #expect(store.lists.handled.prefix(4).map(\.id) == ["act_16", "act_13", "act_9", "act_5"])
        // Still undoable like any other.
        #expect(store.lists.handled.first { $0.id == "act_8" }?.record.undoable == true)
        #expect(
            store.lists.handled.first { $0.id == "act_16" }?.record.actor
                == .ai(job: .categorize, model: "example/decision-1"))

        await store.showSilent(false)
        #expect(!store.lists.handled.contains { $0.id == "act_8" })
    }

    @Test func aSilentRecordThatGoesWrongShowsWithItsWords() async throws {
        let store = try await makeStore(SampleServer())
        await store.loadFromDisk()
        let silent = try #require(sample.actions.first { $0.id == "act_8" })

        // The provider refused the undo: the server turns the record not silent, for good, and says why.
        var refused = silent
        refused.silent = false
        refused.error = "The mail server refused to move it back."
        refused.version += 1
        await store.receive(.actionRecorded(refused))
        let shown = try #require(store.lists.handled.first { $0.id == "act_8" })
        #expect(shown.record.error == "The mail server refused to move it back.")
        #expect(store.lists.silentCount == 9)

        // The same for a note on a write-back that worked.
        var noted = silent
        noted.id = "act_noted"
        noted.silent = false
        noted.note = "This server can't keep stacks."
        await store.receive(.actionRecorded(noted))
        #expect(store.lists.handled.first { $0.id == "act_noted" }?.record.note == "This server can't keep stacks.")
    }

    @Test func aSilentRecordFromAnEventStaysOutOfHandled() async throws {
        let store = try await makeStore(SampleServer())
        await store.loadFromDisk()
        let record = ActionRecord(
            id: "act_quiet", threadId: "thr_12", inboxId: "inb_personal", action: .categorize(.newsletter),
            actor: .agent(agentId: "dev_agent_2", name: "Hermes"), reason: "An invitation", state: .applied,
            at: sample.now, undoable: true, silent: true)
        await store.receive(.actionRecorded(record))
        #expect(!store.lists.handled.contains { $0.id == "act_quiet" })
        #expect(store.lists.silentCount == 11)
        #expect(try await store.local.action(id: "act_quiet") == record)
    }
}
