import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// What the sync notice's button does, out of the view (`SyncNoticeDispatch`), and how Try again goes (`SyncRetry`):
/// the server only queues a sync, so a good answer says it asked and waits for the inbox to change, at most 30 seconds;
/// a refusal says why (the review of 2026-11-25).
@MainActor
struct SyncRetryTests {
    struct Refused: LocalizedError {
        var errorDescription: String? { "Can't reach your server." }
    }

    /// A dispatch whose every effect is recorded; Try again fails with `refusing`.
    @MainActor final class Recorded {
        var opened: [URL] = []
        var synced: [String] = []
        var moved: [SyncNotice.Action] = []
        var refusing = false

        var dispatch: SyncNoticeDispatch {
            SyncNoticeDispatch(
                openURL: { self.opened.append($0) },
                dashboardURL: { URL(string: "https://mail.example/inboxes/\($0)")! },
                syncInbox: { id in
                    self.synced.append(id)
                    if self.refusing { throw Refused() }
                },
                navigate: { self.moved.append($0) })
        }
    }

    @Test func eachStepDoesItsOwnThingAndOnlyTryAgainAsksTheServer() async {
        let recorded = Recorded()
        let dispatch = recorded.dispatch
        #expect(await dispatch.run(.dashboard(inboxId: "inb_personal")) == nil)
        #expect(recorded.opened == [URL(string: "https://mail.example/inboxes/inb_personal")!])
        #expect(await dispatch.run(.signIn(inboxId: "inb_northwind")) == nil)
        #expect(await dispatch.run(.openAccounts) == nil)
        #expect(recorded.moved == [.signIn(inboxId: "inb_northwind"), .openAccounts])
        #expect(recorded.synced.isEmpty)
        #expect(await dispatch.run(.tryAgain(inboxId: "inb_personal")) == .asked)
        recorded.refusing = true
        #expect(
            await dispatch.run(.tryAgain(inboxId: "inb_personal"))
                == .refused("Your server couldn't be asked to sync. Can't reach your server."))
        #expect(recorded.synced == ["inb_personal", "inb_personal"])
    }

    private func snapshot(_ status: InboxStatus, detail: String? = "Connection refused") throws -> SyncSnapshot {
        var inbox = try #require(SampleData.bundled.inboxes.first { $0.id == "inb_personal" })
        inbox.status = status
        inbox.statusDetail = detail
        return SyncSnapshot(inbox)
    }

    @Test func askedItWaitsForTheInboxToChangeOrThirtySeconds() throws {
        let start = Date(timeIntervalSince1970: 1_000_000)
        let failing = try snapshot(.needsAttention)
        var retry = SyncRetry()
        #expect(!retry.busy && retry.line == nil)
        retry.began()
        #expect(retry.busy && retry.line == nil, "working while the request is on its way")
        retry.answered(.asked, inbox: failing, at: start)
        #expect(retry.busy && retry.line == "Asked your server to sync." && !retry.refused)
        // Nothing changed yet: still waiting, twenty seconds on.
        retry.saw(failing, at: start.addingTimeInterval(20))
        #expect(retry.busy)
        // Thirty seconds: done waiting, the line goes.
        retry.saw(failing, at: start.addingTimeInterval(30))
        #expect(!retry.busy && retry.line == nil)
        // The inbox's words changed: done at once.
        retry.began()
        retry.answered(.asked, inbox: failing, at: start)
        retry.saw(try snapshot(.needsAttention, detail: "Timed out"), at: start.addingTimeInterval(2))
        #expect(!retry.busy)
        // Gone from the store (removed meanwhile): done too.
        retry.began()
        retry.answered(.asked, inbox: failing, at: start)
        retry.saw(nil, at: start.addingTimeInterval(1))
        #expect(!retry.busy)
    }

    @Test func aRefusalSaysWhyAndLeavesTheButtonFree() {
        var retry = SyncRetry()
        retry.began()
        retry.answered(
            .refused("Your server couldn't be asked to sync. Can't reach your server."), inbox: nil, at: Date())
        #expect(!retry.busy && retry.refused)
        #expect(retry.line == "Your server couldn't be asked to sync. Can't reach your server.")
        // Pressed again: the refusal goes while it asks.
        retry.began()
        #expect(retry.busy && retry.line == nil)
        // A step that asks the server nothing ends at once.
        retry.answered(nil, inbox: nil, at: Date())
        #expect(retry.phase == .idle)
    }
}
