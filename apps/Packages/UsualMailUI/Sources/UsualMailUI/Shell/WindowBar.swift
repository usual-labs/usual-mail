import SwiftUI
import UsualMailKit

/// The window's row of capsules, above the card on the Mac and at its foot on the iPhone (`compact`). Outside the mail
/// stack, and on search over it, the tabs and the screening capsule blur out as the person left them
/// (`Navigation.mailPlace`), and the stack's own row blurs in over them (`TopBar`): To reply's, Pinned's, Snoozed's or
/// the Inbox page's title, Settings' tabs, or search's capsule back to the stack; with a mail open, back to the list
/// with the mail's actions. The hidden row is disabled, so its buttons and Esc do nothing. On the iPhone it measures the
/// room it has, so a chosen tab is named only when it fits (`BarFit`), and Settings' back button leaves Settings.
struct WindowBar: View {
    @Binding var nav: Navigation
    /// How many wait in Screening, in the mail stack's profile.
    let screeningCount: Int
    var namesSettingsTabs = true
    var compact = false
    let back: () -> Void
    /// Does what the person chose to the open mail.
    let act: (ActionInput, String) -> Void
    /// The iPhone's Settings' back button: to the stack Settings was opened from.
    var leaveSettings: () -> Void = {}
    @Environment(MailStore.self) private var store
    /// On the iPhone, the row's width.
    @State private var room: CGFloat?

    var body: some View {
        // A done mail, which only search finds, is in no list: the open thread's own copy then.
        let open = nav.reading.flatMap { id in
            store.lists.thread(id: id) ?? (store.openThread?.thread.id == id ? store.openThread?.thread : nil)
        }
        let act: (ActionInput) -> Void = { action in
            if let reading = nav.reading { self.act(action, reading) }
        }
        ZStack(alignment: .leading) {
            TopBar(
                place: $nav.mailPlace, screeningCount: screeningCount, mail: nav.showsTabs ? open : nil,
                hidden: !nav.showsTabs, compact: compact, room: room, now: store.now, back: back, act: act)
            TopBar(
                place: .constant(nav.showsTabs ? .inbox : nav.place), screeningCount: 0,
                mail: nav.showsTabs ? nil : open, returnTitle: nav.searchReturnTitle, hidden: nav.showsTabs,
                settingsTab: $nav.settingsTab, namesSettingsTabs: namesSettingsTabs, compact: compact, room: room,
                leaveTitle: nav.settingsReturnTitle, leave: leaveSettings, now: store.now, back: back, act: act)
        }
        .frame(maxWidth: compact ? .infinity : nil, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) {
            $0.size.width
        } action: { width in
            if compact { room = width }
        }
    }
}
