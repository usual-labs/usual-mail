import SwiftUI
import UsualMailKit

/// Settings' Blocked tab (owner's words of 2026-11-20: "showing the blocked senders in a separate tab and unblock them
/// or see how many emails they've sent so far which has been blocked"): the senders blocked in the profile's inbox, or
/// in every inbox, newest block first (`MailStore.blockedSenders`, asked for when the tab shows and kept by
/// `sender.changed`). Each row: initials (a blocked sender never gets a picture), name and address, the inbox when every
/// inbox shows, who blocked them and when, how many messages came since, and Unblock, which takes the row away with the
/// undo strip when there is something to undo. What blocking means is said once, quietly, under the list.
struct BlockedTab: View {
    let inboxId: String?
    @Environment(MailStore.self) private var store
    /// Why an unblock was refused, by sender, shown in that row until it is tried again.
    @State private var refusals: [SenderKey: String] = [:]

    var body: some View {
        SettingsView.page {
            if let list = store.blockedSenders {
                let senders = list.items(in: inboxId)
                SettingsView.group("Blocked senders") {
                    if senders.isEmpty {
                        SettingsView.words(BlockedWords.empty)
                            .transition(.blurReveal)
                    }
                    ForEach(senders) { sender in
                        BlockedRow(
                            sender: sender, inbox: inboxId == nil ? inboxName(sender.inboxId) : nil,
                            byline: BlockedWords.blocked(
                                sender, rules: store.lists.rules(inbox: sender.inboxId), now: store.now),
                            refusal: refusals[sender.id]
                        ) {
                            unblock(sender)
                        }
                        .transition(.blurReveal)
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(BlockedWords.explanation, id: \.self) { SettingsView.note($0) }
                }
                .transition(.blurReveal)
            }
        }
        .animation(Motion.move, value: store.blockedSenders)
        .animation(Motion.reveal, value: refusals)
        .task { await store.loadBlockedSenders() }
    }

    private func inboxName(_ id: String) -> String? {
        store.lists.inbox(id: id)?.name
    }

    private func unblock(_ sender: BlockedSender) {
        refusals[sender.id] = nil
        Task {
            if let refusal = await store.unblock(sender) { refusals[sender.id] = refusal }
        }
    }
}

/// One blocked sender: their initials, name and address (and inbox), who blocked them and when, how many messages
/// came since, and Unblock: on the Mac a link at the top of the row, on the iPhone the light button, a secondary one,
/// in the row's middle (owner's words of 2026-11-24: "should be like a button. not primary though, secondary", the
/// iPhone only).
private struct BlockedRow: View {
    let sender: BlockedSender
    let inbox: String?
    let byline: String
    let refusal: String?
    let unblock: () -> Void

    var body: some View {
        HStack(alignment: Self.unblockAlignment, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Avatar(name: BlockedWords.name(sender), key: sender.address)
                    .padding(.top, 1)
                details
            }
            Spacer(minLength: 12)
            unblockButton
                .accessibilityLabel("Unblock \(BlockedWords.name(sender))")
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    /// Where Unblock sits against the row: level with the name on the Mac, in the middle on the iPhone.
    private static var unblockAlignment: VerticalAlignment {
        #if os(iOS)
            .center
        #else
            .top
        #endif
    }

    @ViewBuilder private var unblockButton: some View {
        #if os(iOS)
            Button(action: unblock) { LightButtonLabel(title: "Unblock") }
                .buttonStyle(PlainControlStyle())
        #else
            SettingsView.link("Unblock", action: unblock)
        #endif
    }

    /// Their name, address and inbox, the byline, and why an unblock was refused.
    private var details: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: BlockedWords.name(sender))
                .font(Theme.sans(12))
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
            Text(verbatim: BlockedWords.address(sender, inbox: inbox))
                .font(Theme.sans(10))
                .foregroundStyle(Theme.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(
                verbatim: [byline, BlockedWords.since(sender.messagesSinceBlocked)].compactMap(\.self)
                    .joined(separator: " · ")
            )
            .font(Theme.sans(10))
            .foregroundStyle(Theme.time)
            .lineLimit(1)
            if let refusal {
                SettingsView.refusal(refusal)
                    .transition(.blurReveal)
            }
        }
    }
}

/// The Blocked tab's words.
enum BlockedWords {
    static let empty = "No blocked senders."

    /// What blocking and unblocking do, in the server engineer's words (docs/contract.md, "Blocked senders").
    static let explanation = [
        "Mail from a blocked sender arrives already done and never reaches Home or the AI.",
        "“Messages since” counts the mail from them this server holds since the block; mail your mailbox put in spam or trash isn't counted.",
        "Unblocking lets their new mail in again. Mail that arrived while they were blocked, and the conversations the block marked done, stay done; you can find them in search.",
        "Unblocking can be undone.",
    ]

    /// Their name, or their address when their mail gives none.
    static func name(_ sender: BlockedSender) -> String {
        let name = sender.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? sender.address : name
    }

    /// Their address (when their name is shown above it), then the inbox when every inbox shows.
    static func address(_ sender: BlockedSender, inbox: String?) -> String {
        let address = name(sender) == sender.address ? nil : sender.address
        return [address, inbox].compactMap(\.self).joined(separator: " · ")
    }

    /// "Blocked 12 Nov by you", "Blocked 13 Nov by Claude Code", "Blocked 9 Nov by a rule: Cold outreach is done";
    /// the year too when it isn't this year's; without "by" when no record says who. `rules` are the sender's inbox's,
    /// so a rule is named by its own text, as "why it's here" names it.
    static func blocked(
        _ sender: BlockedSender, rules: [Rule] = [], now: Date, calendar: Calendar = .current
    ) -> String {
        let style = Date.FormatStyle(calendar: calendar, timeZone: calendar.timeZone).locale(
            Locale(identifier: "en_GB"))
        let sameYear = calendar.component(.year, from: sender.blockedAt) == calendar.component(.year, from: now)
        let day = sender.blockedAt.formatted(
            sameYear ? style.day().month(.abbreviated) : style.day().month(.abbreviated).year())
        guard let by = sender.blockedBy.flatMap({ who($0, rules: rules) }) else { return "Blocked \(day)" }
        return "Blocked \(day) by \(by)"
    }

    /// Who blocked them, as the app names actors elsewhere: "you", an agent by its name, a rule by its text.
    static func who(_ actor: Doer, rules: [Rule]) -> String? {
        switch actor {
        case .person: return "you"
        case .agent(_, let name):
            let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? "an agent" : name
        case .rule(let id):
            let text = rules.first { $0.id == id }?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return text.isEmpty ? "a rule" : "a rule: \(text)"
        case .ai: return "the AI"
        case .system: return "the server"
        case .unknown: return nil
        }
    }

    /// "1 message since", "3 messages since"; nothing for none.
    static func since(_ count: Int) -> String? {
        switch count {
        case ...0: nil
        case 1: "1 message since"
        default: "\(count) messages since"
        }
    }
}
