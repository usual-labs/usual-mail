import Foundation
import UsualMailKit

/// What swiping a row does, each way, on the iPhone (the owner's words of 2026-11-25: "swiping on right and left on
/// each mail should do an action. bu default swipe to left should mark it as seen, on swipe right should snooze it.
/// these settings should be changable in settings"; and of 2026-11-27, for Notifications and the Feed, where a swipe
/// unsubscribes). Left is the finger moving left, the row sliding off to the left; right the other way. Each list has
/// its own two settings on this device (`SwipeList`; Settings' Appearance tab), as the background is: the server keeps
/// none.
enum SwipeAction: String, CaseIterable, Identifiable, Sendable {
    case seen, snooze, replyLater, pin, archive, unsubscribe, block, nothing

    var id: Self { self }

    /// Its name in Settings.
    var title: String {
        switch self {
        case .seen: "Seen or unseen"
        case .snooze: "Snooze"
        case .replyLater: "Reply later"
        case .pin: "Pin"
        case .archive: "Archive"
        case .unsubscribe: "Unsubscribe"
        case .block: "Block sender"
        case .nothing: "Nothing"
        }
    }

    /// What it does to a row's `threads` at `now`: one thread, or a notification group's, newest first (never empty),
    /// as the row's menu and the mail page's buttons do it (`RowMenu`, `BarAction.button`). Seen marks the unread ones
    /// read, or when none is, every one unread again, as Home's New and Seen and a notification's tick are; reply later,
    /// pin and archive offer the way back for a mail already there, as the newest shows it, and act on all; snooze asks
    /// when first, or unsnoozes a mail that waits; block asks first (`SwipeStep.asks`), then blocks the newest's
    /// sender, which blocks every thread of theirs; unsubscribe asks first too, then blocks them the same way and asks
    /// the server to have them stop (`MailStore.unsubscribe(threadID:)`). Nil for nothing, and for block and unsubscribe
    /// where there is no sender.
    func step(for threads: [MailThread], now: Date) -> SwipeStep? {
        guard let shown = threads.first else { return nil }
        let all = threads.map(\.id)
        switch self {
        case .seen:
            let unread = threads.filter(\.unread).map(\.id)
            return unread.isEmpty
                ? SwipeStep(words: "Unseen", icon: .unseen, input: .unread, targets: all, spoken: "Mark as unread")
                : SwipeStep(words: "Seen", icon: .seen, input: .read, targets: unread, spoken: "Mark as read")
        case .snooze:
            let button = BarAction.snooze.button(for: shown, now: now)
            return SwipeStep(words: button.title, icon: .snoozed, input: button.input, targets: all)
        case .replyLater, .pin, .archive:
            let action: BarAction = self == .replyLater ? .replyLater : self == .pin ? .pin : .archive
            let button = action.button(for: shown, now: now)
            return SwipeStep(words: button.title, icon: action.icon, input: button.input, targets: all)
        case .unsubscribe:
            // Its block is the row menu's Block sender; the request to stop goes with it.
            guard shown.sender != nil else { return nil }
            return SwipeStep(
                words: "Unsubscribe", icon: .blocked, input: .blockSender, targets: [shown.id], asks: .unsubscribe)
        case .block:
            // A thread of only the mailbox's own mail has no sender to block, as the row's menu offers none.
            guard shown.sender != nil else { return nil }
            return SwipeStep(
                words: "Block", icon: .block, input: .blockSender, targets: [shown.id], spoken: "Block sender",
                asks: .block)
        case .nothing:
            return nil
        }
    }

    func step(for thread: MailThread, now: Date) -> SwipeStep? {
        step(for: [thread], now: now)
    }
}

/// The lists whose rows swipe, each with its own two settings and defaults: Home (left seen, right snooze; the owner's
/// words of 2026-11-25), Notifications (left seen, right archive: the owner's words of 2026-11-27, "on one of them do
/// the archive ... the other I don't know, choose something yourself", seen as Home's left and as the row's tick) and
/// the Feed (left unsubscribe, right archive: the owner's words of 2026-11-27, swiping a post "should unsubscribe from
/// it, so I won't ever get that any feed from those or email from those"; it blocks the sender too, every mail of
/// theirs archived, now and later). Each list offers every action. Home's keys are the ones it had before the others
/// came.
enum SwipeList: String, CaseIterable, Identifiable, Sendable {
    case home, notifications, feed

    var id: Self { self }

    var leftKey: String { self == .home ? "UsualMailSwipeLeft" : "UsualMailSwipe\(keyName)Left" }
    var rightKey: String { self == .home ? "UsualMailSwipeRight" : "UsualMailSwipe\(keyName)Right" }

    private var keyName: String { self == .notifications ? "Notifications" : "Feed" }

    var leftDefault: SwipeAction {
        switch self {
        case .home, .notifications: .seen
        case .feed: .unsubscribe
        }
    }

    var rightDefault: SwipeAction {
        switch self {
        case .home: .snooze
        case .notifications, .feed: .archive
        }
    }

    /// Its section's title in Settings.
    var title: String {
        switch self {
        case .home: "Swiping on Home"
        case .notifications: "Swiping on Notifications"
        case .feed: "Swiping on Feed"
        }
    }

    /// Under its section in Settings.
    var footer: String {
        switch self {
        case .home: "What a swipe on a mail on Home does."
        case .notifications:
            "What a swipe on a notification does. On a row of several updates, it does it to all of them."
        case .feed:
            "What a swipe on a post does. Unsubscribing and blocking ask first; both archive the sender's mail, now and "
                + "later, and unsubscribing also asks them to stop sending."
        }
    }
}

/// One swipe on a row: what shows behind the row as it moves, and what letting go past the threshold does to which
/// threads (`targets`). No input is snooze's: its times to choose from first (`SnoozeChoice.input`). `asks` is the
/// question before doing it (block, unsubscribe). `spoken` is its name as a VoiceOver action, the row menu's ("Mark as
/// read").
struct SwipeStep: Equatable {
    let words: String
    let icon: Icon
    let input: ActionInput?
    let targets: [String]
    var spoken: String
    var asks: SwipeQuestion?

    init(
        words: String, icon: Icon, input: ActionInput?, targets: [String], spoken: String? = nil,
        asks: SwipeQuestion? = nil
    ) {
        self.words = words
        self.icon = icon
        self.input = input
        self.targets = targets
        self.spoken = spoken ?? words
        self.asks = asks
    }

    /// Whether letting go asks first.
    var confirms: Bool { asks != nil }
}

/// What a swipe asks before it is done, in the system's dialog (`SwipeRow`): its title names the sender the row names
/// ("Block Kestrel Roasters?", "Unsubscribe from Kestrel Roasters?"), its words say what follows, its red button does it.
enum SwipeQuestion: Equatable, Sendable {
    /// Blocking the sender: the row menu's Block sender.
    case block
    /// Unsubscribing from the sender: blocking them, and asking the server to have them stop
    /// (`MailStore.unsubscribe(threadID:)`).
    case unsubscribe

    /// "Block Kestrel Roasters?"; without a name, "Block this sender?".
    func title(_ name: String?) -> String {
        switch self {
        case .block: name.map { "Block \($0)?" } ?? "Block this sender?"
        case .unsubscribe: name.map { "Unsubscribe from \($0)?" } ?? "Unsubscribe from this sender?"
        }
    }

    /// What follows, under the title.
    var words: String {
        switch self {
        case .block:
            "Their mail is archived, this and every later one. You can unblock them in Settings, under Blocked."
        case .unsubscribe:
            // Every effect named (the security review of 2026-11-27): an email may go from this inbox's address, and
            // Browser Use may open their page; Undo takes back the block alone.
            "Their mail is archived, this and every later one, and Usual Mail asks them to stop: with their one-click "
                + "link, an email sent from this inbox's address, or, when you've set a Browser Use key, Browser Use "
                + "opening their page. Undo only unblocks them; the request still goes."
        }
    }

    /// The red button's name.
    var button: String {
        switch self {
        case .block: "Block sender"
        case .unsubscribe: "Unsubscribe"
        }
    }
}

/// How a sideways drag on a row goes (`SwipeRow`), kept apart from the view so it is tested.
enum SwipeDrag {
    /// Which way's setting a drag reads: the finger moving left (`translation` below 0) reads `SwipeList.leftKey`'s.
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
