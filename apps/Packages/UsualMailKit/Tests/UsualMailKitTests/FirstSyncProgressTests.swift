import Foundation
import Testing

@testable import UsualMailKit

/// How far an inbox's first sync has got (docs/contract-sync.md, "How far a first sync has got"; the owner's decision
/// of 2026-11-23): `Inbox.firstSync` as the server sends it, core's words for it, and the first run's lines.
struct FirstSyncProgressTests {
    let sample = SampleData.bundled

    @Test func anInboxCarriesItsCountOnlyWhileItsFirstSyncRuns() throws {
        let inbox = try #require(sample.inboxes.first)
        #expect(inbox.firstSync == nil)
        #expect(try encodedJSON(inbox)["firstSync"] == nil, "left out, as the server leaves it out")
        var json = try encodedJSON(inbox)
        guard case .object(var fields) = json else { throw Failure.notAnObject }
        fields["status"] = .string("connecting")
        fields["firstSync"] = .object(["fetched": .number(120), "total": .number(340)])
        json = .object(fields)
        let decoded = try MailJSON.decoder().decode(Inbox.self, from: MailJSON.encoder().encode(json))
        #expect(decoded.firstSync == FirstSyncProgress(fetched: 120, total: 340))
        #expect(try encodedJSON(decoded) == json, "written back as it came")
        // As `inbox.changed` brings it.
        let event = try MailJSON.decoder().decode(
            MailEvent.self,
            from: MailJSON.encoder().encode(JSONValue.object(["type": .string("inbox.changed"), "inbox": json])))
        guard case .inboxChanged(let changed) = event else { throw Failure.notAnObject }
        #expect(changed.firstSync?.fetched == 120)
    }

    @Test func coresWordsForTheCount() {
        #expect(FirstSyncProgress(fetched: 120, total: 340).count == "120 of 340")
        #expect(FirstSyncProgress(fetched: 1200, total: 3400).count == "1,200 of 3,400")
        #expect(FirstSyncProgress(fetched: 0, total: 1_234_567).count == "0 of 1,234,567")
        #expect(FirstSyncProgress(fetched: 120, total: 340).words == "Fetching your mail · 120 of 340")
    }

    @Test func fetchingIsConnectingOrAFirstSyncStillRunning() throws {
        var inbox = try #require(sample.inboxes.first)
        #expect(!inbox.isFetching && inbox.fetching == nil)
        inbox.status = .connecting
        #expect(inbox.isFetching && inbox.fetching == nil, "connecting, before any count")
        inbox.firstSync = FirstSyncProgress(fetched: 4, total: 7)
        #expect(inbox.fetching == FirstSyncProgress(fetched: 4, total: 7))
        // A long first sync whose status already says ok is still fetching.
        inbox.status = .ok
        #expect(inbox.isFetching && inbox.fetching != nil)
        // Paused or needing the person, it says that instead.
        for status in [InboxStatus.paused, .needsAttention] {
            inbox.status = status
            #expect(!inbox.isFetching && inbox.fetching == nil)
        }
    }

    @Test func severalInboxesAddUpWhatTheyHaveSaid() throws {
        var inboxes = Array(sample.inboxes.prefix(2))
        inboxes[0].status = .connecting
        inboxes[1].status = .connecting
        #expect(FirstSyncProgress.sum(inboxes) == nil, "none has said yet")
        inboxes[0].firstSync = FirstSyncProgress(fetched: 120, total: 340)
        // One connecting without a count (just connected, resumed or signed in again) doesn't hide the other's.
        #expect(FirstSyncProgress.sum(inboxes) == FirstSyncProgress(fetched: 120, total: 340))
        inboxes[1].firstSync = FirstSyncProgress(fetched: 1000, total: 2000)
        #expect(FirstSyncProgress.sum(inboxes) == FirstSyncProgress(fetched: 1120, total: 2340))
        #expect(FirstSyncProgress.sum([]) == nil)
    }

    @Test func theFirstRunSaysHowFarItHasGot() throws {
        var inboxes = Array(sample.inboxes.prefix(2))
        inboxes[0].status = .ok
        inboxes[1].status = .connecting
        let working = AiStatus(state: .working, pending: 0)
        #expect(Onboarding.progressWords(status: working, inboxes: inboxes) == "Fetching your mail")
        inboxes[1].firstSync = FirstSyncProgress(fetched: 120, total: 340)
        #expect(Onboarding.progressWords(status: working, inboxes: inboxes) == "Fetching your mail · 120 of 340")
        #expect(Onboarding.inboxWords(inboxes[1]) == "\(inboxes[1].address) · Connected, fetching mail · 120 of 340")
        // Another inbox connecting meanwhile, without a count yet, leaves the count as it is.
        inboxes[0].status = .connecting
        #expect(Onboarding.progressWords(status: working, inboxes: inboxes) == "Fetching your mail · 120 of 340")
        inboxes[0].status = .ok
        // Still fetching while its status already says ok: not all sorted yet.
        inboxes[1].status = .ok
        #expect(Onboarding.progressWords(status: working, inboxes: inboxes) == "Fetching your mail · 120 of 340")
        inboxes[1].firstSync = nil
        #expect(Onboarding.progressWords(status: working, inboxes: inboxes) == "All sorted")
    }

    private enum Failure: Error {
        case notAnObject
    }
}
