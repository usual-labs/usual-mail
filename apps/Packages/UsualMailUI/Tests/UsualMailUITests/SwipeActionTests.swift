import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// What swiping a mail on Home does on the iPhone, each way (`SwipeAction`; the owner's words of 2026-11-25): left
/// marks it seen, right snoozes it, unless Settings says otherwise; each does what the row's menu does. Notifications
/// and the Feed have their own (the owner's words of 2026-11-27), the Feed's left unsubscribing.
struct SwipeActionTests {
    /// A mail in New: unread, on no stack, not snoozed, not done.
    private func mail() throws -> MailThread {
        var thread = try #require(SampleData.bundled.threads.first { $0.id == "thr_1" })
        thread.unread = true
        thread.stack = nil
        thread.comeBackAt = nil
        thread.done = false
        return thread
    }

    @Test func leftMarksItSeenAndRightSnoozesIt() throws {
        #expect(SwipeList.home.leftDefault == .seen && SwipeList.home.rightDefault == .snooze)
        // Every choice has its own name in Settings, and one does nothing.
        #expect(Set(SwipeAction.allCases.map(\.title)).count == SwipeAction.allCases.count)
        #expect(SwipeAction.nothing.step(for: try mail(), now: .now) == nil)
    }

    @Test func notificationsArchiveRightAndTheFeedUnsubscribesLeft() {
        #expect(SwipeList.notifications.leftDefault == .seen && SwipeList.notifications.rightDefault == .archive)
        #expect(SwipeList.feed.leftDefault == .unsubscribe && SwipeList.feed.rightDefault == .archive)
        // Blocking alone is still a choice, on every list.
        #expect(SwipeAction.allCases.contains(.block) && SwipeAction.unsubscribe.title == "Unsubscribe")
        // Each list and way has its own setting; Home keeps the keys it had.
        let keys = SwipeList.allCases.flatMap { [$0.leftKey, $0.rightKey] }
        #expect(Set(keys).count == 6)
        #expect(SwipeList.home.leftKey == "UsualMailSwipeLeft" && SwipeList.home.rightKey == "UsualMailSwipeRight")
        #expect(Set(SwipeList.allCases.map(\.title)).count == 3)
    }

    @Test func seenMovesAMailBetweenNewAndSeen() throws {
        var thread = try mail()
        #expect(
            SwipeAction.seen.step(for: thread, now: .now)
                == SwipeStep(words: "Seen", icon: .seen, input: .read, targets: ["thr_1"], spoken: "Mark as read"))
        thread.unread = false
        #expect(
            SwipeAction.seen.step(for: thread, now: .now)
                == SwipeStep(
                    words: "Unseen", icon: .unseen, input: .unread, targets: ["thr_1"], spoken: "Mark as unread"))
    }

    /// A notification group's row stands for every thread in it, as its menu and its tick do.
    @Test func aGroupsRowSwipesEveryThreadInIt() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let newest = try mail()
        var older = try mail()
        older.id = "thr_older"
        older.unread = false
        let row = [newest, older]
        // Seen marks only the unread ones read, as the tick does; once all are read, every one unread again.
        #expect(SwipeAction.seen.step(for: row, now: now)?.targets == ["thr_1"])
        var read = newest
        read.unread = false
        #expect(SwipeAction.seen.step(for: [read, older], now: now)?.input == .unread)
        #expect(SwipeAction.seen.step(for: [read, older], now: now)?.targets == ["thr_1", "thr_older"])
        // Archive takes the whole row off the tab.
        #expect(
            SwipeAction.archive.step(for: row, now: now)
                == SwipeStep(words: "Archive", icon: .archive, input: .done, targets: ["thr_1", "thr_older"]))
        #expect(SwipeAction.snooze.step(for: row, now: now)?.targets == ["thr_1", "thr_older"])
    }

    /// Blocking asks first, blocks the sender the row names (every thread of theirs with it), and isn't offered for a
    /// thread with no sender, as the row's menu isn't.
    @Test func blockAsksFirstAndNeedsASender() throws {
        var thread = try mail()
        thread.sender = "news@kestrel.example"
        let step = try #require(SwipeAction.block.step(for: [thread, try mail()], now: .now))
        #expect(step.confirms && step.asks == .block && step.input == .blockSender && step.targets == ["thr_1"])
        #expect(step.spoken == "Block sender")
        #expect(
            RowMenu.items(for: thread, now: .now).contains { item in
                if case .act(_, .blockSender, _) = item { true } else { false }
            })
        thread.sender = nil
        #expect(SwipeAction.block.step(for: thread, now: .now) == nil)
        // Nothing else asks first but unsubscribing.
        thread.sender = "news@kestrel.example"
        for action in SwipeAction.allCases where action != .block && action != .unsubscribe {
            #expect(action.step(for: thread, now: .now)?.confirms != true)
        }
    }

    /// Unsubscribing asks first, in its own words, then blocks the sender the row names (the block is the row menu's
    /// Block sender, with its undo) and asks the server to have them stop; no sender, no swipe.
    @Test func unsubscribeAsksFirstAndNeedsASender() throws {
        var thread = try mail()
        thread.sender = "news@kestrel.example"
        let step = try #require(SwipeAction.unsubscribe.step(for: [thread, try mail()], now: .now))
        #expect(step.asks == .unsubscribe && step.input == .blockSender && step.targets == ["thr_1"])
        #expect(step.words == "Unsubscribe" && step.spoken == "Unsubscribe")
        thread.sender = nil
        #expect(SwipeAction.unsubscribe.step(for: thread, now: .now) == nil)
        // The question, by the sender's name, and its red button.
        let question = SwipeQuestion.unsubscribe
        #expect(question.title("Kestrel Roasters") == "Unsubscribe from Kestrel Roasters?")
        #expect(question.title(nil) == "Unsubscribe from this sender?")
        #expect(question.button == "Unsubscribe")
        // Every effect named: the block, an email from this inbox's address, Browser Use, and what Undo takes back.
        for effect in ["archived", "an email sent from this inbox's address", "Browser Use", "Undo only unblocks them"]
        {
            #expect(question.words.contains(effect), "\(effect)")
        }
        // Blocking's own question is as it was.
        #expect(SwipeQuestion.block.title("Kestrel Roasters") == "Block Kestrel Roasters?")
        #expect(SwipeQuestion.block.button == "Block sender")
        // The Feed's footer says both ask first.
        #expect(SwipeList.feed.footer.contains("Unsubscribing and blocking ask first"))
    }

    @Test func snoozeAsksWhenAndTheOthersDoWhatTheMailPageDoes() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var thread = try mail()
        // Snooze has no action of its own: its times are chosen first.
        #expect(
            SwipeAction.snooze.step(for: thread, now: now)
                == SwipeStep(words: "Snooze", icon: .snoozed, input: nil, targets: ["thr_1"]))
        #expect(SwipeAction.replyLater.step(for: thread, now: now)?.input == .stack(.replyLater))
        #expect(SwipeAction.pin.step(for: thread, now: now)?.input == .stack(.setAside))
        #expect(SwipeAction.archive.step(for: thread, now: now)?.input == .done)
        // A mail already there gets the way back, in the mail page's words.
        thread.stack = .setAside
        #expect(
            SwipeAction.pin.step(for: thread, now: now)
                == SwipeStep(words: "Unpin", icon: .pinned, input: .unstack, targets: ["thr_1"]))
        thread.comeBackAt = now.addingTimeInterval(3600)
        #expect(SwipeAction.snooze.step(for: thread, now: now)?.input == .cancelComeBack)
    }

    /// Every action the row's menu offers, its submenus' too.
    private func menuInputs(_ items: [RowMenu.Item]) -> [ActionInput] {
        items.flatMap { item -> [ActionInput] in
            switch item {
            case .act(_, let input, _), .pick(_, let input, _): [input]
            case .menu(_, let inner): menuInputs(inner)
            case .open, .divider: []
            }
        }
    }

    @Test func eachSwipeDoesWhatTheRowsMenuOffers() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var new = try mail()
        var seen = try mail()
        seen.unread = false
        var pinned = try mail()
        pinned.stack = .setAside
        var waiting = try mail()
        waiting.comeBackAt = now.addingTimeInterval(3600)
        new.unread = true
        for thread in [new, seen, pinned, waiting] {
            let offered = menuInputs(RowMenu.items(for: thread, now: now))
            for action in SwipeAction.allCases {
                guard let step = action.step(for: thread, now: now) else { continue }
                if let input = step.input {
                    #expect(offered.contains(input), "\(action) on \(thread.stack.map { "\($0)" } ?? "a mail")")
                } else {
                    // Snooze asks when: each time it offers is one the menu offers, through the same choices.
                    for choice in SnoozeChoice.choices(now: now) {
                        #expect(offered.contains(choice.input))
                    }
                }
            }
        }
    }

    @Test func aDragLeftReadsTheLeftSettingAndAFlickCounts() {
        #expect(SwipeDrag.side(of: -30) == .left && SwipeDrag.side(of: 30) == .right && SwipeDrag.side(of: 0) == nil)
        // Past the threshold, it acts; short of it, slowly, it doesn't; a short fast flick does.
        #expect(SwipeDrag.commits(translation: -SwipeDrag.threshold, velocity: 0))
        #expect(!SwipeDrag.commits(translation: -40, velocity: 0))
        #expect(SwipeDrag.commits(translation: -40, velocity: -800))
        // A drag pulled back the other way at the end doesn't.
        #expect(!SwipeDrag.commits(translation: 100, velocity: -1000))
        // The row follows the finger, then resists, never past the limit.
        #expect(SwipeDrag.offset(for: -60) == -60)
        #expect(SwipeDrag.offset(for: SwipeDrag.free + 30) == SwipeDrag.free + 10)
        #expect(SwipeDrag.offset(for: -2000) == -SwipeDrag.limit)
    }
}

/// The iPhone mail page's swipe in from the left edge (`EdgeBack`; the owner's words of 2026-11-26): it goes back when
/// let go past a third of the width or flicked there, as iOS's back swipe does, and never moves the page left.
struct EdgeBackTests {
    @Test func thePageFollowsTheFingerButNotPastWhereItSits() {
        #expect(EdgeBack.offset(for: 120) == 120)
        #expect(EdgeBack.offset(for: -30) == 0)
    }

    @Test func farEnoughOrFastEnoughGoesBack() {
        #expect(EdgeBack.commits(translation: 160, velocity: 0, width: 402))
        #expect(!EdgeBack.commits(translation: 100, velocity: 0, width: 402))
        // A short flick reaches it.
        #expect(EdgeBack.commits(translation: 60, velocity: 800, width: 402))
        #expect(!EdgeBack.commits(translation: 0, velocity: 800, width: 402))
    }

    @Test func aFlickBackTowardTheEdgeStaysUnlessPastHalf() {
        #expect(!EdgeBack.commits(translation: 180, velocity: -50, width: 402))
        #expect(EdgeBack.commits(translation: 220, velocity: -50, width: 402))
    }
}
