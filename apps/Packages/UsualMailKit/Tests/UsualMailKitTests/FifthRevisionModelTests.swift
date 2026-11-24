import Foundation
import Testing

@testable import UsualMailKit

/// The fifth revision's fields in the sample (docs/contract.md, "Words"; docs/contract-ai.md): categories and who
/// decided them, screening, summaries, inbox icons, positions and AI processing, the AI as an actor, the counts, and
/// the AI's status and settings.
struct FifthRevisionDecodingTests {
    let sample = SampleData.bundled

    private func thread(_ id: String) throws -> MailThread {
        try #require(sample.threads.first { $0.id == id })
    }

    @Test func threadsCarryTheirCategoryWhoDecidedItScreeningAndSummary() throws {
        #expect(try thread("thr_1").category == .conversation && thread("thr_1").categorizedBy == .agent)
        #expect(try thread("thr_4").category == .newsletter && thread("thr_4").categorizedBy == .rule)
        #expect(try thread("thr_6").category == .invoice && thread("thr_6").categorizedBy == .ai)
        #expect(try thread("thr_10").category == .receipt && thread("thr_10").categorizedBy == .mailbox)
        #expect(try thread("thr_11").category == .notification)
        // Nobody has decided thr_14 yet: the contract's `unknown`, with no decider and no summary.
        let undecided = try thread("thr_14")
        #expect(undecided.category == .uncategorized && undecided.categorizedBy == nil && undecided.summary == nil)
        // A one-time code is never summarized.
        let code = try thread("thr_15")
        #expect(code.category == .otp && code.summary == nil && !code.screened)
        // thr_5's sender hasn't been let in; the AI still said what it is about.
        let screened = try thread("thr_5")
        #expect(screened.screened && screened.category == .conversation && screened.summary != nil)
        #expect(sample.threads.filter(\.screened).map(\.id) == ["thr_5"])
        #expect(try thread("thr_1").summary?.hasPrefix("Asks you to confirm the 2027 renewal") == true)
        #expect(
            Set(sample.threads.filter { $0.category == .uncategorized }.map(\.id)) == ["thr_14", "thr_16", "thr_12"])
    }

    @Test func inboxesCarryTheirIconAndPosition() {
        #expect(sample.inboxes.map(\.icon) == [.building, .shop, .person])
        #expect(sample.inboxes.map(\.position) == [0, 1, 2])
    }

    @Test func theAIIsAnActorOfSilentRecords() throws {
        let record = try #require(sample.actions.first { $0.id == "act_5" })
        #expect(record.actor == .ai(job: .categorize, model: "example/decision-1"))
        #expect(record.action == .categorize(.notification) && record.silent && record.state == .applied)
        let ai = sample.actions.filter { $0.actor.kind == "ai" }
        #expect(ai.count == 9 && ai.allSatisfy(\.silent))
    }

    @Test func countsComeAsTheServerCountsThem() throws {
        let counts = sample.counts
        #expect(counts.version == 213)
        #expect(counts.all.home == 5 && counts.all.unread == 4 && counts.all.waiting == 1 && counts.all.screened == 1)
        // thr_9 waits to come back, so the server's conversation count leaves it out (2026-11-20).
        #expect(counts.all.count(in: .conversation) == 3 && counts.all.count(in: .uncategorized) == 3)
        #expect(counts.all.categories.count == 7 && counts.all.count(on: .replyLater) == 1)
        #expect(counts.inboxes.map(\.inboxId) == ["inb_northwind", "inb_harbor", "inb_personal"])
        #expect(counts.counts(for: nil) == counts.all)
        let northwind = try #require(counts.counts(for: "inb_northwind"))
        #expect(northwind.home == 4 && northwind.unread == 3 && northwind.screened == 1)
        #expect(counts.inboxes[1].home == 0 && counts.inboxes[1].waiting == 1)  // through dynamic member lookup
        #expect(counts.counts(for: "inb_gone") == nil)
    }

    @Test func droppingAnInboxFromTheCountsLowersAll() throws {
        let kept = sample.counts.keepingOnly(inboxes: ["inb_northwind", "inb_harbor"])
        #expect(kept.inboxes.map(\.inboxId) == ["inb_northwind", "inb_harbor"])
        #expect(kept.all.home == 4 && kept.all.unread == 3 && kept.all.count(in: .uncategorized) == 2)
        #expect(kept.all.count(in: .receipt) == 0 && kept.all.count(on: .setAside) == 0)
        #expect(kept.version == sample.counts.version)
    }

    @Test func theAIsStatusAndSettingsComeThroughWithoutAKey() throws {
        let status = sample.aiStatus
        #expect(status.state == .working && status.pending == 4 && status.version == 58)
        #expect(status.lastRunAt == time("2026-11-16T09:12:40Z") && status.detail == nil && status.job == nil)
        let settings = sample.ai
        #expect(settings.connection == .gateway(.vercel) && settings.credentialsSet && !settings.paused)
        #expect(settings.version == 5)
        // The history setting left the contract (2026-11-18): the sample has none, and nothing writes one back.
        let encoded = try encodedJSON(settings)
        #expect(encoded["historyDays"] == nil && encoded["maxHistoryDays"] == nil)
        #expect(try encodedJSON(status)["beyondHistory"] == nil)
        #expect(settings.jobs.map(\.job) == [.categorize, .summarize])
        let categorize = try #require(settings.job(.categorize))
        #expect(categorize.model == nil && categorize.effectiveModel == "example/decision-1")
        #expect(settings.job(.summarize)?.effectiveModel == "example/text-small-2")
        // A null model is written back as null, as core has it.
        #expect(try encodedJSON(categorize)["model"] == .null)
        let raw = String(decoding: try Data(contentsOf: SampleData.bundledURL), as: UTF8.self)
        #expect(!raw.contains("apiKey"))
    }

    @Test func briefCountsAreByCategory() throws {
        let section = try #require(sample.brief.sections.first)
        #expect(section.count(in: .newsletter) == 1 && section.count(in: .receipt) == 1 && section.doneCount == 1)
        #expect(section.count(in: .conversation) == 0 && section.trashCount == 0)
        #expect(sample.brief.sections[1].counts.isEmpty)
    }

    @Test func aiStatesAndConnectionsANewerServerSendsDecode() throws {
        let status = try MailJSON.decoder().decode(
            AiStatus.self,
            from: Data(
                #"{"state":"model_not_found","detail":"No such model","job":"summarize","pending":3,"version":2}"#
                    .utf8))
        #expect(status.state == .modelNotFound && status.state.needsAPerson && status.job == .summarize)
        #expect(!AiState.working.needsAPerson && AiState.outOfCredit.needsAPerson)
        let direct = try MailJSON.decoder().decode(
            AiConnection.self, from: Data(#"{"kind":"direct","provider":"anthropic"}"#.utf8))
        #expect(direct == .direct(.anthropic))
        let signIn = try MailJSON.decoder().decode(
            AiConnection.self, from: Data(#"{"kind":"sign_in","provider":"openai","account":"a"}"#.utf8))
        #expect(signIn.kind == "sign_in")
        #expect(try encodedJSON(signIn) == json(#"{"kind":"sign_in","provider":"openai","account":"a"}"#))
    }

    @Test func aSettingsPatchIsWrittenAsCoreDescribesIt() throws {
        let set = AiSettingsPatch(credentials: .set(AiCredentials(.gateway(.vercel), apiKey: "not-a-real-key")))
        #expect(
            try encodedJSON(set)
                == json(#"{"credentials":{"apiKey":"not-a-real-key","gateway":"vercel","kind":"gateway"}}"#))
        #expect(set.secrets == ["not-a-real-key"])
        let direct = AiSettingsPatch(credentials: .set(AiCredentials(.direct(.openai), apiKey: "k-1")))
        #expect(
            try encodedJSON(direct) == json(#"{"credentials":{"apiKey":"k-1","kind":"direct","provider":"openai"}}"#))
        #expect(try encodedJSON(AiSettingsPatch(credentials: .remove)) == json(#"{"credentials":null}"#))
        let models = AiSettingsPatch(models: [.categorize: nil, .summarize: "example/text-small-3"])
        #expect(
            try encodedJSON(models) == json(#"{"models":{"categorize":null,"summarize":"example/text-small-3"}}"#))
        #expect(try encodedJSON(AiSettingsPatch(paused: true)) == json(#"{"paused":true}"#))
        #expect(models.secrets.isEmpty)
    }

    @Test func newEventsDecodeFromTheWire() throws {
        let decoder = MailJSON.decoder()
        let counts = try decoder.decode(
            MailEvent.self,
            from: Data(
                #"""
                {"type":"counts.changed","counts":{"all":{"home":1,"unread":0,"categories":{"conversation":1},
                 "stacks":{},"waiting":0,"screened":0},"inboxes":[{"inboxId":"i","home":1,"unread":0,
                 "categories":{"conversation":1},"stacks":{},"waiting":0,"screened":0}],"version":9}}
                """#.utf8))
        guard case .countsChanged(let value) = counts else {
            Issue.record("Expected counts.changed, got \(counts)")
            return
        }
        #expect(value.version == 9 && value.inboxes.first?.inboxId == "i" && value.all.count(in: .conversation) == 1)
        let status = try decoder.decode(
            MailEvent.self,
            from: Data(
                #"{"type":"ai.status.changed","status":{"state":"paused","pending":4,"version":3}}"#.utf8))
        #expect(status == .aiStatusChanged(AiStatus(state: .paused, pending: 4, version: 3)))
        let settings = try decoder.decode(
            MailEvent.self,
            from: Data(
                #"{"type":"ai.settings.changed","settings":{"credentialsSet":false,"jobs":[],"paused":false,"version":2}}"#
                    .utf8))
        #expect(settings == .aiSettingsChanged(AiSettings(version: 2)))
        #expect(settings.type == "ai.settings.changed" && status.type == "ai.status.changed")
        #expect(counts.type == "counts.changed")
    }
}

/// The lists on the sample, as docs/contract.md's "Lists" table defines them, from the copy on the device.
struct FifthRevisionListTests {
    let sample = SampleData.bundled

    private func lists(at time: Date? = nil) async throws -> MailLists {
        try await LocalStore.sample().lists(at: time ?? sample.now)
    }

    @Test func homeIsConversationsAndUndecidedMailThatIsLetInNotDoneStackedOrWaiting() async throws {
        let lists = try await lists()
        // thr_5 is screened; thr_13 is done; thr_7 stacked and thr_9 waiting; thr_15 is a code; thr_11 and thr_19 to
        // thr_25 are notifications, which have their own tab (owner's decision of 2026-11-19); the rest filed.
        #expect(lists.home(inbox: nil).map(\.id) == ["thr_14", "thr_1", "thr_2", "thr_12", "thr_16"])
        #expect(!lists.home.contains { $0.category == .notification })
        #expect(lists.home(inbox: "inb_northwind").map(\.id) == ["thr_14", "thr_1", "thr_2", "thr_16"])
        #expect(lists.home(inbox: "inb_harbor").isEmpty)
        #expect(lists.home(inbox: "inb_personal").map(\.id) == ["thr_12"])
        // New and Seen: thr_16 is read.
        #expect(lists.home(inbox: nil).filter(\.unread).map(\.id) == ["thr_14", "thr_1", "thr_2", "thr_12"])
    }

    @Test func aThreadComesBackIntoHomeAtTheTopOnceItsTimeHasPassed() async throws {
        let later = try await lists(at: time("2026-11-19T08:00:00Z"))
        #expect(later.home.first?.id == "thr_9" && later.waiting.isEmpty)
        let before = try await lists(at: time("2026-11-19T07:59:59Z"))
        #expect(!before.home.contains { $0.id == "thr_9" } && before.waiting.map(\.id) == ["thr_9"])
    }

    @Test func eachCategoryHoldsItsThreadsThatAreLetInAndNotDone() async throws {
        let lists = try await lists()
        #expect(lists.threads(in: .conversation, inbox: nil).map(\.id) == ["thr_1", "thr_2", "thr_7", "thr_9"])
        #expect(lists.threads(in: .newsletter, inbox: nil).map(\.id) == ["thr_8", "thr_4"])
        #expect(lists.threads(in: .invoice, inbox: nil).map(\.id) == ["thr_6", "thr_18"])
        #expect(lists.threads(in: .receipt, inbox: nil).map(\.id) == ["thr_17", "thr_10"])  // thr_3 is done
        #expect(
            lists.threads(in: .notification, inbox: nil).map(\.id) == [
                "thr_19", "thr_25", "thr_11", "thr_22", "thr_20", "thr_21", "thr_24", "thr_23",
            ])
        #expect(lists.threads(in: .otp, inbox: nil).map(\.id) == ["thr_15"])
        #expect(lists.threads(in: .uncategorized, inbox: nil).map(\.id) == ["thr_14", "thr_12", "thr_16"])
        #expect(lists.threads(in: .conversation, inbox: "inb_harbor").map(\.id) == ["thr_7", "thr_9"])
        // The lengths are the server's counts, which leave waiting threads out since 2026-11-20 (thr_9 here): the
        // copy's category lists still hold them, and the screens leave them out as a second guard.
        for category in Category.known {
            let shown = lists.threads(in: category, inbox: nil).filter { !$0.isWaiting(at: sample.now) }
            #expect(shown.count == sample.counts.all.count(in: category))
        }
        #expect(
            lists.threads(in: .conversation, inbox: nil).filter { $0.isWaiting(at: sample.now) }.map(\.id) == ["thr_9"])
        #expect(lists.home.count == sample.counts.all.home)
    }

    @Test func stacksWaitingAndScreening() async throws {
        let lists = try await lists()
        #expect(lists.threads(on: .replyLater, inbox: nil).map(\.id) == ["thr_7"])
        #expect(lists.threads(on: .setAside, inbox: nil).map(\.id) == ["thr_10"])
        #expect(lists.threads(on: .setAside, inbox: "inb_harbor").isEmpty)
        #expect(lists.waiting(inbox: nil).map(\.id) == ["thr_9"])
        #expect(lists.waiting(inbox: "inb_northwind").isEmpty)
        #expect(lists.screening(inbox: nil).map(\.id) == ["thr_5"])
        #expect(lists.screening(inbox: "inb_harbor").isEmpty)
        #expect(lists.inboxes.map(\.id) == ["inb_northwind", "inb_harbor", "inb_personal"])
        #expect(lists.thread(id: "thr_5")?.screened == true && lists.thread(id: "thr_15")?.category == .otp)
    }

    @Test func aScreenedThreadIsInNoListButScreening() async throws {
        let store = try await LocalStore.sample()
        // A stacked, waiting newsletter whose sender isn't let in.
        var thread = try #require(sample.threads.first { $0.id == "thr_7" })
        thread.screened = true
        thread.comeBackAt = time("2026-11-20T08:00:00Z")
        thread.version += 1
        let screened = thread
        try await store.write { try $0.upsert(threads: [screened]) }
        let lists = try await store.lists(at: sample.now)
        #expect(lists.screening.map(\.id) == ["thr_5", "thr_7"])
        #expect(!lists.threads(in: .conversation, inbox: nil).contains { $0.id == "thr_7" })
        #expect(lists.threads(on: .replyLater, inbox: nil).isEmpty)
        #expect(!lists.waiting.contains { $0.id == "thr_7" })
    }

    @Test func waitingIsSoonestFirstAndEqualTimesByIdAscending() async throws {
        let store = try await LocalStore.sample()
        let base = try #require(sample.threads.first { $0.id == "thr_9" })
        let twins = ["thr_b", "thr_a"].map { id in
            var twin = base
            twin.id = id
            return twin
        }
        var sooner = base
        sooner.id = "thr_z"
        sooner.comeBackAt = time("2026-11-17T08:00:00Z")
        let written = twins + [sooner]
        try await store.write { try $0.upsert(threads: written) }
        #expect(try await store.waiting(at: sample.now).map(\.id) == ["thr_z", "thr_9", "thr_a", "thr_b"])
    }

    @Test func aCategoryThisAppDoesNotKnowListsAsUncategorized() async throws {
        let store = try await LocalStore.sample()
        var thread = try #require(sample.threads.first { $0.id == "thr_4" })
        thread.category = .unknown("travel")
        thread.version += 1
        let travel = thread
        try await store.write { try $0.upsert(threads: [travel]) }
        let lists = try await store.lists(at: sample.now)
        #expect(lists.home.contains { $0.id == "thr_4" })
        #expect(lists.threads(in: .uncategorized, inbox: nil).contains { $0.id == "thr_4" })
        #expect(lists.threads(in: .unknown("travel"), inbox: nil).contains { $0.id == "thr_4" })
        #expect(try await store.thread(id: "thr_4")?.category == .unknown("travel"))  // kept whole
    }

    @Test func inboxesAreOrderedByPosition() async throws {
        let store = try await LocalStore.sample()
        var harbor = try #require(sample.inboxes.first { $0.id == "inb_harbor" })
        var northwind = try #require(sample.inboxes.first { $0.id == "inb_northwind" })
        harbor.position = 0
        harbor.version += 1
        northwind.position = 1
        northwind.version += 1
        // A stale copy with the old position changes nothing.
        var stale = harbor
        stale.position = 2
        stale.version -= 2
        let (moved, renumbered, old) = (harbor, northwind, stale)
        try await store.write { try $0.upsert(inboxes: [moved, renumbered]) }
        try await store.write { try $0.upsert(inboxes: [old]) }
        #expect(try await store.inboxes().map(\.id) == ["inb_harbor", "inb_northwind", "inb_personal"])
    }

    @Test func theCountsAndTheAIAreKeptByVersion() async throws {
        let store = try await LocalStore.sample()
        #expect(
            try await store.status()
                == ServerStatus(counts: sample.counts, aiStatus: sample.aiStatus, aiSettings: sample.ai))
        var older = sample.aiStatus
        older.state = .unavailable
        older.version -= 1
        var newer = sample.counts
        newer.all.home = 9
        newer.version += 1
        let (stale, fresh) = (older, newer)
        try await store.write { writer in
            try writer.save(aiStatus: stale)
            try writer.save(counts: fresh)
        }
        let status = try await store.status()
        #expect(status.aiStatus?.state == .working && status.counts?.all.home == 9)
        // Removing an inbox drops its counts and lowers all: the personal inbox's Home of 1.
        try await store.write { try $0.deleteInbox(id: "inb_personal") }
        let after = try #require(try await store.status().counts)
        #expect(after.inboxes.map(\.inboxId) == ["inb_northwind", "inb_harbor"] && after.all.home == 8)
    }
}
