import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The corner note while the server works on mail: fetching, then sorting and summarizing, with what is left.
struct ActivityNoteTests {
    let sample = SampleData.bundled

    private func status(_ state: String, pending: Int) -> AiStatus {
        let json = #"{"state":"\#(state)","pending":\#(pending),"version":1}"#
        return try! MailJSON.decoder().decode(AiStatus.self, from: Data(json.utf8))
    }

    /// The sample's inboxes, the first `connecting` of them connecting and the rest ok, none with a first sync's count
    /// (the sample gives one to an inbox that needs the person; here a test gives one where it wants it).
    private func inboxes(connecting: Int) -> [Inbox] {
        sample.inboxes.enumerated().map { index, inbox in
            var inbox = inbox
            inbox.status = index < connecting ? .connecting : .ok
            inbox.firstSync = nil
            return inbox
        }
    }

    @Test func nothingWhenNothingIsHappening() {
        #expect(ActivityWords.lines(inboxes: inboxes(connecting: 0), status: status("working", pending: 0)).isEmpty)
        #expect(ActivityWords.lines(inboxes: inboxes(connecting: 0), status: nil).isEmpty)
    }

    @Test func fetchingNamesTheInboxOrCountsThem() throws {
        let first = try #require(sample.inboxes.first)
        #expect(
            ActivityWords.lines(inboxes: inboxes(connecting: 1), status: nil) == ["Fetching mail from \(first.name)…"])
        #expect(ActivityWords.lines(inboxes: inboxes(connecting: 2), status: nil) == ["Fetching mail from 2 inboxes…"])
    }

    @Test func fetchingSaysHowFarAFirstSyncHasGot() throws {
        var fetching = inboxes(connecting: 2)
        fetching[0].firstSync = FirstSyncProgress(fetched: 120, total: 340)
        #expect(
            ActivityWords.lines(inboxes: Array(fetching.prefix(1)), status: nil)
                == ["Fetching mail from \(fetching[0].name) · 120 of 340"])
        // Two inboxes add up what they have said: one still connecting without a count (just connected, resumed or
        // signed in again) doesn't hide the other's. With none said, no count.
        #expect(ActivityWords.lines(inboxes: fetching, status: nil) == ["Fetching mail from 2 inboxes · 120 of 340"])
        #expect(ActivityWords.lines(inboxes: inboxes(connecting: 2), status: nil) == ["Fetching mail from 2 inboxes…"])
        fetching[1].firstSync = FirstSyncProgress(fetched: 1000, total: 2000)
        #expect(
            ActivityWords.lines(inboxes: fetching, status: nil) == ["Fetching mail from 2 inboxes · 1,120 of 2,340"])
        // A long first sync whose status already says ok is still fetching; one that needs the person isn't.
        fetching[1].status = .ok
        fetching[0].status = .needsAttention
        #expect(
            ActivityWords.lines(inboxes: fetching, status: nil) == [
                "Fetching mail from \(fetching[1].name) · 1,000 of 2,000"
            ])
    }

    @Test func theAIsWorkCountsDown() {
        #expect(
            ActivityWords.lines(inboxes: inboxes(connecting: 1), status: status("working", pending: 34)).last
                == "Sorting and summarizing · 34 left")
        // A problem with the AI is said under Home's list, not here.
        #expect(
            ActivityWords.lines(inboxes: inboxes(connecting: 0), status: status("key_refused", pending: 34)).isEmpty)
    }
}
