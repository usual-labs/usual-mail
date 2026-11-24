import SwiftUI
import UsualMailKit

/// A mail row's right-click menu (owner's request of 2026-11-18: "add a menu on right click, to put some quick actions
/// there"), on the rows of Home, Receipts, Notifications, To reply, Pinned, Snoozed and the Inbox page, and on Feed's
/// post headers, in groups: open; read or unread; archive; reply later, pin and snooze, in the mail page's words
/// (`BarAction`), with the way back for a mail already there; move to another category; then block the sender and
/// move to the trash. Each choice is the person's own action, so the undo strip says what happened. On a notification
/// group's row the choices act on every thread in the group, and read or unread follows the group (`unread`).
enum RowMenu {
    enum Item: Hashable {
        /// Opens the mail, as a click does.
        case open
        case act(String, ActionInput, destructive: Bool = false)
        /// One of several choices with the current one ticked; choosing the current one does nothing.
        case pick(String, ActionInput, current: Bool)
        case menu(String, [Item])
        case divider

        var isDestructive: Bool {
            if case .act(_, _, true) = self { true } else { false }
        }
    }

    /// The categories a person can move a mail to, in the menu's order. Nobody can choose `unknown`, and a one-time
    /// code isn't offered.
    static let destinations: [UsualMailKit.Category] = [.conversation, .newsletter, .receipt, .invoice, .notification]

    /// The menu for `thread`; `unread` is whether the row reads as unread, the thread's own state unless given (a
    /// group's row: any of its threads). A thread that waits to come back at `now` can be unsnoozed, and snoozed again
    /// to change its time.
    static func items(for thread: MailThread, unread: Bool? = nil, now: Date, calendar: Calendar = .current) -> [Item] {
        let read: Item = (unread ?? thread.unread) ? .act("Mark as read", .read) : .act("Mark as unread", .unread)
        // Reply later and pin as the mail page's buttons say them: "Remove from To reply" and "Unpin" for a mail
        // already there.
        let stacks = [BarAction.replyLater, .pin].compactMap { item($0.button(for: thread, now: now)) }
        let snooze = SnoozeChoice.choices(now: now, calendar: calendar).map {
            Item.act($0.title, .comeBack(at: $0.at, ifNoReply: $0.ifNoReply))
        }
        var later: [Item] = stacks + [.menu("Snooze", snooze)]
        // A mail that waits to come back can also be unsnoozed, as the mail page's snooze button then does.
        let unsnooze = BarAction.snooze.button(for: thread, now: now)
        if unsnooze.chosen, let item = item(unsnooze) { later.append(item) }
        let moveTo = destinations.map {
            Item.pick(WhyWords.title($0), .categorize($0), current: thread.category == $0)
        }
        var last: [Item] = []
        // A thread of only the mailbox's own mail has no sender to block.
        if thread.sender != nil { last.append(.act("Block sender", .blockSender, destructive: true)) }
        last.append(.act("Move to Trash", .trash, destructive: true))
        // Archive, or for a mail already done (only search finds one), "Move to Inbox", as the mail page says it.
        let archive = BarAction.archive.button(for: thread, now: now)
        let groups: [[Item]] = [
            [.open],
            [read],
            [.act(archive.title, archive.input ?? .done)],
            later,
            [.menu("Move to", moveTo)],
            last,
        ]
        return Array(groups.joined(separator: [.divider]))
    }

    /// A mail page button as a menu item: its words and its action. None for a button that opens a menu instead.
    private static func item(_ button: BarButton) -> Item? {
        button.input.map { .act(button.title, $0) }
    }
}

/// The menu's items as a macOS menu: buttons, ticks for the current choice, submenus and separators.
struct RowMenuItems: View {
    let items: [RowMenu.Item]
    let open: () -> Void
    let act: (ActionInput) -> Void

    var body: some View {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
            switch item {
            case .open:
                Button("Open", action: open)
            case .act(let title, let input, let destructive):
                Button(title, role: destructive ? .destructive : nil) { act(input) }
            case .pick(let title, let input, let current):
                Toggle(title, isOn: Binding(get: { current }, set: { _ in if !current { act(input) } }))
            case .menu(let title, let inner):
                Menu(title) { RowMenuItems(items: inner, open: open, act: act) }
            case .divider:
                Divider()
            }
        }
    }
}

extension View {
    /// The row's right-click menu for `thread`, read or unread as `unread` says when given. Right-clicking only shows
    /// it; choosing an item acts. The snooze times, and whether the thread still waits to come back, are worked out
    /// for `now` (the store's, where the row has it) when the menu is drawn.
    func rowMenu(
        for thread: MailThread, unread: Bool? = nil, now: Date = Date(), open: @escaping () -> Void,
        act: @escaping (ActionInput) -> Void
    ) -> some View {
        contextMenu {
            RowMenuItems(items: RowMenu.items(for: thread, unread: unread, now: now), open: open, act: act)
        }
    }
}
