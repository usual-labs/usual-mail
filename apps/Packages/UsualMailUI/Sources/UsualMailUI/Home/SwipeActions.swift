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
                ? SwipeStep(words: "Seen", icon: .seen, input: .read, spoken: "Mark as read")
                : SwipeStep(words: "Unseen", icon: .unseen, input: .unread, spoken: "Mark as unread")
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
/// snooze's: its times to choose from first (`SnoozeChoice.input`). `spoken` is its name as a VoiceOver action, the row
/// menu's ("Mark as read").
struct SwipeStep: Equatable {
    let words: String
    let icon: Icon
    let input: ActionInput?
    var spoken: String

    init(words: String, icon: Icon, input: ActionInput?, spoken: String? = nil) {
        self.words = words
        self.icon = icon
        self.input = input
        self.spoken = spoken ?? words
    }
}

/// How a sideways drag on a Home row goes (`SwipeRow`), kept apart from the view so it is tested.
enum SwipeDrag {
    /// Which way's setting a drag reads: the finger moving left (`translation` below 0) reads `SwipeAction.leftKey`'s.
    enum Side: Equatable {
        case left, right
    }

    /// How far the row goes before letting go acts.
    static let threshold: CGFloat = 88
    /// How far the row follows the finger one for one; past it the row moves a third as far, and never past `limit`.
    static let free: CGFloat = 132
    static let limit: CGFloat = 200
    /// How far ahead the finger's speed carries a flick, in seconds, as iOS judges a flick by where it would end.
    static let projection: CGFloat = 0.15

    static func side(of translation: CGFloat) -> Side? {
        translation < 0 ? .left : translation > 0 ? .right : nil
    }

    /// Where the row is drawn for a finger `translation` away: one for one, then resisting, at most `limit`.
    static func offset(for translation: CGFloat) -> CGFloat {
        let distance = abs(translation)
        let resisted = distance <= free ? distance : min(limit, free + (distance - free) / 3)
        return translation < 0 ? -resisted : resisted
    }

    /// Whether letting go acts: the drag, carried on by the finger's speed (`projection`), reaches `threshold` the
    /// same way it went, so a fast short flick counts as a long drag does.
    static func commits(translation: CGFloat, velocity: CGFloat) -> Bool {
        guard let side = side(of: translation) else { return false }
        let projected = translation + velocity * projection
        return self.side(of: projected) == side && abs(projected) >= threshold
    }
}
