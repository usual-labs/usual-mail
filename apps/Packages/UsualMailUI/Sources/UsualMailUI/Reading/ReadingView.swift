import SwiftUI
import UsualMailKit

/// The mail page (Figma frame "MacBook Pro 14" - 9"): inside the card, the subject and when, who wrote it, the AI's
/// summary in a white box, then the mail itself as the sender wrote it. Earlier messages of the thread are folded
/// above the newest, as Gmail shows a conversation. Opening it marks it read.
///
/// The header (subject, when, who) stays put at the top as a bar; the summary and the mail scroll beneath it under
/// the system's own soft scroll edge effect, as under a toolbar (owner's direction of 2026-11-18: Apple's native
/// effect, after a custom blur looked wrong).
struct ReadingView: View {
    let threadID: String
    @Environment(MailStore.self) private var store

    var body: some View {
        let detail = store.openThread?.thread.id == threadID ? store.openThread : nil
        let thread = detail?.thread ?? store.lists.thread(id: threadID)
        let inbox = thread.flatMap { store.lists.inbox(id: $0.inboxId) }
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let thread, let summary = MailPage.summaryLine(thread, inbox: inbox, now: store.now) {
                    // A model's plain text: shown as text, never as markup.
                    Text(verbatim: summary)
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(.white, in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.hairline, lineWidth: 1))
                        .revealOnAppear(delay: Motion.delay(at: 1))
                }
                if let detail {
                    MailMessages(messages: detail.messages, client: store.apiClient)
                        .revealOnAppear(delay: Motion.delay(at: 2))
                } else {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, Theme.pageInset)
            .padding(.top, 12)
            .padding(.bottom, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.never)
        .scrollEdgeEffectStyle(.automatic, for: .top)
        .safeAreaBar(edge: .top, spacing: 0) {
            if let thread {
                MailHeader(thread: thread, latest: detail.flatMap(MailPage.latestIncoming), inbox: inbox)
                    .padding(.horizontal, Theme.pageInset)
                    .padding(.top, 18)
                    .padding(.bottom, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .revealOnAppear()
            }
        }
        .task(id: threadID) { await store.open(threadID: threadID) }
    }
}

/// The subject with when the last message came, and who wrote it with their address.
private struct MailHeader: View {
    let thread: MailThread
    let latest: Message?
    let inbox: Inbox?

    var body: some View {
        // The latest incoming message's From and picture; until the messages come, the row's own (`shownSender`).
        let shown = HomeWords.shownSender(of: thread, inbox: inbox)
        let sender = latest?.from ?? shown.address
        let picture = if let latest { MailPage.picture(of: latest) } else { shown.avatar }
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Text(verbatim: thread.subject.isEmpty ? "(no subject)" : thread.subject)
                    .font(Theme.sans(16, weight: .medium))
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                Spacer(minLength: 12)
                TimelineView(.everyMinute) { context in
                    Text(HomeWords.ago(thread.lastMessageAt, now: context.date))
                        .font(Theme.sans(10))
                        .foregroundStyle(Theme.time)
                }
            }
            if let sender {
                HStack(spacing: 8) {
                    Avatar(name: sender.displayName, key: sender.email, avatar: picture)
                    Text(verbatim: MailPage.senderLine(sender))
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.secondary)
                        .textSelection(.enabled)
                }
            }
        }
    }
}

/// The thread's messages, oldest first: earlier ones folded to a line that opens on a click, the newest open.
private struct MailMessages: View {
    let messages: [Message]
    let client: APIClient
    @State private var unfolded: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                let newest = index == messages.count - 1
                if newest {
                    if messages.count > 1 { MessageFrom(message: message) }
                    MessageBody(message: message, client: client)
                } else if unfolded.contains(message.id) {
                    Button {
                        withAnimation(Motion.move) { _ = unfolded.remove(message.id) }
                    } label: {
                        MessageFrom(message: message).rowHover()
                    }
                    .buttonStyle(PlainControlStyle())
                    MessageBody(message: message, client: client)
                        .transition(.blurReveal)
                } else {
                    Button {
                        withAnimation(Motion.move) { _ = unfolded.insert(message.id) }
                    } label: {
                        FoldedMessage(message: message).rowHover()
                    }
                    .buttonStyle(PlainControlStyle())
                }
                if !newest { Divider().opacity(0.5) }
            }
        }
    }
}

/// An earlier message, folded: who, the first words, when.
private struct FoldedMessage: View {
    let message: Message

    var body: some View {
        HStack(spacing: 8) {
            Avatar(name: message.from.displayName, key: message.from.email, avatar: MailPage.picture(of: message))
            Text(verbatim: message.outgoing ? "You" : message.from.displayName)
                .font(Theme.sans(12, weight: .medium))
                .foregroundStyle(Theme.ink)
            Text(verbatim: MailPage.firstWords(of: message))
                .font(Theme.sans(12))
                .foregroundStyle(Theme.secondary)
                .lineLimit(1)
            Spacer(minLength: 12)
            Text(message.date.formatted(date: .abbreviated, time: .shortened))
                .font(Theme.sans(10))
                .foregroundStyle(Theme.time)
        }
        .contentShape(Rectangle())
    }
}

/// An open earlier message's line: who and when.
private struct MessageFrom: View {
    let message: Message

    var body: some View {
        HStack(spacing: 8) {
            Avatar(name: message.from.displayName, key: message.from.email, avatar: MailPage.picture(of: message))
            Text(verbatim: message.outgoing ? "You" : MailPage.senderLine(message.from))
                .font(Theme.sans(12))
                .foregroundStyle(Theme.secondary)
            Spacer(minLength: 12)
            Text(message.date.formatted(date: .abbreviated, time: .shortened))
                .font(Theme.sans(10))
                .foregroundStyle(Theme.time)
        }
        .contentShape(Rectangle())
    }
}

/// A message as its sender wrote it: its HTML, or its text with links that open in the browser. Its pictures from
/// the web come through the server, trackers taken out; one quiet line above says what the server took out or held
/// back, or that the HTML was too long to show (`PictureWords`), with who made the trackers on hover. The Feed's posts
/// show their mail with it too.
struct MessageBody: View {
    let message: Message
    let client: APIClient

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let line = PictureWords.line(for: message.remotePictures, htmlTooLarge: message.htmlTooLarge) {
                let from = PictureWords.tooltip(for: message.remotePictures)
                Text(verbatim: line)
                    .font(Theme.sans(10))
                    .foregroundStyle(Theme.time)
                    .tooltip(from, edge: .trailing)
                    .accessibilityHint(from ?? "")
            }
            if let html = message.html, !html.isEmpty {
                HTMLMailView(message: message, client: client)
            } else {
                Text(MailPage.linked(message.text ?? ""))
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.body)
                    .tint(Theme.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

/// The mail page's words.
enum MailPage {
    /// "Maya Kim (maya@studio.example)", or the address alone when there is no name.
    static func senderLine(_ address: Address) -> String {
        guard let name = address.name, !name.isEmpty, name != address.email else { return address.email }
        return "\(name) (\(address.email))"
    }

    /// The summary box's words. A receipt's or an invoice's are its money words, the title over the subtitle
    /// (`PaymentWords`: "To be paid: €1,240.00 to Kestrel Roasters", then "October's bean delivery · due 30 Nov"),
    /// with or without a summary, which is then the same `what` and so shows once. A notification's with an event
    /// status are the event over what it is about, else the summary (`EventWords`: "Out for delivery · today,
    /// 3:15–6:15 pm", then "Parcel from Fernhill Books"), the day said against `now` where the person is (`timeZone`).
    /// Any other thread's are "Sender - summary"; nil without a summary.
    static func summaryLine(
        _ thread: MailThread, inbox: Inbox?, locale: Locale = .current, now: Date = .now,
        timeZone: TimeZone = .current
    ) -> String? {
        if let words = PaymentWords(thread, locale: locale) { return words.lines }
        if let words = EventWords(thread, inbox: inbox, now: now, timeZone: timeZone, locale: locale) {
            return words.lines
        }
        guard let summary = thread.summary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty
        else { return nil }
        return HomeWords.line(for: thread, inbox: inbox)
    }

    /// The picture a message's line shows for its From: the message's own (`Message.avatar`), never on the inbox's
    /// own mail, whose "You" lines always show initials.
    static func picture(of message: Message) -> SenderPicture? {
        message.outgoing ? nil : message.avatar
    }

    /// The newest message someone else wrote, or the newest of all.
    static func latestIncoming(_ detail: ThreadDetail) -> Message? {
        detail.messages.last { !$0.outgoing } ?? detail.messages.last
    }

    /// A folded message's first words.
    static func firstWords(of message: Message) -> String {
        let text = message.text ?? ""
        return text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
    }

    /// Plain text with its web and mail addresses as links, underlined, as Gmail shows them.
    static func linked(_ text: String) -> AttributedString {
        var attributed = AttributedString(text)
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return attributed
        }
        let whole = NSRange(text.startIndex..., in: text)
        for match in detector.matches(in: text, range: whole) {
            guard let url = match.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? ""),
                let range = Range(match.range, in: text), let linked = Range(range, in: attributed)
            else { continue }
            attributed[linked].link = url
            attributed[linked].underlineStyle = .single
        }
        return attributed
    }
}
