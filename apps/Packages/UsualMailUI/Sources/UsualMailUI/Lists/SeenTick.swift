import SwiftUI
import UsualMailKit

/// Whether a Notifications row has been seen, and what its tick does (owner's words of 2026-11-20: "an icon on the list
/// item which when user clicks on it, it would kinda flag that notification as seen and make it less visible"). Seen is
/// the read state of the threads the row stands for, nothing new on the server (the coordinator's decision of
/// 2026-11-20): a row is seen once every one of them is read, so opening a notification makes it seen too, and the
/// row's menu ("Mark as read" while unseen, "Mark as unread" once seen) always agrees with it. A click marks the unread
/// ones read, or on a seen row every one unread again, silently as opening a mail does: no undo strip, no teach
/// question. The row stays where it is: the sections never look at the read state (`NotificationSections`).
struct SeenState: Equatable {
    /// Every thread the row stands for: a group's, newest first, or its own.
    let threadIDs: [String]
    /// Those of them still unread.
    let unreadIDs: [String]

    init(_ threads: [MailThread]) {
        threadIDs = threads.map(\.id)
        unreadIDs = threads.filter(\.unread).map(\.id)
    }

    /// What a click marks.
    enum Mark: Equatable {
        /// These threads read: the row's unread ones.
        case read([String])
        /// These threads unread: every one of the row's.
        case unread([String])

        /// Marks the threads silently (`MailStore.markRead(opening:)`, `markUnread(_:)`): shown at once, not offered
        /// to undo, taken back quietly when the server can't be reached.
        @MainActor
        func apply(to store: MailStore) async {
            switch self {
            case .read(let ids): await store.markRead(opening: ids)
            case .unread(let ids): await store.markUnread(ids)
            }
        }
    }

    /// Seen once none of its threads is unread.
    var isSeen: Bool { unreadIDs.isEmpty }

    var click: Mark { isSeen ? .unread(threadIDs) : .read(unreadIDs) }

    /// An empty ring until seen, then the ring ticked.
    var icon: Icon { isSeen ? .seen : .unseen }

    /// What a click does: the tooltip, and the button's accessibility label.
    var words: String { isSeen ? "Mark as unseen" : "Mark as seen" }

    /// How the row is drawn: dimmed once seen, so the unseen rows stand out.
    var look: RowLook { isSeen ? .seen : .normal }

    /// The tick shows on an unseen row always, on a seen one only while the pointer is over the row.
    func showsTick(hovered: Bool) -> Bool { !isSeen || hovered }
}

/// How a row's words and avatar are drawn: as usual, or dimmed on a seen Notifications row, readable but plainly
/// secondary, in the app's own greys, so a seen row reads like the time beside it.
struct RowLook: Equatable {
    /// The title: ink as usual; seen, the time's grey (#A1A1A1).
    let title: Color
    /// The line under it: black at 50% as usual; seen, the time's grey too.
    let subtitle: Color
    /// The avatar's opacity: whole as usual; seen, half.
    let avatar: Double
    /// A group's "N updates": the time's grey as usual; seen, a little lighter (#AEAEB2).
    let count: Color

    static let normal = RowLook(title: Theme.ink, subtitle: Theme.secondary, avatar: 1, count: Theme.time)
    static let seen = RowLook(title: Theme.time, subtitle: Theme.time, avatar: 0.5, count: Theme.quietTime)
}

/// A Notifications row's seen tick: its own small button at the row's right end, vertically centred, beside the row's
/// main button rather than inside it, so a click never opens the mail. A 16-point ring in the time's grey, darker under
/// the pointer, with the pointing hand and a tooltip to its left; always shown on an unseen row, on a seen one only
/// while the pointer is over the row. The row keeps its room (`room`) and draws it over that room (`HomeItem`).
struct SeenTick: View {
    let state: SeenState
    /// Whether the pointer is over the row, which the row says (`hovered(_:)`).
    var rowHovered = false
    @State private var hovering = false
    @Environment(MailStore.self) private var store

    /// The tick's square, and its ring: on the Mac a 16-point ring in a target a little larger; on the iPhone, for a
    /// finger, a 24-point ring in a 36-point target (the owner's words of 2026-11-25: "the check mark control should be
    /// bigger").
    #if os(iOS)
        static let side: CGFloat = 36
        static let ring: CGFloat = 24
    #else
        static let side: CGFloat = 24
        static let ring: CGFloat = 16
    #endif

    var body: some View {
        Button {
            Task { await state.click.apply(to: store) }
        } label: {
            SeenTickLabel(icon: state.icon)
        }
        .buttonStyle(PlainControlStyle())
        .onHover { hovering = $0 }
        // Under the pointer it stays, even where the row stops counting the pointer as its own.
        .reveal(state.showsTick(hovered: rowHovered || hovering || !Pointer.exists))
        // To its left, inside the row, where nothing cuts it off: under it, at the card's right edge, the card would.
        .tooltip(state.words, edge: .leading)
        .accessibilityLabel(state.words)
    }

    /// The tick as the row draws it, `hovered` saying whether the pointer is over the row.
    func hovered(_ hovered: Bool) -> SeenTick {
        var tick = self
        tick.rowHovered = hovered
        return tick
    }

    /// The room the tick takes at the row's right end, kept free so the row's words never run under it.
    static var room: some View {
        Color.clear.frame(width: side, height: side).accessibilityHidden(true)
    }
}

/// The ring in the time's grey, darker under the pointer; it blurs into the other ring when the row turns.
private struct SeenTickLabel: View {
    let icon: Icon
    @Environment(\.isControlHovered) private var hovered

    var body: some View {
        ZStack {
            icon.view(size: SeenTick.ring, tint: hovered ? Theme.secondary : Theme.time)
                .id(icon)
                .transition(.blurReveal)
        }
        .frame(width: SeenTick.side, height: SeenTick.side)
        .contentShape(Circle())
        .animation(Motion.reveal, value: icon)
    }
}
