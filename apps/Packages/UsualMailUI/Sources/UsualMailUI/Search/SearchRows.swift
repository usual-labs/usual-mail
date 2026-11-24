import SwiftUI
import UsualMailDesign
import UsualMailKit

/// A thread found, on one line as the classic inbox draws it (`AllMailRow`): the avatar, the sender with the message
/// count, the quiet word for where it lives (`SearchWords.place`), the subject with the matched words strong (or as it
/// is) and the excerpt (or the opening words), an attachment mark, the date. Unread the classic way. A click opens the
/// mail page; a right click shows the row's menu (archived mail offers "Move to Inbox"); it drags onto the rail like the
/// classic inbox's rows.
struct SearchHitRow: View {
    let hit: SearchHit
    let inbox: Inbox?
    let dates: MailDate
    let now: Date
    let selected: Bool
    let open: () -> Void
    /// A choice from the row's menu, for this thread.
    let act: (ActionInput) -> Void

    var body: some View {
        let thread = hit.thread
        let row = AllMailRow(thread, inbox: inbox, dates: dates)
        let weight: UsualFontWeight = row.strong ? .semibold : .regular
        let place = SearchWords.place(of: thread, now: now)
        Button(action: open) {
            MailLine {
                Avatar(name: row.avatarName, key: row.avatarKey, avatar: row.avatar)
            } sender: {
                SearchSender(name: row.sender, count: row.count, strong: row.strong)
            } label: {
                Text(verbatim: place)
                    .font(Theme.sans(10))
                    .foregroundStyle(Theme.time)
                    .fixedSize()
                    .padding(.trailing, 8)
            } subject: {
                Text(Self.line(hit, weight: weight))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } trailing: {
                SearchTrailing(hasAttachments: row.hasAttachments, date: row.date, strong: row.strong)
            }
            .searchRow(selected: selected)
        }
        .buttonStyle(PlainControlStyle())
        .rowMenu(for: thread, now: now, open: open, act: act)
        .mailDraggable([thread.id], name: row.sender, subject: row.subject)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            [row.strong ? "Unread" : nil, row.sender, place, row.subject, row.date].compactMap { $0 }.joined(
                separator: ". ")
        )
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// The subject (matched words strong) in ink, then " — " and the excerpt (matched words strong) in the secondary
    /// tone, as one line cut at its end.
    static func line(_ hit: SearchHit, weight: UsualFontWeight) -> AttributedString {
        let subject = SearchWords.highlighted(SearchWords.subject(of: hit), weight: weight, color: Theme.ink)
        let excerpt = SearchWords.excerpt(of: hit)
        guard !excerpt.isEmpty else { return subject }
        var dash = AttributedString(" — ")
        dash.font = Theme.sans(12)
        dash.foregroundColor = Theme.secondary
        return subject + dash + SearchWords.highlighted(excerpt, color: Theme.secondary)
    }
}

/// A sender found by the text: their initials, name, address and how many mails; a click shows everything from them.
struct SearchPersonRow: View {
    let person: SearchPerson
    let selected: Bool
    let choose: () -> Void

    var body: some View {
        let words = SearchWords.person(person)
        Button(action: choose) {
            HStack(spacing: 8) {
                Avatar(name: person.name ?? person.email, key: person.email.lowercased(), avatar: nil)
                Text(verbatim: words.name)
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                Text(verbatim: words.detail)
                    .font(Theme.sans(10))
                    .foregroundStyle(Theme.time)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .frame(height: Avatar.side)
            .searchRow(selected: selected)
        }
        .buttonStyle(PlainControlStyle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Everything from \(words.name)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// An older mail in the mailbox, on the same line as a thread found: who, how many messages, where it is in Gmail, the
/// subject and Gmail's own preview, an attachment mark, the date. A click brings it in and opens it; while it comes, a
/// spinner; if it can't, why, under it.
struct RemoteHitRow: View {
    let hit: RemoteHit
    let dates: MailDate
    let selected: Bool
    let opening: Bool
    let problem: String?
    let open: () -> Void

    var body: some View {
        let name = HomeWords.oneLine(hit.from.displayName)
        let subject = HomeWords.oneLine(hit.subject)
        VStack(alignment: .leading, spacing: 4) {
            Button(action: open) {
                MailLine {
                    Avatar(name: hit.from.displayName, key: hit.from.email.lowercased(), avatar: nil)
                } sender: {
                    SearchSender(
                        name: name.isEmpty ? hit.from.email : name,
                        count: hit.messageCount > 1 ? "\(hit.messageCount)" : nil, strong: false)
                } label: {
                    Text(verbatim: SearchWords.remotePlace(hit))
                        .font(Theme.sans(10))
                        .foregroundStyle(Theme.time)
                        .fixedSize()
                        .padding(.trailing, 8)
                } subject: {
                    Text(Self.line(subject: subject, snippet: HomeWords.oneLine(hit.snippet)))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } trailing: {
                    if opening {
                        ProgressView().controlSize(.mini).padding(.leading, 12)
                    }
                    SearchTrailing(
                        hasAttachments: hit.hasAttachments, date: dates.words(for: hit.lastMessageAt), strong: false)
                }
                .searchRow(selected: selected)
            }
            .buttonStyle(PlainControlStyle())
            .disabled(opening)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(name), \(SearchWords.remotePlace(hit)). \(subject)")
            .accessibilityAddTraits(selected ? .isSelected : [])
            if let problem {
                Text(verbatim: problem)
                    .font(Theme.sans(10))
                    .foregroundStyle(UsualColor.danger)
                    .padding(.leading, Avatar.side + 8)
                    .padding(.bottom, 8)
                    .transition(.blurReveal)
            }
        }
    }

    private static func line(subject: String, snippet: String) -> AttributedString {
        var line = AttributedString(subject.isEmpty ? "(no subject)" : subject)
        line.font = Theme.sans(12)
        line.foregroundColor = Theme.ink
        guard !snippet.isEmpty else { return line }
        var opening = AttributedString(" — \(snippet)")
        opening.font = Theme.sans(12)
        opening.foregroundColor = Theme.secondary
        return line + opening
    }
}

/// The sender and how many messages, in its column on the Mac (`MailLine`), as on the classic inbox.
private struct SearchSender: View {
    let name: String
    let count: String?
    let strong: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(verbatim: name)
                .font(Theme.sans(12, weight: strong ? .semibold : .regular))
                .foregroundStyle(strong ? Theme.ink : Theme.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            if let count {
                Text(verbatim: count)
                    .font(Theme.sans(10))
                    .foregroundStyle(Theme.time)
                    .fixedSize()
            }
        }
    }
}

/// The attachment mark and the date at a row's end.
private struct SearchTrailing: View {
    let hasAttachments: Bool
    let date: String
    let strong: Bool

    var body: some View {
        if hasAttachments {
            Icon.attachment.view(size: 13, tint: Theme.secondary)
                .padding(.leading, 12)
        }
        Text(verbatim: date)
            .font(Theme.sans(10, weight: strong ? .medium : .regular))
            .foregroundStyle(strong ? Theme.ink : Theme.time)
            .fixedSize()
            .frame(minWidth: 52, alignment: .trailing)
            .padding(.leading, 12)
    }
}

extension View {
    /// A search row's highlight: the pointer's soft one (`rowHover`), or a firmer one while the arrows select it, with
    /// the classic inbox's spacing.
    func searchRow(selected: Bool) -> some View {
        rowHover()
            .background {
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color.black.opacity(selected ? 0.06 : 0))
                    .padding(-8)
            }
            .padding(.vertical, 8)
            .contentShape(Rectangle())
    }
}
