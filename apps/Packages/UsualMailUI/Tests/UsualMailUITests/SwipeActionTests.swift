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
        #expect(SwipeAction.seen.step(for: thread, now: .now) == SwipeStep(words: "Seen", icon: .seen, input: .read))
        thread.unread = false
        #expect(
            SwipeAction.seen.step(for: thread, now: .now) == SwipeStep(words: "Unseen", icon: .unseen, input: .unread))
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
}
