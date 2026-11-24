import SwiftUI

/// The parts of a mail on the classic inbox's line and on search's (`InboxRow`, `SearchHitRow`, `RemoteHitRow`), laid
/// out for the screen. On the Mac, one line, Gmail's way: the avatar, the sender in a column of its own so subjects
/// line up, the quiet word for where it is filed, the subject, and at the end the attachment mark and the date. On the
/// iPhone, where one line leaves the subject a few letters (seen in the simulator, 2026-11-20), two: the sender with
/// the mark and the date at the end, and under it the quiet word and the subject.
struct MailLine<Lead: View, Sender: View, Label: View, Subject: View, Trailing: View>: View {
    @ViewBuilder var avatar: Lead
    @ViewBuilder var sender: Sender
    /// The quiet word, with its own space after it; nothing when the row has none.
    @ViewBuilder var label: Label
    @ViewBuilder var subject: Subject
    /// The attachment mark and the date, each with its own space before it.
    @ViewBuilder var trailing: Trailing

    var body: some View {
        #if os(macOS)
            HStack(spacing: 0) {
                avatar
                    .padding(.trailing, 8)
                sender
                    .frame(width: MailLineLayout.senderWidth, alignment: .leading)
                    .padding(.trailing, 12)
                label
                subject
                trailing
            }
            .frame(height: Avatar.side)
        #else
            HStack(alignment: .top, spacing: 8) {
                avatar
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 0) {
                        sender
                        Spacer(minLength: 0)
                        trailing
                    }
                    .frame(height: Avatar.side)
                    HStack(spacing: 0) {
                        label
                        subject
                    }
                }
            }
        #endif
    }
}

enum MailLineLayout {
    /// The sender's column on the Mac, so subjects line up.
    static let senderWidth: CGFloat = 160
}
