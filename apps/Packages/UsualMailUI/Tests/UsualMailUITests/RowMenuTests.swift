import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// A mail row's right-click menu (Home, Receipts, Notifications, To reply, Pinned, Snoozed and the Inbox page's rows,
/// and Feed's post headers): what it offers for a thread, in order, and what the undo strip says after each.
struct RowMenuTests {
    private let now = MailJSON.parseTime("2026-11-18T10:00:00Z")!  // a Wednesday
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func thread(
        unread: Bool = true, stack: Stack? = nil, category: UsualMailKit.Category = .conversation,
        sender: String? = "maya@studio.example", comeBackAt: Date? = nil
    ) -> MailThread {
        MailThread(
            id: "thr_x", inboxId: "inb_northwind", subject: "Feedback on the homepage", lastMessageAt: now,
            unread: unread, category: category, sender: sender, stack: stack, comeBackAt: comeBackAt)
    }

    private func items(_ thread: MailThread) -> [RowMenu.Item] {
        RowMenu.items(for: thread, now: now, calendar: calendar)
    }

    private func moveTo(current: UsualMailKit.Category?) -> RowMenu.Item {
        let kinds: [(String, UsualMailKit.Category)] = [
            ("Conversation", .conversation), ("Newsletter", .newsletter), ("Receipt", .receipt), ("Invoice", .invoice),
            ("Notification", .notification),
        ]
        return .menu("Move to", kinds.map { .pick($0.0, .categorize($0.1), current: $0.1 == current) })
    }

    @Test func everyGroupInOrder() {
        let snooze = SnoozeChoice.choices(now: now, calendar: calendar).map {
            RowMenu.Item.act($0.title, .comeBack(at: $0.at, ifNoReply: $0.ifNoReply))
        }
        #expect(snooze.count == 5)
        #expect(
            items(thread())
                == [
                    .open, .divider,
                    .act("Mark as read", .read), .divider,
                    .act("Archive", .done), .divider,
                    .act("Reply later", .stack(.replyLater)), .act("Pin", .stack(.setAside)), .menu("Snooze", snooze),
                    .divider,
                    moveTo(current: .conversation), .divider,
                    .act("Block sender", .blockSender, destructive: true),
                    .act("Move to Trash", .trash, destructive: true),
                ])
    }

    @Test func readMailCanBeMarkedUnread() {
        #expect(items(thread(unread: true)).contains(.act("Mark as read", .read)))
        #expect(!items(thread(unread: true)).contains(.act("Mark as unread", .unread)))
        #expect(items(thread(unread: false)).contains(.act("Mark as unread", .unread)))
        #expect(!items(thread(unread: false)).contains(.act("Mark as read", .read)))
    }

    @Test func aStackedMailCanBeTakenOffItsStack() {
        let replyLater = items(thread(stack: .replyLater))
        #expect(replyLater.contains(.act("Remove from To reply", .unstack)))
        #expect(replyLater.contains(.act("Pin", .stack(.setAside))))
        #expect(!replyLater.contains(.act("Reply later", .stack(.replyLater))))

        let pinned = items(thread(stack: .setAside))
        #expect(pinned.contains(.act("Reply later", .stack(.replyLater))))
        #expect(pinned.contains(.act("Unpin", .unstack)))
        #expect(!pinned.contains(.act("Pin", .stack(.setAside))))

        let neither = items(thread(stack: nil))
        #expect(
            !neither.contains(.act("Remove from To reply", .unstack)) && !neither.contains(.act("Unpin", .unstack)))
    }

    @Test func aSnoozedMailCanBeUnsnoozedOrSnoozedAgain() {
        let snooze = SnoozeChoice.choices(now: now, calendar: calendar).map {
            RowMenu.Item.act($0.title, .comeBack(at: $0.at, ifNoReply: $0.ifNoReply))
        }
        // Waiting until tomorrow: Unsnooze after Snooze ▸, which stays so the time can be changed.
        let waiting = items(thread(comeBackAt: now.addingTimeInterval(86_400)))
        let group: [RowMenu.Item] = [
            .act("Reply later", .stack(.replyLater)), .act("Pin", .stack(.setAside)), .menu("Snooze", snooze),
            .act("Unsnooze", .cancelComeBack),
        ]
        #expect(waiting.indices.contains { Array(waiting[$0...].prefix(4)) == group })
        #expect(ActionWords.done(.cancelComeBack) == "Unsnoozed.")
        // Not snoozed, or back already (its time has passed): no Unsnooze.
        #expect(!items(thread()).contains(.act("Unsnooze", .cancelComeBack)))
        #expect(!items(thread(comeBackAt: now.addingTimeInterval(-60))).contains(.act("Unsnooze", .cancelComeBack)))
        // On a stack and snoozed: both ways back.
        let both = items(thread(stack: .setAside, comeBackAt: now.addingTimeInterval(3600)))
        #expect(both.contains(.act("Unpin", .unstack)) && both.contains(.act("Unsnooze", .cancelComeBack)))
    }

    @Test func theWaysBackAreTheMailPagesWords() {
        // One source for both, so the menu and the mail page's buttons can't say it differently.
        let mails: [(MailThread, BarAction)] = [
            (thread(stack: .replyLater), .replyLater), (thread(stack: .setAside), .pin),
            (thread(comeBackAt: now.addingTimeInterval(3600)), .snooze),
        ]
        for (mail, action) in mails {
            let button = action.button(for: mail, now: now)
            #expect(button.chosen && button.input != nil)
            if let input = button.input { #expect(items(mail).contains(.act(button.title, input))) }
        }
    }

    @Test func theCurrentCategoryIsTicked() {
        for category: UsualMailKit.Category in [.conversation, .newsletter, .receipt, .invoice, .notification] {
            #expect(items(thread(category: category)).contains(moveTo(current: category)))
        }
        // Mail nobody has sorted, a one-time code or a kind this app doesn't know: nothing is ticked.
        for category: UsualMailKit.Category in [.uncategorized, .otp, .unknown("parcel")] {
            #expect(items(thread(category: category)).contains(moveTo(current: nil)))
        }
    }

    @Test func blockingAndTrashComeLast() {
        let all = items(thread())
        let destructive = all.filter(\.isDestructive)
        #expect(
            destructive == [
                .act("Block sender", .blockSender, destructive: true), .act("Move to Trash", .trash, destructive: true),
            ])
        #expect(Array(all.suffix(2)) == destructive)
        #expect(all[all.count - 3] == .divider)
        // A thread of only the mailbox's own mail has no sender to block.
        let own = items(thread(sender: nil))
        #expect(own.last == .act("Move to Trash", .trash, destructive: true))
        #expect(!own.contains(.act("Block sender", .blockSender, destructive: true)))
    }

    @Test func theUndoStripNamesEveryActionInTheMenu() {
        #expect(ActionWords.done(.read) == "Marked as read.")
        #expect(ActionWords.done(.unread) == "Marked as unread.")
        #expect(ActionWords.done(.done) == "Archived.")
        #expect(ActionWords.done(.stack(.replyLater)) == "Moved to To reply.")
        #expect(ActionWords.done(.stack(.setAside)) == "Pinned.")
        #expect(ActionWords.done(.unstack) == "Taken off its list.")
        #expect(ActionWords.done(.categorize(.conversation)) == "Moved to Home.")
        #expect(ActionWords.done(.categorize(.invoice)) == "Moved to the paper trail as an invoice.")
        #expect(ActionWords.done(.categorize(.notification)) == "Moved to notifications.")
        #expect(ActionWords.done(.blockSender) == "Blocked.")
        #expect(ActionWords.done(.trash) == "Removed.")
        // Nothing in the menu falls to the strip's catch-all.
        func every(_ items: [RowMenu.Item]) -> [ActionInput] {
            items.flatMap { item -> [ActionInput] in
                switch item {
                case .act(_, let input, _), .pick(_, let input, _): [input]
                case .menu(_, let inner): every(inner)
                case .open, .divider: []
                }
            }
        }
        let inputs =
            every(items(thread())) + every(items(thread(unread: false, stack: .setAside)))
            + every(items(thread(comeBackAt: now.addingTimeInterval(3600))))
        #expect(!inputs.isEmpty)
        for input in inputs { #expect(ActionWords.done(input) != "Done.", "\(input) has no words") }
    }
}
