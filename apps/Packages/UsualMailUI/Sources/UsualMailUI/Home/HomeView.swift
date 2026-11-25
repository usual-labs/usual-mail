import SwiftUI
import UsualMailKit

/// Home: conversations and what nobody has sorted yet, New above Seen, each one or two quiet lines. Notifications have
/// their own tab (owner's decision of 2026-11-19). On the iPhone a row swiped either way does what Settings says
/// (`SwipeAction`: by default left marks it seen, right snoozes it).
struct HomeView: View {
    /// The inbox the profile switch picked, or nil for every inbox.
    let inboxId: String?
    let open: (String) -> Void
    @Environment(MailStore.self) private var store

    var body: some View {
        let list = HomeList(store.lists, inbox: inboxId)
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                if !list.new.isEmpty { section("New", list.new, from: 0) }
                if !list.seen.isEmpty { section("Seen", list.seen, from: list.new.count + 1) }
                if list.isEmpty && store.hasLoadedFromDisk {
                    Text("Nothing needs you.")
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.sectionTitle)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                        .revealOnAppear()
                }
                if let note = AIWords.note(status: store.aiStatus, threads: list.new + list.seen) {
                    Text(verbatim: note)
                        .font(Theme.sans(10))
                        .foregroundStyle(Theme.time)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .revealOnAppear(delay: Motion.longestWait)
                }
            }
            .padding(Theme.page)
            .animation(Motion.move, value: list.new.map(\.id) + list.seen.map(\.id))
        }
        .scrollIndicators(.never)
        // Where it was, coming back to the mail stack or from a mail (`ScrollPlaces`).
        .keepsScroll()
    }

    /// A section whose title and items come into focus one after another, `first` places into the list.
    private func section(_ title: String, _ threads: [MailThread], from first: Int) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            Text(title)
                .font(Theme.sans(12, weight: .semibold))
                .foregroundStyle(Theme.sectionTitle)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
                .revealOnAppear(delay: Motion.delay(at: first))
            ForEach(Array(threads.enumerated()), id: \.element.id) { index, thread in
                HomeItem(thread: thread, inbox: store.lists.inbox(id: thread.inboxId)) { open(thread.id) }
                    // On the iPhone, a swipe either way does what Settings says (`SwipeAction`).
                    .homeSwipes(thread)
                    .revealOnAppear(delay: Motion.delay(at: first + 1 + index))
                    .transition(.blurReveal)
            }
        }
    }
}

/// A row's own words, in place of the subject and Home's line under it: a receipt's or an invoice's money words on
/// Receipts (`PaymentWords`), a notification's event on Notifications (`EventWords`).
protocol RowWords {
    /// In the subject's place.
    var title: String { get }
    /// Under it, in two lines at most.
    var subtitle: String { get }
}

/// One conversation: the sender's avatar (their picture or initials, and the name beside it from the same address:
/// `HomeWords.shownSender`), the subject, and what it is about (the summary, else the opening words)
/// in two lines at most, cut with an ellipsis; the AI aims for one (owner's direction of 2026-11-18). The time shows
/// on hover. Receipts, Notifications, To reply, Pinned and Snoozed list their mail with it too, each with its own words
/// in place of the subject and that line when it has them (`RowWords`); Snoozed puts when the mail comes back in the
/// time's place, always shown. A right click shows its menu (`RowMenu`), whose choices are the person's own actions;
/// dragged onto the rail's To reply, Pinned or Snoozed, it moves there (`RailDrop`). On a notification group's row it
/// stands for every thread in the group: unread when any is, the menu and a drag acting on all of them, and the group's
/// count at the right end of the line under the title. Only on Notifications, a seen tick at its right end, and a seen
/// row dimmed (`SeenTick`).
struct HomeItem: View {
    let thread: MailThread
    let inbox: Inbox?
    /// A row's own words: on Receipts, a receipt's or an invoice's title ("To be paid: €1,240.00 to Kestrel Roasters")
    /// and its subtitle, without the sender's name, which the title holds; on Notifications, the event ("Out for
    /// delivery · today, 3:15–6:15 pm") over the sender and what it is about. Nil keeps Home's words.
    var words: (any RowWords)? = nil
    /// On a notification group's row, every thread of the group, `thread` (its newest) among them; nil for a row that
    /// stands for its own thread.
    var group: [MailThread]? = nil
    /// On a group's row, its "3 updates" button.
    var updates: UpdatesCount? = nil
    /// Words in the time's place, always shown: on Snoozed, when the mail comes back ("until Mon 09:00"). Nil shows
    /// the time on hover.
    var when: String? = nil
    /// On a Notifications row, its seen tick at the right end, which marks the row seen or unseen without opening it,
    /// and a seen row drawn dimmed (`RowLook`). Nil keeps today's look, as every other list does.
    var seen: SeenTick? = nil
    let open: () -> Void
    @Environment(MailStore.self) private var store
    @State private var hovering = false

    var body: some View {
        let sender = HomeWords.shownSender(of: thread, inbox: inbox)
        let look = seen?.state.look ?? .normal
        Button(action: open) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Group {
                            if let party = moneyParty(sender) {
                                // A money row naming another company than the sender draws that company's initials.
                                Avatar(name: party, key: party.lowercased(), avatar: nil)
                            } else {
                                Avatar(name: sender.name ?? thread.subject, key: sender.key, avatar: sender.avatar)
                            }
                        }
                        .opacity(look.avatar)
                        Text(verbatim: title)
                            .font(Theme.sans(12))
                            .foregroundStyle(look.title)
                            .lineLimit(1)
                        Spacer(minLength: 12)
                        if let when {
                            Text(verbatim: when)
                                .font(Theme.sans(10))
                                .foregroundStyle(Theme.time)
                                .lineLimit(1)
                                .fixedSize()
                        } else if showsTime {
                            TimelineView(.everyMinute) { context in
                                Text(HomeWords.ago(thread.lastMessageAt, now: context.date))
                                    .font(Theme.sans(10))
                                    .foregroundStyle(Theme.time)
                            }
                            .reveal(hovering || !Pointer.exists)
                        }
                    }
                    HStack(alignment: .lastTextBaseline, spacing: 12) {
                        Text(verbatim: line)
                            .font(Theme.sans(12))
                            .foregroundStyle(look.subtitle)
                            .lineLimit(2)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        // Room for the count, which is its own button over the row rather than inside it.
                        if let updates { updates.room }
                    }
                }
                // Room for the seen tick, its own button over the row as the count is.
                if seen != nil { SeenTick.room }
            }
            .contentShape(Rectangle())
            .rowHover()
            // A row ticked seen, or opened, dims in briefly; ticked back, it comes forward the same way.
            .animation(Motion.reveal, value: look)
        }
        .buttonStyle(PlainControlStyle())
        .onHover { hovering = $0 }
        .rowMenu(for: thread, unread: unread, now: store.now, open: open) { action in
            Task { await store.perform(action, on: (group ?? [thread]).map(\.id)) }
        }
        // Onto the rail's To reply, Pinned or Snoozed; a group's row carries the whole group, as its menu acts on it.
        .mailDraggable(
            (group ?? [thread]).map(\.id), name: sender.name ?? thread.sender ?? "", subject: thread.subject
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
        .accessibilityActions {
            // The seen tick shows only under the pointer once seen; its action is always on the row.
            if let seen {
                Button(seen.state.words) { Task { await seen.state.click.apply(to: store) } }
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if let updates { updates.padding(.trailing, seen == nil ? 0 : SeenTick.side + 8) }
        }
        .overlay(alignment: .trailing) { seen?.hovered(hovering) }
    }

    /// The row reads as unread when its thread is, or on a group's row, when any of the group's threads is.
    private var unread: Bool {
        group?.contains(where: \.unread) ?? thread.unread
    }

    private var title: String {
        words?.title ?? (thread.subject.isEmpty ? "(no subject)" : thread.subject)
    }

    /// Whether the time shows at the title's right (on the Mac under the pointer). On the iPhone a notification's row
    /// leaves it out, as its title already says when ("Out for delivery · today, 15:15–18:15"; the owner's words of
    /// 2026-11-25: "remove the duplicate date").
    private var showsTime: Bool {
        Pointer.exists || !(words is EventWords)
    }

    private var line: String {
        words?.subtitle ?? HomeWords.line(for: thread, inbox: inbox)
    }

    /// On a money row, the party its title names when that isn't the sender's own organisation (`PartyMatch`); nil
    /// when the row shows its sender as usual.
    private func moneyParty(_ sender: ShownSender) -> String? {
        guard words is PaymentWords, let party = thread.payment?.party.map(HomeWords.oneLine), !party.isEmpty else {
            return nil
        }
        return PartyMatch.isSender(party: party, sender: sender.address) ? nil : party
    }

    private var accessibilityText: String {
        let state = unread ? "New. " : ""
        let comesBack = when.map { ". \($0.prefix(1).uppercased())\($0.dropFirst())" } ?? ""
        return "\(state)\(words?.title ?? thread.subject). \(line)\(comesBack)"
    }
}
