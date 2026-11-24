import CoreTransferable
import SwiftUI
import UniformTypeIdentifiers
import UsualMailKit

extension UTType {
    /// Mail dragged inside Usual Mail: the threads a row stands for. The app's own type, declared in the app's
    /// Info.plist, so nothing from another app (text from a browser, a file) is ever taken for it.
    static let usualMailThreads = UTType(exportedAs: "labs.usual.UsualMail.threads")
}

/// What a mail row carries while it is dragged (owner's words of 2026-11-20: "drag and drop any email in the home
/// list, and drop it to any icon of reply, snooze and pin icons on the sidebar"): the threads it stands for, its own,
/// or every thread of a notification group. Only in the app's own type: another app takes none of it, and nothing
/// from another app decodes as it.
struct MailDrag: Codable, Hashable, Sendable, Transferable {
    let threadIDs: [String]

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .usualMailThreads)
    }
}

extension View {
    /// Makes a mail row draggable onto the rail: it carries `threadIDs` and shows `name` and `subject` on a small glass
    /// pill under the pointer. A click still opens the row and a right click still shows its menu.
    /// On the iPhone, which has no rail to drop on, it changes nothing.
    func mailDraggable(_ threadIDs: [String], name: String, subject: String) -> some View {
        #if os(macOS)
            modifier(MailDraggable(threadIDs: threadIDs, name: name, subject: subject))
        #else
            self
        #endif
    }
}

@available(iOS, unavailable)
private struct MailDraggable: ViewModifier {
    let threadIDs: [String]
    let name: String
    let subject: String
    @Environment(MailDragState.self) private var drag: MailDragState?

    func body(content: Content) -> some View {
        let drag = self.drag
        let threadIDs = self.threadIDs
        content
            // The item is made as the drag starts, which opens the rail at once (`MailDragState.itemMade`).
            .draggable(MailDragState.item(threadIDs, telling: drag)) {
                MailDragPreview(name: name, subject: subject)
            }
            // One of the drag's starts and ends, if the row reports them: it may not, and it may leave its list
            // before its drag ends, so the drag state has its own ways to tell (`MailDragState`).
            .onDragSessionUpdated { session in
                switch session.phase {
                case .active: drag?.began(threadIDs)
                case .ended, .dataTransferCompleted: drag?.ended()
                default: break
                }
            }
    }
}

/// What follows the pointer while a mail is dragged: who sent it and its subject, on one line on a small glass pill.
/// The words are cut short in characters, since a drag's picture is drawn at its own ideal size.
struct MailDragPreview: View {
    let name: String
    let subject: String

    var body: some View {
        HStack(spacing: 6) {
            if !name.isEmpty {
                Text(verbatim: Self.short(name, 28))
                    .font(Theme.sans(12, weight: .semibold))
                    .foregroundStyle(Theme.ink)
            }
            Text(verbatim: Self.short(subject.isEmpty ? "(no subject)" : subject, 44))
                .font(Theme.sans(12))
                .foregroundStyle(Theme.secondary)
        }
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 12)
        .frame(height: 28)
        // White under the glass, so the pill reads as one even where the glass has nothing behind it to bend.
        .background(Color.white.opacity(0.7), in: Capsule())
        .glassEffect(.regular, in: Capsule())
    }

    /// `words` on one line, cut to `limit` characters with an ellipsis.
    static func short(_ words: String, _ limit: Int) -> String {
        let line = HomeWords.oneLine(words)
        return line.count > limit ? "\(line.prefix(limit - 1).trimmingCharacters(in: .whitespaces))…" : line
    }
}
