import SwiftUI
import UsualMailKit

/// The mail's menu (`…`): why it is here (with, for a mail that skipped Screening, its line and the sender's let in and
/// block, docs/contract.md "Skipped Screening"), then moving it to the feed or the paper trail, forward, label and remove,
/// each with its icon.
struct MoreMenu: View {
    let mail: MailThread
    let choose: (ActionInput) -> Void
    @Environment(MailStore.self) private var store
    @State private var paperTrail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: WhyWords.line(for: mail, rules: store.lists.rules(inbox: mail.inboxId)))
                .font(Theme.sans(10))
                .foregroundStyle(Theme.time)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .fixedSize(horizontal: false, vertical: true)
            if let skipped = WhyWords.skipped(mail) {
                // Out of Screening without its sender let in: the line, and the sender's choices Screening offers.
                Text(verbatim: skipped)
                    .font(Theme.sans(10))
                    .foregroundStyle(Theme.time)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 6)
                    .fixedSize(horizontal: false, vertical: true)
                MenuRow(icon: .letIn, title: "Let in") { choose(.allowSender) }
                MenuRow(icon: .block, title: "Block sender") { choose(.blockSender) }
            }
            Divider().padding(.vertical, 2)
            if mail.category != .newsletter {
                MenuRow(icon: .reads, title: "Move to feed") { choose(.categorize(.newsletter)) }
            }
            MenuRow(icon: .receipts, title: "Move to paper trail", trailing: paperTrail ? "⌃" : "⌄") {
                withAnimation(Motion.move) { paperTrail.toggle() }
            }
            if paperTrail {
                Group {
                    if mail.category != .invoice {
                        MenuRow(icon: nil, title: "As an invoice", indent: true) { choose(.categorize(.invoice)) }
                    }
                    if mail.category != .receipt {
                        MenuRow(icon: nil, title: "As a receipt", indent: true) { choose(.categorize(.receipt)) }
                    }
                }
                .transition(.blurReveal)
            }
            MenuRow(icon: .forward, title: "Forward", enabled: false) {}
                .help("Forwarding comes with writing mail.")
            MenuRow(icon: .label, title: "Label", enabled: false) {}
                .help("Labels aren't in the server's contract yet.")
            Divider().padding(.vertical, 2)
            MenuRow(icon: .remove, title: "Remove") { choose(.trash) }
        }
        .padding(6)
        .frame(width: 230)
    }
}

/// Snooze: when it comes back to Home.
struct SnoozeMenu: View {
    let choose: (SnoozeChoice) -> Void
    @State private var now = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(SnoozeChoice.choices(now: now)) { choice in
                MenuRow(icon: .snoozed, title: choice.title) { choose(choice) }
            }
        }
        .padding(6)
        .frame(width: 260)
        .onAppear { now = Date() }
    }
}

#if os(iOS)
    /// On the iPhone, snooze's and more's choices as the system's menu, in its type, icons and dividers (the owner's
    /// words of 2026-11-25: "this menu does not look native"): snooze's times; or why the mail is here as the menu's
    /// title (with, for a mail that skipped Screening, its line and the sender's let in and block, docs/contract.md),
    /// then moving it to the feed, the paper trail as a submenu (as an invoice, as a receipt), forward and label
    /// (not yet), and remove, in red, apart. The Mac keeps its popovers (`SnoozeMenu`, `MoreMenu`).
    struct PhoneBarMenu: View {
        let action: BarAction
        let mail: MailThread
        let now: Date
        let choose: (ActionInput) -> Void
        @Environment(MailStore.self) private var store

        var body: some View {
            if action == .snooze {
                ForEach(SnoozeChoice.choices(now: now)) { choice in
                    item(choice.title, icon: .snoozed) { choose(choice.input) }
                }
            } else {
                let title = WhyWords.title(for: mail, rules: store.lists.rules(inbox: mail.inboxId))
                if WhyWords.skipped(mail) != nil {
                    // Out of Screening without its sender let in: the sender's choices Screening offers, under why.
                    Section(title) {
                        item("Let in", icon: .letIn) { choose(.allowSender) }
                        item("Block sender", icon: .block, destructive: true) { choose(.blockSender) }
                    }
                    Section { moves }
                } else {
                    Section(title) { moves }
                }
                Section {
                    item("Remove", icon: .remove, destructive: true) { choose(.trash) }
                }
            }
        }

        /// Moving it to the feed or the paper trail; forward and label, not yet.
        @ViewBuilder private var moves: some View {
            if mail.category != .newsletter {
                item("Move to feed", icon: .reads) { choose(.categorize(.newsletter)) }
            }
            Menu {
                if mail.category != .invoice {
                    Button("As an invoice") { choose(.categorize(.invoice)) }
                }
                if mail.category != .receipt {
                    Button("As a receipt") { choose(.categorize(.receipt)) }
                }
            } label: {
                Text("Move to paper trail")
                Icon.receipts.menuImage
            }
            // Forwarding comes with writing mail; labels aren't in the server's contract yet.
            item("Forward", icon: .forward) {}.disabled(true)
            item("Label", icon: .label) {}.disabled(true)
        }

        private func item(
            _ title: String, icon: Icon, destructive: Bool = false, action: @escaping () -> Void
        ) -> some View {
            Button(role: destructive ? .destructive : nil, action: action) {
                Text(title)
                icon.menuImage
            }
        }
    }
#endif

/// One line of a menu: an icon, its words, and a soft highlight under the pointer.
struct MenuRow: View {
    let icon: Icon?
    let title: String
    var trailing: String? = nil
    var indent = false
    var enabled = true
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let icon {
                    icon.view()
                } else {
                    Color.clear.frame(width: 16, height: 16)
                }
                Text(title)
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                if let trailing {
                    Text(trailing)
                        .font(Theme.sans(10))
                        .foregroundStyle(Theme.time)
                }
            }
            .padding(.leading, indent ? 34 : 10)
            .padding(.trailing, 10)
            .frame(height: 28)
            .contentShape(Rectangle())
            .background(
                hovering && enabled ? Color.black.opacity(0.05) : .clear, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(PlainControlStyle())
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// When a snoozed mail comes back: later today, tomorrow morning, at the weekend, next week, or tomorrow if nobody
/// has answered by then.
struct SnoozeChoice: Identifiable, Equatable {
    let title: String
    let at: Date
    var ifNoReply: Bool? = nil

    /// What choosing it does, wherever it is offered (the mail page's snooze, the row's menu, a swipe).
    var input: ActionInput { .comeBack(at: at, ifNoReply: ifNoReply) }

    var id: String { "\(title)\(at.timeIntervalSince1970)" }

    static func choices(now: Date, calendar: Calendar = .current) -> [SnoozeChoice] {
        func at(_ hour: Int, daysAhead: Int) -> Date? {
            guard let day = calendar.date(byAdding: .day, value: daysAhead, to: calendar.startOfDay(for: now)) else {
                return nil
            }
            return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)
        }
        var choices: [SnoozeChoice] = []
        if let evening = at(18, daysAhead: 0), evening.timeIntervalSince(now) > 3600 {
            choices.append(SnoozeChoice(title: "Later today, 18:00", at: evening))
        }
        if let tomorrow = at(8, daysAhead: 1) {
            choices.append(SnoozeChoice(title: "Tomorrow, 08:00", at: tomorrow))
        }
        let weekday = calendar.component(.weekday, from: now)  // 1 is Sunday, 7 Saturday
        if weekday != 7 && weekday != 1, let saturday = at(9, daysAhead: 7 - weekday) {
            choices.append(SnoozeChoice(title: "This weekend, Saturday 09:00", at: saturday))
        }
        if let monday = at(8, daysAhead: weekday == 1 ? 1 : 9 - weekday) {
            choices.append(SnoozeChoice(title: "Next week, Monday 08:00", at: monday))
        }
        if let tomorrow = at(8, daysAhead: 1) {
            choices.append(SnoozeChoice(title: "Tomorrow, if nobody has answered", at: tomorrow, ifNoReply: true))
        }
        return choices
    }
}
