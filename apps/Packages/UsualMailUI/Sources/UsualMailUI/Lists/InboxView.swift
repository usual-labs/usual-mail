import SwiftUI
import UsualMailDesign
import UsualMailKit

/// The classic inbox (owner's request of 2026-11-19: "a mirror of what they see in their gmail account"): every mail
/// of every inbox, as it is a stack of its own that no profile scopes (`Navigation.activeProfile`), on one compact
/// line each, newest first (`AllMailList`), in the wide card. Plain mail: no
/// summaries, no money or event words, no sections. Clicking a row opens the mail page; a right click shows the row's
/// menu for that thread; a row dragged onto the rail's To reply, Pinned or Snoozed moves there.
///
/// It stays cheap with thousands of rows: a change of the copy only filters and sorts the threads once; the rows are
/// lazy, so only those on screen are made, each working out its own words (`AllMailRow`) when drawn; and each row is
/// `Equatable` on its thread, inbox and day, so a change redraws only the rows it touches.
struct InboxView: View {
    /// The active profile's inbox: nil, every inbox, as no profile is active outside the mail stack.
    let inboxId: String?
    /// The thread at the top of the list, kept by the window while the app runs (`ScrollPlaces`), so coming back to the
    /// page or from a mail finds the list where it was.
    @Binding var top: String?
    let open: (String) -> Void
    @Environment(MailStore.self) private var store

    var body: some View {
        // Read again each minute, so a date moves from the time to the day at midnight while the window is open. The
        // day is the store's (the Mac's clock, or the sample's moment in the sample mode) where the person is.
        TimelineView(.everyMinute) { _ in
            InboxList(inboxId: inboxId, dates: MailDate(now: store.now), top: $top, open: open)
                .equatable()
        }
    }
}

/// The rows on one day. Its body runs again when the copy changes (it reads `store.lists`), or the profile or the day
/// does, not every minute.
private struct InboxList: View, Equatable {
    let inboxId: String?
    let dates: MailDate
    @Binding var top: String?
    let open: (String) -> Void
    @Environment(MailStore.self) private var store

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.inboxId == rhs.inboxId && lhs.dates == rhs.dates
    }

    var body: some View {
        // At the store's now: a snoozed thread comes back when the store re-reads the copy at its time, which runs this
        // again.
        let list = AllMailList(store.lists, inbox: inboxId, now: store.now)
        let inboxes = store.lists.inboxes
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(list.threads) { thread in
                    InboxRow(
                        thread: thread, inbox: inboxes.first { $0.id == thread.inboxId }, dates: dates, open: open
                    )
                    .equatable()
                }
            }
            .scrollTargetLayout()
            .padding(.horizontal, Theme.pageInset)
            .padding(.vertical, 16)
            if list.threads.isEmpty && store.hasLoadedFromDisk {
                Text("No mail.")
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.sectionTitle)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
            }
        }
        .scrollPosition(id: $top, anchor: .top)
        .scrollIndicators(.never)
        .revealOnAppear()
    }
}

/// One mail on a line, 32 points tall, Gmail's way: the avatar, the sender in a column of its own with the message
/// count, a quiet word for where Usual Mail filed it, the subject and the mail's opening words, an attachment mark,
/// and the date; on the iPhone the same parts on two lines (`MailLine`). Unread the classic way (`AllMailRow.strong`).
private struct InboxRow: View, Equatable {
    let thread: MailThread
    let inbox: Inbox?
    let dates: MailDate
    let open: (String) -> Void
    @Environment(MailStore.self) private var store

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.thread == rhs.thread && lhs.inbox == rhs.inbox && lhs.dates == rhs.dates
    }

    var body: some View {
        let row = AllMailRow(thread, inbox: inbox, dates: dates)
        let weight: UsualFontWeight = row.strong ? .semibold : .regular
        Button {
            open(thread.id)
        } label: {
            MailLine {
                Avatar(name: row.avatarName, key: row.avatarKey, avatar: row.avatar)
            } sender: {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(verbatim: row.sender)
                        .font(Theme.sans(12, weight: weight))
                        .foregroundStyle(row.strong ? Theme.ink : Theme.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let count = row.count {
                        Text(verbatim: count)
                            .font(Theme.sans(10))
                            .foregroundStyle(Theme.time)
                            .fixedSize()
                    }
                }
            } label: {
                if let label = row.label {
                    Text(verbatim: label)
                        .font(Theme.sans(10))
                        .foregroundStyle(Theme.time)
                        .fixedSize()
                        .padding(.trailing, 8)
                }
            } subject: {
                Text(Self.subjectLine(row, weight: weight))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } trailing: {
                if row.hasAttachments {
                    Icon.attachment.view(size: 13, tint: Theme.secondary)
                        .padding(.leading, 12)
                }
                Text(verbatim: row.date)
                    .font(Theme.sans(10, weight: row.strong ? .medium : .regular))
                    .foregroundStyle(row.strong ? Theme.ink : Theme.time)
                    .fixedSize()
                    .frame(minWidth: 52, alignment: .trailing)
                    .padding(.leading, 12)
            }
            // 8 above and below: the highlight, reaching 8 past the row, meets the next one's and doesn't cover it.
            .rowHover()
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(PlainControlStyle())
        .rowMenu(for: thread) {
            open(thread.id)
        } act: { action in
            Task { await store.perform(action, on: [thread.id]) }
        }
        .mailDraggable([thread.id], name: row.sender, subject: row.subject)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Self.accessibilityText(row))
    }

    /// The subject in ink, then " — " and the opening words in the secondary tone, as one run that is cut at its end.
    /// Mail's own words, shown as plain text.
    private static func subjectLine(_ row: AllMailRow, weight: UsualFontWeight) -> AttributedString {
        var subject = AttributedString(row.subject)
        subject.font = Theme.sans(12, weight: weight)
        subject.foregroundColor = Theme.ink
        guard !row.opening.isEmpty else { return subject }
        var opening = AttributedString(" — \(row.opening)")
        opening.font = Theme.sans(12)
        opening.foregroundColor = Theme.secondary
        return subject + opening
    }

    private static func accessibilityText(_ row: AllMailRow) -> String {
        var parts: [String] = []
        if row.strong { parts.append("Unread") }
        parts.append(row.count.map { "\(row.sender), \($0) messages" } ?? row.sender)
        if let label = row.label { parts.append(label) }
        parts.append(row.subject)
        if !row.opening.isEmpty { parts.append(row.opening) }
        if row.hasAttachments { parts.append("Attachment") }
        parts.append(row.date)
        return parts.joined(separator: ". ")
    }
}
