import Foundation
import Testing

@testable import UsualMailKit

/// The on-device copy against sample.json, with the lists as docs/contract.md defines them ("Lists").
struct LocalStoreQueryTests {
    let sample = SampleData.bundled

    @Test func homeIsConversationsAndUndecidedMailLetInNotDoneStackedOrWaiting() async throws {
        let store = try await LocalStore.sample()
        // thr_9 waits to come back on 19 November; thr_7 and thr_10 are on stacks; thr_3 and thr_13 are done; thr_5
        // is screened; the notifications have their own tab; the rest are filed in other categories.
        #expect(
            try await store.home(at: sample.now).map(\.id) == ["thr_14", "thr_1", "thr_2", "thr_12", "thr_16"])
        #expect(try await store.home(at: sample.now, inboxId: "inb_harbor").isEmpty)
        #expect(try await store.home(at: sample.now, inboxId: "inb_personal").map(\.id) == ["thr_12"])
    }

    @Test func aThreadComesBackAtTheTopOnceItsTimeHasPassed() async throws {
        let store = try await LocalStore.sample()
        let later = time("2026-11-19T08:00:00Z")
        #expect(try await store.home(at: later).map(\.id).first == "thr_9")
        #expect(try await store.home(at: later.addingTimeInterval(-1)).map(\.id).contains("thr_9") == false)
        #expect(try await store.waiting(at: later).isEmpty)
        #expect(try await store.waiting(at: later.addingTimeInterval(-1)).map(\.id) == ["thr_9"])
    }

    @Test func eachCategoryHoldsItsThreadsThatAreNotDoneStackedOrNot() async throws {
        let store = try await LocalStore.sample()
        #expect(try await store.category(.conversation).map(\.id) == ["thr_1", "thr_2", "thr_7", "thr_9"])
        #expect(try await store.category(.newsletter).map(\.id) == ["thr_8", "thr_4"])
        #expect(try await store.category(.receipt).map(\.id) == ["thr_17", "thr_10"])  // thr_3 is done
        #expect(try await store.category(.uncategorized).map(\.id) == ["thr_14", "thr_12", "thr_16"])
        #expect(try await store.category(.conversation, inboxId: "inb_harbor").map(\.id) == ["thr_7", "thr_9"])
        #expect(try await store.category(.otp, inboxId: "inb_personal").isEmpty)
    }

    @Test func eachStackHoldsItsThreads() async throws {
        let store = try await LocalStore.sample()
        #expect(try await store.stack(.replyLater).map(\.id) == ["thr_7"])
        #expect(try await store.stack(.setAside).map(\.id) == ["thr_10"])
        #expect(try await store.stack(.setAside, inboxId: "inb_harbor").isEmpty)
    }

    @Test func screeningHoldsScreenedThreadsThatAreNotDone() async throws {
        let store = try await LocalStore.sample()
        #expect(try await store.screening().map(\.id) == ["thr_5"])
        var done = try #require(sample.threads.first { $0.id == "thr_5" })
        done.done = true
        done.version += 1
        let written = done
        try await store.write { try $0.upsert(threads: [written]) }
        #expect(try await store.screening().isEmpty)
    }

    @Test func handledIsWhatRulesAgentsAndTheAIDidOrPropose() async throws {
        let store = try await LocalStore.sample()
        // act_15 is undone; act_6, act_7, act_14, act_19 and act_20 are the person's own; act_8 and the AI's are
        // silent. act_1 and act_2 share a time; the later id comes first. act_21 is an agent's block.
        let handled = try await store.handled()
        #expect(handled.map(\.record.id) == ["act_2", "act_1", "act_4", "act_3", "act_21"])
        #expect(handled.map(\.thread.id) == ["thr_3", "thr_3", "thr_8", "thr_4", "thr_28"])
        #expect(handled[2].record.state == .proposed)
        #expect(try await store.handled(inboxId: "inb_harbor").map(\.record.id) == ["act_4", "act_21"])
        #expect(try await store.handled(states: [.undone]).map(\.record.id) == ["act_15"])
        #expect(try await store.handled(limit: 2).count == 2)
        // With silent records: the AI's too, newest first.
        #expect(
            try await store.handled(includeSilent: true).map(\.record.id) == [
                "act_16", "act_13", "act_9", "act_5", "act_2", "act_1", "act_4", "act_11", "act_3", "act_8", "act_10",
                "act_12", "act_17", "act_21", "act_18",
            ])
    }

    @Test func draftsAreThoseInDraftOrFailed() async throws {
        let store = try await LocalStore.sample()
        var failed = sample.drafts[0]
        failed.id = "drf_failed"
        failed.state = .failed
        failed.error = "The mail server refused the recipient."
        failed.updatedAt = sample.now
        var sent = failed
        sent.id = "drf_sent"
        sent.state = .sent
        sent.error = nil
        sent.note = "No copy was saved to Sent."
        var gone = sent
        gone.id = "drf_gone"
        gone.note = nil  // the server doesn't keep a sent draft without a note
        let written = [failed, sent, gone]
        try await store.write { try $0.upsert(drafts: written) }
        #expect(try await store.drafts().map(\.id) == ["drf_failed", "drf_1"])
        // Harbor & Pine's sent drf_2 is in its thread, never in the list.
        #expect(try await store.drafts(inboxId: "inb_harbor").isEmpty)
        #expect(try await store.detail(threadId: "thr_7")?.drafts.map(\.id) == ["drf_2"])
        // The thread keeps its drafts and a sent one with a note; one without a note isn't kept at all.
        #expect(
            try await store.detail(threadId: "thr_1")?.drafts.map(\.id).sorted() == ["drf_1", "drf_failed", "drf_sent"])
        #expect(try await store.draft(id: "drf_gone") == nil)
    }

    @Test func listsReadEverythingAtOnce() async throws {
        let store = try await LocalStore.sample()
        let lists = try await store.lists(at: sample.now)
        #expect(lists.inboxes.map(\.id) == ["inb_northwind", "inb_harbor", "inb_personal"])
        #expect(lists.home.map(\.id) == ["thr_14", "thr_1", "thr_2", "thr_12", "thr_16"])
        #expect(lists.categories[.newsletter]?.map(\.id) == ["thr_8", "thr_4"])
        #expect(lists.stacks[.replyLater]?.map(\.id) == ["thr_7"])
        #expect(lists.waiting.map(\.id) == ["thr_9"] && lists.screening.map(\.id) == ["thr_5"])
        #expect(lists.handled.count == 5)
        #expect(!lists.includesSilent && lists.silentCount == 10)
        #expect(try await store.lists(at: sample.now, includeSilent: true).handled.count == 15)
        #expect(lists.rules(inbox: "inb_northwind").map(\.id) == ["rul_1", "rul_2"])
        #expect(lists.proposals(inbox: nil).map(\.id) == ["act_4"])
        #expect(lists.home(inbox: "inb_personal").map(\.id) == ["thr_12"])
        #expect(lists.screening(inbox: "inb_harbor").isEmpty)
        #expect(lists.drafts.map(\.id) == ["drf_1"])
        #expect(lists.brief == sample.brief)
        #expect(lists.thread(id: "thr_10")?.stack == .setAside)
    }
}

/// The contract's rules for every list: no trashed threads, newest first, equal times by id descending.
struct LocalStoreListRuleTests {
    let sample = SampleData.bundled

    @Test func aTrashedThreadIsInNoListButItsRecordStaysInHandled() async throws {
        let store = try await LocalStore.sample()
        var thread = try #require(sample.threads.first { $0.id == "thr_8" })
        thread.trashed = true
        thread.version += 1
        var record = try #require(sample.actions.first { $0.id == "act_4" })
        record.action = .trash
        record.state = .applied
        record.undoable = true
        record.version += 1
        let (trashed, applied) = (thread, record)
        try await store.write { writer in
            try writer.upsert(threads: [trashed])
            try writer.upsert(actions: [applied])
        }
        let lists = try await store.lists(at: sample.now)
        #expect(!lists.threads(in: .newsletter, inbox: nil).contains { $0.id == "thr_8" })
        #expect(lists.thread(id: "thr_8")?.trashed == true)  // through Handled only
        // Handled lists records; the trash stays there so it can be undone.
        #expect(lists.handled.first { $0.id == "act_4" }?.thread.trashed == true)
        #expect(try await store.thread(id: "thr_8")?.trashed == true)
    }

    @Test func equalTimesAreOrderedByIdDescending() async throws {
        let store = try await LocalStore.sample()
        let base = try #require(sample.threads.first { $0.id == "thr_12" })
        let twins = ["thr_a", "thr_b"].map { id in
            var twin = base
            twin.id = id
            return twin
        }
        try await store.write { try $0.upsert(threads: twins) }
        let ids = try await store.home(at: sample.now).map(\.id)
        #expect(Array(ids.drop { $0 != "thr_b" }.prefix(3)) == ["thr_b", "thr_a", "thr_12"])
        #expect(
            try await store.category(.uncategorized, inboxId: "inb_personal").map(\.id) == ["thr_b", "thr_a", "thr_12"])
    }

    @Test func aStackedThreadLeavesHomeAndStaysInItsCategory() async throws {
        let store = try await LocalStore.sample()
        var thread = try #require(sample.threads.first { $0.id == "thr_2" })
        thread = thread.applying(.stack(.replyLater))
        thread.version += 1
        let stacked = thread
        try await store.write { try $0.upsert(threads: [stacked]) }
        #expect(!(try await store.home(at: sample.now)).contains { $0.id == "thr_2" })
        #expect(try await store.category(.conversation).contains { $0.id == "thr_2" })
        #expect(try await store.stack(.replyLater).map(\.id) == ["thr_2", "thr_7"])
    }
}

struct LocalStoreVersionTests {
    let sample = SampleData.bundled

    @Test func anOlderCopyNeverReplacesANewerOne() async throws {
        let store = try await LocalStore.sample()
        let stored = try #require(sample.threads.first { $0.id == "thr_1" })  // version 6
        var newer = stored
        newer.done = true
        newer.version = 7
        var older = stored
        older.subject = "An old subject"
        older.version = 5
        let (n, o) = (newer, older)
        try await store.write { try $0.upsert(threads: [n]) }
        try await store.write { try $0.upsert(threads: [o]) }
        #expect(try await store.thread(id: "thr_1") == newer)
        #expect(!(try await store.home(at: sample.now)).contains { $0.id == "thr_1" })

        var record = try #require(sample.actions.first { $0.id == "act_4" })
        record.state = .applied
        record.version = 3
        var stale = record
        stale.state = .proposed
        stale.version = 2
        let (r, s) = (record, stale)
        try await store.write { try $0.upsert(actions: [r]) }
        try await store.write { try $0.upsert(actions: [s]) }
        #expect(try await store.action(id: "act_4")?.state == .applied)
    }

    @Test func anEqualVersionReplacesTheCopy() async throws {
        // The app shows its own unconfirmed changes at the version it has; the server's copy at the same version
        // must be able to replace them when the change is refused.
        let store = try await LocalStore.sample()
        var shown = try #require(sample.threads.first { $0.id == "thr_1" })
        shown.done = true
        let original = try #require(sample.threads.first { $0.id == "thr_1" })
        let copy = shown
        try await store.write { try $0.upsert(threads: [copy]) }
        try await store.write { try $0.upsert(threads: [original]) }
        #expect(try await store.thread(id: "thr_1") == original)
    }

    @Test func aBriefIsReplacedOnlyByANewerOne() async throws {
        let store = try await LocalStore.sample()
        var older = sample.brief
        older.id = "brf_0"
        older.createdAt = sample.brief.createdAt.addingTimeInterval(-86_400)
        let old = older
        try await store.write { try $0.save(brief: old) }
        #expect(try await store.latestBrief()?.id == "brf_1")
        var newer = sample.brief
        newer.id = "brf_2"
        newer.createdAt = sample.now
        let new = newer
        try await store.write { try $0.save(brief: new) }
        #expect(try await store.latestBrief()?.id == "brf_2")
    }
}

struct LocalStoreRoundTripTests {
    let sample = SampleData.bundled

    @Test func everythingComesBackAsItWentIn() async throws {
        let store = try await LocalStore.sample()
        #expect(try await store.inboxes() == sample.inboxes)
        for thread in sample.threads {
            #expect(try await store.thread(id: thread.id) == thread)
        }
        for record in sample.actions {
            #expect(try await store.action(id: record.id) == record)
        }
        #expect(
            try await store.rules(inboxId: "inb_northwind") == sample.rules.filter { $0.inboxId == "inb_northwind" })
        #expect(try await store.drafts() == sample.drafts.filter { [.draft, .failed].contains($0.state) })
        #expect(try await store.draft(id: "drf_2") == sample.drafts.first { $0.id == "drf_2" })
        #expect(try await store.drafts(inboxId: "inb_harbor").isEmpty)
        let detail = try #require(try await store.detail(threadId: "thr_1"))
        #expect(detail == sample.detail(threadId: "thr_1"))
        #expect(try await store.actions(threadId: "thr_3").map(\.id) == ["act_2", "act_1"])
        #expect(try await store.latestBrief() == sample.brief)
        #expect(try await store.draft(id: "drf_1") == sample.drafts[0])
    }

    @Test func timesWithFractionsRoundTripExactly() async throws {
        let store = try LocalStore()
        var thread = sample.threads[0]
        thread.lastMessageAt = Date(timeIntervalSince1970: 1_794_821_400.123_456)
        thread.comeBackAt = Date(timeIntervalSinceReferenceDate: 815_000_000.987_654)
        let saved = thread
        try await store.write { try $0.upsert(threads: [saved]) }
        #expect(try await store.thread(id: thread.id) == thread)
    }

    @Test func itSurvivesClosingAndOpening() async throws {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "usualmail-tests-\(UUID().uuidString)/mail.sqlite")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        do {
            let store = try LocalStore(url: url)
            let sample = self.sample
            try await store.write { writer in
                try writer.replaceInboxes(sample.inboxes)
                try writer.upsert(threads: sample.threads)
            }
        }
        let reopened = try LocalStore(url: url)
        #expect(try await reopened.home(at: sample.now).count == 5)
    }

    @Test func savingADetailReplacesItsMessagesAndDrafts() async throws {
        let store = try await LocalStore.sample()
        var detail = try #require(sample.detail(threadId: "thr_1"))
        detail.messages.removeFirst()
        detail.drafts = []
        detail.thread.unread = false
        detail.thread.version += 1
        let saved = detail
        try await store.write { try $0.save(saved) }
        let stored = try #require(try await store.detail(threadId: "thr_1"))
        #expect(stored.messages.map(\.id) == ["msg_1b"])
        #expect(stored.drafts.isEmpty)
        #expect(stored.thread.unread == false)
    }

    @Test func inboxesTakeThePlaceTheServerGivesThem() async throws {
        let store = try await LocalStore.sample()
        var harbor = try #require(sample.inboxes.first { $0.id == "inb_harbor" })
        harbor.name = "Harbor and Pine"
        let added = Inbox(
            id: "inb_new", name: "New", address: "new@new.example", color: "#000000", icon: .globe, position: 3,
            provider: .gmail, connection: .gmail(clientId: "client.example"), trust: .suggest, createdAt: sample.now)
        let changed = harbor
        try await store.write { try $0.upsert(inboxes: [changed, added]) }
        let inboxes = try await store.inboxes()
        #expect(inboxes.map(\.id) == ["inb_northwind", "inb_harbor", "inb_personal", "inb_new"])
        #expect(inboxes[1].name == "Harbor and Pine" && inboxes[3].icon == .globe)
    }

    @Test func removingAnInboxRemovesItsMail() async throws {
        let store = try await LocalStore.sample()
        try await store.write { try $0.deleteInbox(id: "inb_northwind") }
        #expect(try await store.inboxes().map(\.id) == ["inb_harbor", "inb_personal"])
        #expect(try await store.thread(id: "thr_1") == nil)
        #expect(try await store.detail(threadId: "thr_1") == nil)
        #expect(try await store.rules(inboxId: "inb_northwind").isEmpty)
        #expect(try await store.drafts().isEmpty)
        #expect(
            try await store.handled(includeSilent: true).map(\.record.id) == [
                "act_4", "act_11", "act_8", "act_10", "act_17", "act_21", "act_18",
            ])
    }
}

struct LocalStoreReconcileTests {
    let sample = SampleData.bundled

    /// What a refresh would fetch from a server holding `data`: every thread that isn't done (each category's list and
    /// screening), the stacked and waiting ones again, Handled with silent records, and the rest.
    static func snapshot(_ data: SampleData) -> ServerSnapshot {
        let open = data.threads.filter { !$0.done && !$0.trashed }
        let handled = data.handledItems.filter {
            ["rule", "agent", "ai"].contains($0.record.actor.kind) && [.proposed, .applied].contains($0.record.state)
        }
        return ServerSnapshot(
            inboxes: data.inboxes, openThreads: open, openThreadsComplete: true,
            listedThreads: open.filter { $0.stack != nil || $0.isWaiting(at: data.now) }, handled: handled,
            proposals: handled.filter { $0.record.state == .proposed }, proposalsComplete: true,
            drafts: data.drafts.filter { [.draft, .failed].contains($0.state) }, draftsComplete: true,
            // As ServerFetch does: every inbox gets an entry, empty when it has no rules.
            rules: Dictionary(
                uniqueKeysWithValues: data.inboxes.map { inbox in
                    (inbox.id, data.rules.filter { $0.inboxId == inbox.id })
                }),
            brief: data.brief, briefFetched: true, counts: data.counts, aiStatus: data.aiStatus, aiSettings: data.ai)
    }

    private func snapshot(_ change: (inout SampleData) -> Void) -> ServerSnapshot {
        var data = sample
        change(&data)
        return Self.snapshot(data)
    }

    private func index(_ data: SampleData, _ id: String) -> Int {
        data.threads.firstIndex { $0.id == id }!
    }

    @Test func aRefreshBringsTheCopyInLine() async throws {
        let store = try await LocalStore.sample()
        let fresh = snapshot { data in
            data.inboxes.removeAll { $0.id == "inb_personal" }  // removed elsewhere
            data.threads.removeAll { $0.inboxId == "inb_personal" }
            let first = data.threads.firstIndex { $0.id == "thr_1" }!
            data.threads[first].done = true  // done elsewhere, so it leaves the open lists
            data.threads[first].version += 1
            data.threads.removeAll { $0.id == "thr_2" }  // removed at the provider
            let proposal = data.actions.firstIndex { $0.id == "act_4" }!
            data.actions[proposal].state = .applied  // approved elsewhere
            data.actions[proposal].version += 1
            data.drafts = []
            data.rules.removeAll { $0.id == "rul_3" }
        }
        try await store.write { try $0.reconcile(fresh) }
        #expect(try await store.inboxes().map(\.id) == ["inb_northwind", "inb_harbor"])
        #expect(try await store.home(at: sample.now).map(\.id) == ["thr_14", "thr_16"])
        #expect(try await store.thread(id: "thr_2") == nil)
        #expect(try await store.action(id: "act_4")?.state == .applied)
        #expect(try await store.drafts().isEmpty)
        #expect(try await store.rules(inboxId: "inb_harbor").isEmpty)
        #expect(try await store.latestBrief() == sample.brief)
    }

    @Test func anAnsweredProposalLeavesEvenWhenNotListed() async throws {
        let store = try await LocalStore.sample()
        let fresh = snapshot { data in data.actions.removeAll { $0.id == "act_4" } }
        try await store.write { try $0.reconcile(fresh) }
        #expect(try await store.action(id: "act_4") == nil)
    }

    @Test func incompleteListsRemoveNothing() async throws {
        let store = try await LocalStore.sample()
        var fresh = snapshot { data in data.threads.removeAll { $0.id == "thr_2" } }
        fresh.openThreadsComplete = false
        fresh.proposals = []
        fresh.proposalsComplete = false
        fresh.drafts = []
        fresh.draftsComplete = false
        let partial = fresh
        try await store.write { try $0.reconcile(partial) }
        #expect(try await store.thread(id: "thr_2") != nil)
        #expect(try await store.action(id: "act_4") != nil)
        #expect(try await store.drafts().count == 1)
    }

    @Test func whatChangedMeanwhileIsNotRemovedForBeingMissing() async throws {
        let store = try await LocalStore.sample()
        // The refresh read its lists before these arrived on this device or through events.
        let fresh = snapshot { data in
            data.threads.removeAll { $0.id == "thr_2" }  // it hadn't come back yet when the list was read
            data.drafts = []  // drf_1 was written while the list was on its way
            data.inboxes.removeAll { $0.id == "inb_personal" }  // connected while the list was on its way
            data.threads.removeAll { $0.inboxId == "inb_personal" }
            data.rules.removeAll { $0.id == "rul_3" }  // turned on here while the list was on its way
        }
        try await store.write {
            try $0.reconcile(
                fresh,
                keeping: RefreshKeep(
                    threads: ["thr_2", "thr_10", "thr_12"], drafts: ["drf_1"], inboxes: ["inb_personal"],
                    rules: ["rul_3"]))
        }
        #expect(try await store.thread(id: "thr_2") != nil)
        #expect(try await store.drafts().map(\.id) == ["drf_1"])
        #expect(try await store.inboxes().map(\.id).contains("inb_personal"))
        #expect(try await store.rule(id: "rul_3") != nil)
    }

    @Test func anOlderInboxOrDraftFromARefreshNeverReplacesANewerOne() async throws {
        let store = try await LocalStore.sample()
        // An event brought newer copies while the refresh's lists were on their way.
        var personal = try #require(sample.inboxes.first { $0.id == "inb_personal" })
        personal.status = .ok
        personal.statusDetail = nil
        personal.version += 1
        var draft = sample.drafts[0]
        draft.body = "Changed by the agent."
        draft.version += 1
        let (inbox, newer) = (personal, draft)
        try await store.write { writer in
            try writer.upsert(inboxes: [inbox])
            try writer.upsert(drafts: [newer])
        }
        // No ids kept: versions alone decide between copies.
        try await store.write { try $0.reconcile(Self.snapshot(sample)) }
        #expect(try await store.inbox(id: "inb_personal") == personal)
        #expect(try await store.inboxes().map(\.id) == ["inb_northwind", "inb_harbor", "inb_personal"])
        #expect(try await store.draft(id: "drf_1") == draft)

        // An older inbox from an event is ignored too; an equal one replaces (lastSyncedAt moves without a version).
        var stale = personal
        stale.version -= 1
        stale.name = "Old name"
        var synced = personal
        synced.lastSyncedAt = sample.now
        let (old, same) = (stale, synced)
        try await store.write { try $0.upsert(inboxes: [old]) }
        #expect(try await store.inbox(id: "inb_personal")?.name == "Personal")
        try await store.write { try $0.replaceInboxes(sample.inboxes.map { $0.id == same.id ? same : $0 }) }
        #expect(try await store.inbox(id: "inb_personal")?.lastSyncedAt == sample.now)
    }

    @Test func aDraftOrInboxRemovedMeanwhileIsNotBroughtBack() async throws {
        let store = try await LocalStore.sample()
        let fresh = snapshot { _ in }  // still lists drf_1 and inb_harbor
        try await store.write { writer in
            try writer.deleteDraft(id: "drf_1")  // a draft.removed event
            try writer.deleteInbox(id: "inb_harbor")  // an inbox.removed event
        }
        try await store.write {
            try $0.reconcile(fresh, keeping: RefreshKeep(drafts: ["drf_1"], inboxes: ["inb_harbor"]))
        }
        #expect(try await store.draft(id: "drf_1") == nil)
        #expect(try await store.inboxes().map(\.id) == ["inb_northwind", "inb_personal"])
        // Nor is the removed inbox's mail, which the refresh's lists still had.
        #expect(try await store.thread(id: "thr_6") == nil)
        #expect(try await store.handled().allSatisfy { $0.record.inboxId != "inb_harbor" })
        #expect(try await store.rules(inboxId: "inb_harbor").isEmpty)
    }

    @Test func aThreadRemovedMeanwhileIsNotBroughtBack() async throws {
        let store = try await LocalStore.sample()
        let fresh = snapshot { _ in }  // still lists thr_12
        try await store.write { try $0.deleteThread(id: "thr_12") }  // a thread.removed event
        try await store.write { try $0.reconcile(fresh, keeping: RefreshKeep(threads: ["thr_12"])) }
        #expect(try await store.thread(id: "thr_12") == nil)
    }
}
