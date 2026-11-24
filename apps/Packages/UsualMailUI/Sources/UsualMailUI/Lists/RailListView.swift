import SwiftUI
import UsualMailKit

/// To reply, Pinned or Snoozed (the rail's lists, owner's words of 2026-11-20: "when I set something manually to
/// snooze, reply or pin, it should appear in those lists"): the list from the copy (`RailList`) in every inbox, as each
/// is a stack of its own that no profile scopes (`Navigation.activeProfile`), with Home's row and Home's look. A
/// receipt or an invoice says its money words, a notification with an event its event; Snoozed says when each comes
/// back where the hover time sits, always shown. Clicking a row opens the mail page; its right-click menu and the mail
/// page's buttons take it off again. Empty, it says so quietly.
struct RailListView: View {
    /// One of `Rail.lists`.
    let place: Place
    /// The active profile's inbox: nil, every inbox, as no profile is active outside the mail stack.
    let inboxId: String?
    let open: (String) -> Void
    @Environment(MailStore.self) private var store

    var body: some View {
        // Read again each minute, so "today" and "tomorrow" move on at midnight while the window is open. The moment
        // is the store's (the Mac's clock, or the sample's in the sample mode), where the person is.
        TimelineView(.everyMinute) { _ in
            rows(now: store.now, timeZone: .current, twelveHour: EventWords.usesTwelveHours(.current))
        }
    }

    private func rows(now: Date, timeZone: TimeZone, twelveHour: Bool) -> some View {
        let list = RailList(store.lists, place: place, inbox: inboxId)
        let today = CalendarDay(now, in: timeZone)
        return ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ForEach(Array(list.threads.enumerated()), id: \.element.id) { index, thread in
                    let inbox = store.lists.inbox(id: thread.inboxId)
                    HomeItem(
                        thread: thread, inbox: inbox,
                        words: RailList.words(
                            for: thread, inbox: inbox, today: today, twelveHour: twelveHour, timeZone: timeZone),
                        when: list.when(for: thread, now: now, timeZone: timeZone, twelveHour: twelveHour)
                    ) { open(thread.id) }
                    .revealOnAppear(delay: Motion.delay(at: index))
                    .transition(.blurReveal)
                }
                if list.threads.isEmpty && store.hasLoadedFromDisk {
                    Text(verbatim: list.emptyWords)
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.sectionTitle)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                        .revealOnAppear()
                }
                if let note = AIWords.note(status: store.aiStatus, threads: list.threads) {
                    Text(verbatim: note)
                        .font(Theme.sans(10))
                        .foregroundStyle(Theme.time)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                        .revealOnAppear(delay: Motion.longestWait)
                }
            }
            .padding(Theme.page)
            .animation(Motion.move, value: list.threads.map(\.id))
        }
        .scrollIndicators(.never)
        // Where it was, coming back to this stack or from a mail (`ScrollPlaces`).
        .keepsScroll()
    }
}
