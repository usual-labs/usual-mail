import Foundation
import UsualMailKit

/// What swiping a mail on Home does, each way, on the iPhone (the owner's words of 2026-11-25: "swiping on right and
/// left on each mail should do an action. bu default swipe to left should mark it as seen, on swipe right should snooze
/// it. these settings should be changable in settings"). Left is the finger moving left, the row sliding off to the
/// left; right the other way. Each way is a setting on this device (`leftKey`, `rightKey`; Settings' Appearance tab),
/// as the background is: the server keeps none.
enum SwipeAction: String, CaseIterable, Identifiable, Sendable {
    case seen, snooze, replyLater, pin, archive, nothing

    static let leftKey = "UsualMailSwipeLeft"
    static let rightKey = "UsualMailSwipeRight"
    static let leftDefault = SwipeAction.seen
    static let rightDefault = SwipeAction.snooze

    var id: Self { self }

    /// Its name in Settings.
    var title: String {
        switch self {
        case .seen: "Seen or unseen"
        case .snooze: "Snooze"
        case .replyLater: "Reply later"
        case .pin: "Pin"
        case .archive: "Archive"
        case .nothing: "Nothing"
        }
    }

    /// What it does to `thread` at `now`, as the row's menu and the mail page's buttons do it (`RowMenu`,
    /// `BarAction.button`): seen marks a new mail read and a seen one unread again, as Home's New and Seen are; reply
    /// later, pin and archive offer the way back for a mail already there; snooze asks when first, or unsnoozes a mail
    /// that waits. Nil for nothing.
    func step(for thread: MailThread, now: Date) -> SwipeStep? {
        switch self {
        case .seen:
            return thread.unread
                ? SwipeStep(words: "Seen", icon: .seen, input: .read)
                : SwipeStep(words: "Unseen", icon: .unseen, input: .unread)
        case .snooze:
            let button = BarAction.snooze.button(for: thread, now: now)
            return SwipeStep(words: button.title, icon: .snoozed, input: button.input)
        case .replyLater, .pin, .archive:
            let action: BarAction = self == .replyLater ? .replyLater : self == .pin ? .pin : .archive
            let button = action.button(for: thread, now: now)
            return SwipeStep(words: button.title, icon: action.icon, input: button.input)
        case .nothing:
            return nil
        }
    }
}

/// One swipe on a row: what shows behind the row as it moves, and what letting go past the threshold does. No input is
/// snooze's: its times to choose from first.
struct SwipeStep: Equatable {
    let words: String
    let icon: Icon
    let input: ActionInput?
}
