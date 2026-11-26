import Foundation
import UsualMailKit

/// What the capsules on the right do while a mail is open.
enum BarAction: CaseIterable, Hashable, Sendable {
    case replyLater, pin, snooze, archive, more, letIn, block

    /// A mail opened from a tab or one of the pages that hide the tabs.
    static let mailActions: [BarAction] = [.replyLater, .pin, .snooze, .archive, .more]
    /// A mail opened from Screening, from someone not yet let in.
    static let screeningActions: [BarAction] = [.letIn, .block, .more]

    var icon: Icon {
        switch self {
        case .replyLater: .toReply
        case .pin: .pinned
        case .snooze: .snoozed
        case .archive: .archive
        case .more: .more
        case .letIn: .letIn
        case .block: .block
        }
    }

    var title: String {
        switch self {
        case .replyLater: "Reply later"
        case .pin: "Pin"
        case .snooze: "Snooze"
        case .archive: "Archive"
        case .more: "More"
        case .letIn: "Let in"
        case .block: "Block"
        }
    }

    /// Its words in a menu about the sender: "Let in", "Block sender".
    var senderTitle: String {
        self == .block ? "Block sender" : title
    }

    /// The action itself; snooze and more open a menu first.
    var input: ActionInput? {
        switch self {
        case .replyLater: .stack(.replyLater)
        case .pin: .stack(.setAside)
        case .archive: .done
        case .letIn: .allowSender
        case .block: .blockSender
        case .snooze, .more: nil
        }
    }

    /// The button for `mail` at `now`. Reply later, pin and snooze, when the mail is already on that stack or snoozed,
    /// offer the way back instead of adding again: "Remove from To reply", "Unpin" (`unstack`) or "Unsnooze"
    /// (`cancel_come_back`, at once, with no menu), drawn chosen. Pinning a mail that waits to be replied to moves it
    /// to Pinned, as the contract's stacks are one at a time. Archive, for a mail already done (only search finds
    /// one), offers "Move to Inbox" (`not_done`), drawn chosen.
    func button(for mail: MailThread, now: Date) -> BarButton {
        switch self {
        case .replyLater where mail.stack == .replyLater:
            BarButton(title: "Remove from To reply", input: .unstack, chosen: true)
        case .pin where mail.stack == .setAside:
            BarButton(title: "Unpin", input: .unstack, chosen: true)
        case .snooze where mail.isWaiting(at: now):
            BarButton(title: "Unsnooze", input: .cancelComeBack, chosen: true)
        case .archive where mail.done:
            BarButton(title: "Move to Inbox", input: .notDone, chosen: true)
        default:
            BarButton(title: title, input: input, chosen: false)
        }
    }
}

/// One action's button on the mail page: its tooltip, what it does (nil: it opens its menu, as snooze and more do),
/// and whether it is drawn chosen, lit as a chosen tab is (`GlassControl.lit`), because the mail is already there.
struct BarButton: Equatable {
    let title: String
    let input: ActionInput?
    let chosen: Bool
}
