import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// What swiping a mail on Home does on the iPhone, each way (`SwipeAction`; the owner's words of 2026-11-25): left
/// marks it seen, right snoozes it, unless Settings says otherwise; each does what the row's menu does.
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
        #expect(SwipeAction.leftDefault == .seen && SwipeAction.rightDefault == .snooze)
        #expect(SwipeAction.leftKey != SwipeAction.rightKey)
        // Every choice has its own name in Settings, and one does nothing.
        #expect(Set(SwipeAction.allCases.map(\.title)).count == SwipeAction.allCases.count)
        #expect(SwipeAction.nothing.step(for: try mail(), now: .now) == nil)
    }

    @Test func seenMovesAMailBetweenNewAndSeen() throws {
        var thread = try mail()
        #expect(
            SwipeAction.seen.step(for: thread, now: .now)
                == SwipeStep(words: "Seen", icon: .seen, input: .read, spoken: "Mark as read"))
        thread.unread = false
        #expect(
            SwipeAction.seen.step(for: thread, now: .now)
                == SwipeStep(words: "Unseen", icon: .unseen, input: .unread, spoken: "Mark as unread"))
    }

    @Test func snoozeAsksWhenAndTheOthersDoWhatTheMailPageDoes() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var thread = try mail()
        // Snooze has no action of its own: its times are chosen first.
        #expect(
            SwipeAction.snooze.step(for: thread, now: now) == SwipeStep(words: "Snooze", icon: .snoozed, input: nil))
        #expect(SwipeAction.replyLater.step(for: thread, now: now)?.input == .stack(.replyLater))
        #expect(SwipeAction.pin.step(for: thread, now: now)?.input == .stack(.setAside))
        #expect(SwipeAction.archive.step(for: thread, now: now)?.input == .done)
        // A mail already there gets the way back, in the mail page's words.
        thread.stack = .setAside
        #expect(
            SwipeAction.pin.step(for: thread, now: now) == SwipeStep(words: "Unpin", icon: .pinned, input: .unstack))
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
        #expect(SwipeAction.leftKey == "UsualMailSwipeLeft")
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
