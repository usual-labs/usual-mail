import Foundation
import Testing

@testable import UsualMailKit

/// What needs a look (Handled with `attentionOnly`): records that failed or carry an error or a note, from every
/// state, never silent. Handled's default page (proposed and applied) leaves failed records out, so the refresh asks
/// for these on their own.
@MainActor
struct AttentionTests {
    let sample = SampleData.bundled

    /// The sample with act_3 failed at the provider and act_1 carrying a note.
    private func troubled() -> SampleData {
        var data = sample
        let failed = data.actions.firstIndex { $0.id == "act_3" }!
        data.actions[failed].state = .failed
        data.actions[failed].undoable = false
        data.actions[failed].error = "The mail server refused to move it."
        data.actions[failed].version += 1
        let noted = data.actions.firstIndex { $0.id == "act_1" }!
        data.actions[noted].note = "This server can't keep stacks."
        data.actions[noted].version += 1
        return data
    }

    @Test func aRefreshAsksForWhatNeedsALookAndKeepsIt() async throws {
        let server = SampleServer(troubled())
        let store = try await makeStore(server, local: try LocalStore())
        await store.refresh()
        #expect(server.requests.contains { $0.pathAndQuery == "/v1/handled?limit=200&attentionOnly=true" })
        // The failed record is in no default Handled page, but needs a look; the noted one is in both.
        #expect(store.lists.attention.map(\.id) == ["act_1", "act_3"])
        #expect(store.lists.handled.map(\.id) == ["act_2", "act_1", "act_4", "act_21"])
        #expect(store.lists.attention.first { $0.id == "act_3" }?.thread.id == "thr_4")
        #expect(store.lists.attention(inbox: "inb_harbor").isEmpty)
    }

    @Test func aRecordThatGoesWrongLaterNeedsALookAtOnce() async throws {
        let store = try await makeStore(SampleServer())
        await store.loadFromDisk()
        #expect(store.lists.attention.isEmpty)
        var refused = try #require(sample.actions.first { $0.id == "act_8" })  // silent until it went wrong
        refused.silent = false
        refused.error = "The mail server refused to move it back."
        refused.version += 1
        await store.receive(.actionRecorded(refused))
        #expect(store.lists.attention.map(\.id) == ["act_8"])
        // An undone record whose undo carries a note needs a look too, in any state.
        var undone = try #require(sample.actions.first { $0.id == "act_15" })
        undone.note = "Moved back, but the label stayed."
        undone.version += 1
        await store.receive(.actionRecorded(undone))
        #expect(Set(store.lists.attention.map(\.id)) == ["act_8", "act_15"])
        // So does one of the AI's records, once its write-back went wrong.
        var ai = try #require(sample.actions.first { $0.id == "act_10" })
        ai.silent = false
        ai.error = "The mail server refused the label."
        ai.version += 1
        await store.receive(.actionRecorded(ai))
        #expect(store.lists.attention.contains { $0.id == "act_10" })
        #expect(store.lists.handled.contains { $0.id == "act_10" })  // Handled holds the AI's records too
        // The person's own change the provider refused needs a look too, though Handled's list stays rules' and
        // agents'.
        var own = try #require(sample.actions.first { $0.id == "act_6" })
        own.state = .failed
        own.error = "Refused"
        own.version += 1
        await store.receive(.actionRecorded(own))
        #expect(store.lists.attention.contains { $0.id == "act_6" })
        #expect(!store.lists.handled.contains { $0.id == "act_6" })
    }

    @Test func aRefreshKeepsThePersonsOwnRefusedChange() async throws {
        var data = sample
        let own = data.actions.firstIndex { $0.id == "act_6" }!
        data.actions[own].state = .failed
        data.actions[own].undoable = false
        data.actions[own].error = "The mail server refused to move it."
        data.actions[own].version += 1
        let store = try await makeStore(SampleServer(data), local: try LocalStore())
        await store.refresh()
        #expect(store.lists.attention.map(\.id) == ["act_6"])
        #expect(store.lists.attention.first?.record.actor.kind == "person")
        #expect(!store.lists.handled.contains { $0.id == "act_6" })
    }

    @Test func aSilentRecordNeverNeedsALook() async throws {
        let local = try await LocalStore.sample()
        var odd = try #require(sample.actions.first { $0.id == "act_8" })
        odd.note = "A note on a record still marked silent"  // the server never sends this; the copy stays safe
        odd.version += 1
        let record = odd
        try await local.write { try $0.upsert(actions: [record]) }
        #expect(try await local.attention().isEmpty)
        #expect(record.needsALook)
    }
}

/// Sent drafts since the fourth revision: one with a note is kept a day in its thread, never in the drafts list;
/// one without isn't kept, and `draft.removed` takes either away.
@MainActor
struct SentDraftTests {
    let sample = SampleData.bundled

    @Test func theSamplesSentDraftIsOnlyInItsThread() async throws {
        let server = SampleServer()
        let store = try await makeStore(server, local: try LocalStore())
        await store.refresh()
        #expect(!store.lists.drafts.contains { $0.id == "drf_2" })
        await store.open(threadID: "thr_7", markingRead: false)
        let sent = try #require(store.openThread?.drafts.first)
        #expect(sent.id == "drf_2" && sent.state == .sent && sent.note != nil)
        #expect(store.lists.drafts.map(\.id) == ["drf_1"])
    }

    @Test func draftEventsForASentDraft() async throws {
        let store = try await makeStore(SampleServer())
        await store.loadFromDisk()
        // Sent without a note: `draft.changed` as sent, and the copy lets it go at once.
        var sent = sample.drafts[0]
        sent.state = .sent
        sent.version += 2
        await store.receive(.draftChanged(sent))
        #expect(try await store.local.draft(id: "drf_1") == nil)
        await store.receive(.draftRemoved(draftId: "drf_1", inboxId: "inb_northwind"))
        #expect(store.lists.drafts.isEmpty)
        // With a note it stays in its thread for its day, then `draft.removed` ends it.
        await store.open(threadID: "thr_7", markingRead: false)
        #expect(store.openThread?.drafts.map(\.id) == ["drf_2"])
        await store.receive(.draftRemoved(draftId: "drf_2", inboxId: "inb_harbor"))
        #expect(store.openThread?.drafts.isEmpty == true)
    }

    @Test func aRefreshDropsASentDraftWhoseDayIsOver() async throws {
        // drf_2 was sent at 08:15 on the 16th; a day and a bit later the server keeps it no more, and this device
        // missed its `draft.removed`.
        let later = time("2026-11-17T09:00:00Z")
        let server = SampleServer()
        let store = MailStore(client: server.client(), local: try await LocalStore.sample(), clock: { later })
        await store.refresh()
        #expect(try await store.local.draft(id: "drf_2") == nil)
        // Within its day it stays.
        let sameDay = MailStore(
            client: server.client(), local: try await LocalStore.sample(), clock: { SampleData.bundled.now })
        await sameDay.refresh()
        #expect(try await sameDay.local.draft(id: "drf_2") != nil)
    }
}

/// Changes made at the provider that arrive as plain thread events (docs/contract.md, "Sync").
@MainActor
struct ProviderChangeTests {
    let sample = SampleData.bundled

    @Test func aThreadMovedToSpamLeavesEveryListWithNoUndo() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        // Spam is treated like the trash: `thread.changed` with `trashed`, and no record.
        let spam = server.change("thr_14") { $0.trashed = true }
        await store.receive(.threadChanged(spam))
        #expect(!store.lists.home.contains { $0.id == "thr_14" })
        #expect(!store.lists.categories.values.joined().contains { $0.id == "thr_14" })
        #expect(await store.trashRecord(threadId: "thr_14") == nil)
        // The server lists it nowhere and this device holds no record for it, so the next refresh lets it go.
        await store.refresh()
        #expect(try await store.local.thread(id: "thr_14") == nil)
    }

    @Test func newMailFiledOutsideTheInboxArrivesDone() async throws {
        let store = try await makeStore(SampleServer())
        await store.loadFromDisk()
        // A Gmail filter archived it under no category's label: done, and in no list.
        let filed = MailThread(
            id: "thr_filed", inboxId: "inb_northwind", subject: "Your statement is ready", lastMessageAt: sample.now,
            unread: true, done: true)
        await store.receive(.threadChanged(filed))
        #expect(try await store.local.thread(id: "thr_filed") == filed)
        #expect(!store.lists.home.contains { $0.id == "thr_filed" })
        #expect(!store.lists.categories.values.joined().contains { $0.id == "thr_filed" })
        // Filed under a category's label, it lands in that category, decided by the mailbox, not done.
        var newsletter = filed
        newsletter.id = "thr_filed_newsletter"
        newsletter.category = .newsletter
        newsletter.categorizedBy = .mailbox
        newsletter.done = false
        await store.receive(.threadChanged(newsletter))
        #expect(store.lists.threads(in: .newsletter, inbox: nil).first?.id == "thr_filed_newsletter")
        #expect(!store.lists.home.contains { $0.id == "thr_filed_newsletter" })
        // Filed under Screening, it is screened, whatever its category.
        var screened = newsletter
        screened.id = "thr_filed_screened"
        screened.screened = true
        await store.receive(.threadChanged(screened))
        #expect(store.lists.screening.first?.id == "thr_filed_screened")
        #expect(!store.lists.threads(in: .newsletter, inbox: nil).contains { $0.id == "thr_filed_screened" })
    }
}
