import SwiftUI
import UsualMailKit

/// Settings' Blocked tab (owner's words of 2026-11-20: "showing the blocked senders in a separate tab and unblock them
/// or see how many emails they've sent so far which has been blocked"): the senders blocked in the profile's inbox, or
/// in every inbox, newest block first (`MailStore.blockedSenders`, asked for when the tab shows and kept by
/// `sender.changed`). Each row: initials (a blocked sender never gets a picture), name and address, the inbox when every
/// inbox shows, who blocked them and when, how many messages came since, and Unblock, which takes the row away with the
/// undo strip when there is something to undo. Under a sender the person unsubscribed from, one quiet line on how
/// asking them to stop goes (`BlockedWords.unsubscribe`, kept by `unsubscribe.changed`), and when their page is left to
/// the person, "Open their page". What blocking means is said once, quietly, under the section.
struct BlockedTab: View {
    let inboxId: String?
    @Environment(MailStore.self) private var store
    /// Why an unblock was refused, by sender, shown in that row until it is tried again.
    @State private var refusals: [SenderKey: String] = [:]

    var body: some View {
        SettingsView.page {
            if let list = store.blockedSenders {
                let senders = list.items(in: inboxId)
                SettingsView.group("Blocked senders", footer: BlockedWords.explanation) {
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
/// came since, how unsubscribing from them goes, and Unblock in the row's middle, the system's bordered button, a
/// secondary one (owner's words of 2026-11-24: "should be like a button. not primary though, secondary"): small on the
/// Mac, a finger's size on the iPhone. "Open their page" is the same kind of button, under the line.
private struct BlockedRow: View {
    let sender: BlockedSender
    let inbox: String?
    let byline: String
    let refusal: String?
    let unblock: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
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

    private var unblockButton: some View {
        Self.secondary("Unblock", action: unblock)
    }

    /// A secondary button, the system's bordered one: small on the Mac.
    private static func secondary(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.bordered)
            .tint(Theme.ink)
            #if os(macOS)
                .controlSize(.small)
            #endif
            .pointer()
    }

    /// How unsubscribing from them goes, and their page to open when it is left to the person. The page comes from the
    /// sender's mail, so it opens only on the tap, and only an https one (`Unsubscribe.page`).
    @ViewBuilder private var unsubscribing: some View {
        if let unsubscribe = sender.unsubscribe, let words = BlockedWords.unsubscribe(unsubscribe) {
            Text(verbatim: words)
                .font(Theme.sans(SettingsType.note))
                .foregroundStyle(Theme.time)
                .lineLimit(3)
                .transition(.blurReveal)
            if unsubscribe.state == .needsPerson, let page = unsubscribe.page {
                Self.secondary("Open their page") { Links.open(page) }
                    .padding(.top, 2)
                    .transition(.blurReveal)
            }
        }
    }

    /// Their name, address and inbox, the byline, unsubscribing, and why an unblock was refused.
    private var details: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: BlockedWords.name(sender))
                .font(Theme.sans(SettingsType.body))
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
            Text(verbatim: BlockedWords.address(sender, inbox: inbox))
                .font(Theme.sans(SettingsType.note))
                .foregroundStyle(Theme.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(
                verbatim: [byline, BlockedWords.since(sender.messagesSinceBlocked)].compactMap(\.self)
                    .joined(separator: " · ")
            )
            .font(Theme.sans(SettingsType.note))
            .foregroundStyle(Theme.time)
            .lineLimit(2)
            unsubscribing
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

    /// How asking them to stop goes, in one quiet line: "Unsubscribing…" while the server asks; once done, how it asked
    /// ("Unsubscribed", "Asked by email to stop", "Unsubscribed by Browser Use"); "Their page is left to open" when only
    /// their page is left; when it failed, the server's words as they are. Nothing for a state this app doesn't know.
    static func unsubscribe(_ unsubscribe: Unsubscribe) -> String? {
        let detail = unsubscribe.detail?.trimmingCharacters(in: .whitespacesAndNewlines)
        let failed = detail.flatMap { $0.isEmpty ? nil : $0 } ?? "Couldn't unsubscribe"
        switch unsubscribe.state {
        case .working: return "Unsubscribing…"
        case .done:
            switch unsubscribe.way {
            case .email?: return "Asked by email to stop"
            case .browserAgent?: return "Unsubscribed by Browser Use"
            default: return "Unsubscribed"
            }
        // A page that can't be opened from here (not https) is as good as none.
        case .needsPerson: return unsubscribe.page == nil ? failed : "Their page is left to open"
        case .failed: return failed
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
