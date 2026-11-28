import SwiftUI
import UsualMailKit

/// The Notifications tab (owner's request of 2026-11-19, "Yes, build both"): its notifications in Today, Coming up and
/// Earlier (`NotificationSections`), each row Home's row leading with the event and when it matters ("Out for
/// delivery · today, 3:15–6:15 pm") over the sender and what it is about (`EventWords`); a notification without an
/// event status keeps Home's words. The section titles are Home's; an empty section isn't shown. Clicking a row opens
/// the mail page.
///
/// One row per parcel or appointment (owner's "Yes, build it" of 2026-11-19; docs/contract.md, "Notification groups"):
/// a group's row shows its newest mail, says how many threads it stands for ("3 updates", a button that shows the
/// older ones under it, indented, and hides them again), counts as unread when any of them is, and its right-click
/// menu acts on all of them. Opening it opens the newest and marks every thread in the group read; opening an older
/// one opens and marks only that one.
///
/// Each row has a seen tick at its right end (owner's words of 2026-11-20; `SeenTick`): seen is the read state, a group
/// seen once all its threads are read; a click marks the row seen or unseen silently without opening it, and a seen
/// row is dimmed in its place.
///
/// On the iPhone a row swiped either way does what Settings says (`SwipeList.notifications`: by default left marks it
/// seen, right archives it, which takes it off the tab and archives the mail; the owner's words of 2026-11-27), to
/// every thread the row stands for; an older row shown under its group, to its own.
struct NotificationsView: View {
    /// The inbox the profile switch picked, or nil for every inbox.
    let inboxId: String?
    /// Which groups show their older rows, kept by the window for the session.
    @Binding var expanded: ExpandedGroups
    let open: (String) -> Void
    @Environment(MailStore.self) private var store

    var body: some View {
        // Read again each minute, so the sections and "today" or "tomorrow" move on at midnight while the window is
        // open. The day is the store's (the Mac's clock, or the sample's moment in the sample mode) where the person
        // is.
        TimelineView(.everyMinute) { _ in
            NotificationList(
                inboxId: inboxId, today: CalendarDay(store.now, in: .current), now: store.now,
                twelveHour: EventWords.usesTwelveHours(.current), expanded: $expanded, open: open)
        }
    }
}

/// The tab's sections on one day.
private struct NotificationList: View {
    let inboxId: String?
    let today: CalendarDay
    /// What is snoozed is left out until it comes back (`NotificationSections`).
    let now: Date
    let twelveHour: Bool
    @Binding var expanded: ExpandedGroups
    let open: (String) -> Void
    @Environment(MailStore.self) private var store

    var body: some View {
        let sections = NotificationSections(store.lists, inbox: inboxId, today: today, now: now)
        let rows = sections.rows
        let items = TitledRows(sections.parts.map { (title: $0.title, rows: $0.rows) })
        ScrollView {
            // Lazy, so only the rows near the screen are built, on choosing the tab, each minute and on each change to
            // the copy (as Home's); one stack of titles and rows, so its kept place is a row (`keepsTopRow`).
            LazyVStack(alignment: .leading, spacing: 24) {
                // Each title and row comes into focus one place further into the list than the last, as Home's do.
                TitledRowsContent(rows: items) { row in rowView(row) }
                if sections.isEmpty && store.hasLoadedFromDisk {
                    Text(verbatim: CategoryList.emptyWords(for: .notifications))
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.sectionTitle)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                        .revealOnAppear()
                        .id(ListRowID.words("empty"))
                }
                if let note = AIWords.note(status: store.aiStatus, threads: sections.all) {
                    Text(verbatim: note)
                        .font(Theme.sans(10))
                        .foregroundStyle(Theme.time)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                        .revealOnAppear(delay: Motion.longestWait)
                        .id(ListRowID.words("note"))
                }
            }
            .scrollTargetLayout()
            .padding(Theme.page)
            .animation(Motion.move, value: sections.parts.map { $0.rows.map(\.threadIDs) })
        }
        .scrollIndicators(.never)
        .revealsFirstScreen(hasRows: !items.items.isEmpty)
        // Back at the row that was at the top, coming back to the mail stack or from a mail (`ScrollPlaces`).
        .keepsTopRow(items.ids)
        // A group whose threads changed shows collapsed, and stays so.
        .onChange(of: rows.map(\.threadIDs), initial: true) { expanded.forgetChanged(rows) }
    }

    /// A row, and under it, while its group is expanded, the group's older threads, newest first, indented as far as
    /// the title's words.
    private func rowView(_ row: NotificationRow) -> some View {
        let isExpanded = expanded.isExpanded(row)
        return VStack(alignment: .leading, spacing: 16) {
            item(
                row.shown, group: row.isGroup ? row.threads : nil,
                updates: row.count.map { count in
                    UpdatesCount(words: count, expanded: isExpanded, look: SeenState(row.threads).look) {
                        withAnimation(Motion.move) { expanded.toggle(row) }
                    }
                }
            ) { openRow(row) }
            // On the iPhone, a swipe either way does what Settings says (`SwipeList.notifications`), to every thread
            // the row stands for.
            .swipes(.notifications, row.threads)
            if isExpanded {
                ForEach(row.older) { thread in
                    item(thread) { open(thread.id) }
                        .swipes(.notifications, [thread])
                        .padding(.leading, Avatar.side + 6)
                        .transition(.blurReveal)
                }
            }
        }
    }

    private func item(
        _ thread: MailThread, group: [MailThread]? = nil, updates: UpdatesCount? = nil,
        open: @escaping () -> Void
    ) -> HomeItem {
        let inbox = store.lists.inbox(id: thread.inboxId)
        return HomeItem(
            thread: thread, inbox: inbox,
            words: EventWords(thread, inbox: inbox, today: today, twelveHour: twelveHour, timeZone: .current),
            group: group, updates: updates, seen: SeenTick(state: SeenState(group ?? [thread])), open: open)
    }

    /// Opens a row's mail. A group's row opens its newest and marks every unread thread in the group read, as one
    /// action (opening the newest then doesn't mark it again).
    private func openRow(_ row: NotificationRow) {
        let unread = row.readOnOpening
        if !unread.isEmpty { Task { await store.markRead(opening: unread) } }
        open(row.shown.id)
    }
}

/// A group's count ("3 updates") at the right end of the line under its row's title: its own small button, 10 points
/// in the time's colour (lighter on a seen row), which shows the group's older rows under it and hides them again.
struct UpdatesCount: View {
    let words: String
    let expanded: Bool
    /// The row's look, seen or not (`RowLook`).
    var look = RowLook.normal
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            UpdatesLabel(words: words, colour: look.count)
        }
        .buttonStyle(PlainControlStyle())
        .animation(Motion.reveal, value: look)
        .accessibilityLabel(words)
        .accessibilityHint(expanded ? "Hides the older updates." : "Shows the older updates.")
    }

    /// The room the count takes at the end of the line, kept free so the line's words never run under it.
    var room: some View {
        UpdatesLabel(words: words, colour: look.count).hidden().accessibilityHidden(true)
    }
}

/// The count's words: in `colour`, a little darker under the pointer.
private struct UpdatesLabel: View {
    let words: String
    let colour: Color
    @Environment(\.isControlHovered) private var hovered

    var body: some View {
        Text(verbatim: words)
            .font(Theme.sans(10))
            .foregroundStyle(hovered ? Theme.secondary : colour)
            .lineLimit(1)
            .fixedSize()
    }
}
