import Testing
import UsualMailKit

@testable import UsualMailUI

/// How many To reply, Pinned and Snoozed hold, on the rail (owner's words of 2026-11-20: "the groups (like snooz,
/// repply and pin) should show the number of items inside them"): the server's counts in every inbox, always, as each
/// list is a stack of its own that no profile scopes (the coordinator's spec of 2026-11-20), as they change; and how a
/// count is written.
@MainActor
struct RailCountTests {
    private let counts = Counts(
        all: ThreadCounts(home: 9, unread: 4, stacks: [.replyLater: 3, .setAside: 120], waiting: 0, screened: 2),
        inboxes: [
            InboxCounts(inboxId: "inb_a", counts: ThreadCounts(stacks: [.replyLater: 1, .setAside: 0], waiting: 5)),
            InboxCounts(inboxId: "inb_b", counts: ThreadCounts(stacks: [.replyLater: 2, .setAside: 120], waiting: 0)),
        ],
        version: 1)

    @Test func eachListTakesItsOwnCount() {
        #expect(RailCount.count(.toReply, in: counts) == 3)
        #expect(RailCount.count(.pinned, in: counts) == 120)
        #expect(RailCount.count(.snoozed, in: counts) == 0)
        // No count on the rail's other buttons, nor anywhere else.
        for place: Place in [.inbox, .search, .settings, .screening, .tab(.home)] {
            #expect(RailCount.count(place, in: counts) == 0)
        }
    }

    @Test func theyAreEveryInboxsWhateverTheProfile() {
        // Not inb_a's 1 or inb_b's 2: all of them, 3, whichever profile the mail stack is on.
        var nav = Navigation(profile: "inb_a")
        nav.press(.toReply)
        #expect(RailCount.count(.toReply, in: counts) == 3 && nav.activeProfile == nil)
        // No counts at all: nothing, never counted from the copy.
        #expect(RailCount.count(.toReply, in: nil) == 0)
    }

    @Test func aCountIsWrittenUpTo99() {
        #expect(RailCount.words(0) == nil)
        #expect(RailCount.words(-1) == nil)
        #expect(RailCount.words(1) == "1")
        #expect(RailCount.words(42) == "42")
        #expect(RailCount.words(99) == "99")
        #expect(RailCount.words(100) == "99+")
        #expect(RailCount.words(12_000) == "99+")
    }

    @Test func theyChangeWithTheServersCounts() async throws {
        let store = try await MailStore.sample()
        var newer = counts
        newer.version = (store.counts?.version ?? 0) + 1
        await store.receive(.countsChanged(newer))
        #expect(RailCount.count(.toReply, in: store.counts) == 3)
        #expect(RailCount.words(RailCount.count(.pinned, in: store.counts)) == "99+")

        // `counts.changed`: one more snoozed in inb_a, and in all of them.
        var changed = newer
        changed.version += 1
        changed.all.waiting = 1
        changed.inboxes[0].counts.waiting = 6
        await store.receive(.countsChanged(changed))
        #expect(RailCount.count(.snoozed, in: store.counts) == 1)
        // An older copy changes nothing.
        await store.receive(.countsChanged(newer))
        #expect(RailCount.count(.snoozed, in: store.counts) == 1)
    }
}
