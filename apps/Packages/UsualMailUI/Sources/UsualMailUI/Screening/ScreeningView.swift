import SwiftUI
import UsualMailKit

/// Screening (Figma frame "MacBook Pro 14" - 8"): how many new items wait, then one row per sender: who, when, what
/// it is about, and on the right let in and block. A sender with more mail shows the newest, with a chevron that
/// opens the rest beneath it.
struct ScreeningView: View {
    let inboxId: String?
    let act: (ActionInput, String) -> Void
    /// Opens a mail in the card, with Screening as the way back.
    let open: (String) -> Void
    @Environment(MailStore.self) private var store
    @State private var unfolded: Set<String> = []

    var body: some View {
        let list = ScreeningList(store.lists, inbox: inboxId)
        let count = store.counts?.counts(for: inboxId)?.screened ?? list.groups.reduce(0) { $0 + $1.threads.count }
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text(ScreeningList.title(count: count))
                    .font(Theme.sans(12, weight: .semibold))
                    .foregroundStyle(Theme.listTitle)
                    .frame(maxWidth: .infinity)
                    .contentTransition(.numericText())
                    .revealOnAppear()
                ForEach(Array(list.groups.enumerated()), id: \.element.id) { index, group in
                    VStack(alignment: .leading, spacing: 16) {
                        ScreeningRow(
                            thread: group.latest, inbox: store.lists.inbox(id: group.latest.inboxId),
                            read: { open(group.latest.id) },
                            more: group.older.isEmpty ? nil : unfolded.contains(group.id),
                            toggle: { withAnimation(Motion.move) { unfolded.formSymmetricDifference([group.id]) } },
                            letIn: { act(.allowSender, group.latest.id) },
                            block: { act(.blockSender, group.latest.id) })
                        if unfolded.contains(group.id) {
                            ForEach(group.older) { thread in
                                ScreeningRow(
                                    thread: thread, inbox: store.lists.inbox(id: thread.inboxId),
                                    read: { open(thread.id) }
                                )
                                .padding(.leading, 22)
                                .transition(.blurReveal)
                            }
                        }
                    }
                    .revealOnAppear(delay: Motion.delay(at: index + 1))
                    .transition(.blurReveal)
                }
                if list.groups.isEmpty && store.hasLoadedFromDisk {
                    Text("Nobody is waiting to be let in.")
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.sectionTitle)
                        .frame(maxWidth: .infinity)
                        .revealOnAppear()
                }
            }
            .padding(Theme.page)
            .animation(Motion.move, value: list.groups.map(\.id))
        }
        .scrollIndicators(.never)
        // Where it was, coming back to the mail stack or from a mail (`ScrollPlaces`).
        .keepsScroll()
    }
}

/// One screened mail: initials, "Name (address)" and when, then what it is about. The sender's newest row also has
/// the chevron (when there is more from them), let in and block.
private struct ScreeningRow: View {
    let thread: MailThread
    let inbox: Inbox?
    /// Opens the mail.
    let read: () -> Void
    /// Nil without older mail; otherwise whether it is open.
    var more: Bool? = nil
    var toggle: () -> Void = {}
    var letIn: (() -> Void)? = nil
    var block: (() -> Void)? = nil

    var body: some View {
        let sender = HomeWords.sender(of: thread, inbox: inbox)
        HStack(alignment: .center, spacing: 10) {
            Button(action: read) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Avatar(name: sender?.displayName ?? thread.subject, key: Avatar.key(for: sender, in: thread))
                        Text(verbatim: sender.map(ScreeningList.who) ?? thread.subject)
                            .font(Theme.sans(12))
                            .foregroundStyle(Theme.ink)
                            .lineLimit(1)
                        TimelineView(.everyMinute) { context in
                            Text(HomeWords.ago(thread.lastMessageAt, now: context.date))
                                .font(Theme.sans(12))
                                .foregroundStyle(Theme.quietTime)
                        }
                    }
                    Text(verbatim: ScreeningList.about(thread))
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.secondary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
                .rowHover()
            }
            .buttonStyle(PlainControlStyle())
            .help("Read it")
            if let more {
                iconButton(.expand, more ? "Show less from this sender" : "Show more from this sender", action: toggle)
                    .rotationEffect(.degrees(more ? 180 : 0))
            }
            if let letIn { iconButton(.letIn, "Let in", action: letIn) }
            if let block { iconButton(.block, "Block", action: block) }
        }
        .accessibilityElement(children: .contain)
    }

    private func iconButton(_ icon: Icon, _ help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            RowIcon(icon: icon)
        }
        .buttonStyle(PlainControlStyle())
        .help(help)
        .accessibilityLabel(help)
    }
}

/// A row's icon button (more from this sender, let in, block): on the Mac a 16-point icon, grey at rest, under the
/// pointer drawn in the icons' colour on a soft 28-point circle. On the iPhone larger, for a finger (the owner's words
/// of 2026-11-25: "the reject and accept buttons should be bigger for each row"): a 20-point icon in the icons' colour
/// on a 40-point circle, always shown, as nothing hovers there.
private struct RowIcon: View {
    let icon: Icon
    @Environment(\.isControlHovered) private var hovered

    #if os(iOS)
        private static let side: CGFloat = 40
        private static let glyph: CGFloat = 20
        private static let circle: CGFloat = 40
    #else
        private static let side: CGFloat = 22
        private static let glyph: CGFloat = 16
        private static let circle: CGFloat = 28
    #endif

    var body: some View {
        let shown = hovered || !Pointer.exists
        icon.view(size: Self.glyph, tint: shown ? Theme.icon : nil)
            .frame(width: Self.side, height: Self.side)
            .background {
                Circle()
                    .fill(Color.black.opacity(shown ? 0.06 : 0))
                    .frame(width: Self.circle, height: Self.circle)
            }
            .contentShape(Rectangle())
    }
}
