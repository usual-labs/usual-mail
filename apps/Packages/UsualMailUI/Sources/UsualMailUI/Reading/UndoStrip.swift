import SwiftUI
import UsualMailKit

/// After the person moves a mail away: what happened, and Undo, for a few seconds at the foot of the card. When the
/// server asks the teach question ("Always treat mail from … as a newsletter?"), it asks it here instead.
struct UndoStrip: View {
    @Environment(MailStore.self) private var store
    @State private var shownAction: RecentAction?

    var body: some View {
        Group {
            if let prompt = store.teachPrompt {
                strip {
                    Text(verbatim: prompt.question)
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.ink)
                    button("Yes") { Task { await store.answerTeach(accept: true) } }
                    button("No") { Task { await store.answerTeach(accept: false) } }
                }
                .transition(.blurReveal)
            } else if let action = shownAction {
                strip {
                    Text(verbatim: action.words ?? ActionWords.done(action.action))
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.ink)
                    button("Undo") {
                        shownAction = nil
                        Task { await store.undoLastAction() }
                    }
                }
                .transition(.blurReveal)
            }
        }
        .animation(Motion.move, value: shownAction)
        .animation(Motion.move, value: store.teachPrompt?.id)
        .onChange(of: store.lastAction) { _, action in shownAction = action }
        .task(id: shownAction) {
            guard shownAction != nil else { return }
            try? await Task.sleep(for: .seconds(6))
            shownAction = nil
        }
    }

    private func strip<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 12) { content() }
            .padding(.leading, 16)
            .padding(.trailing, 6)
            .frame(height: 36)
            .glassEffect(.regular.tint(.white.opacity(0.6)), in: Capsule())
    }

    private func button(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            StripButtonLabel(title: title)
        }
        .buttonStyle(PlainControlStyle())
    }
}

/// What an action did, in a few words.
enum ActionWords {
    static func done(_ action: ActionInput) -> String {
        switch action {
        case .done: "Archived."
        case .read: "Marked as read."
        case .unread: "Marked as unread."
        case .stack(.replyLater): "Moved to To reply."
        case .stack(.setAside): "Pinned."
        // The action doesn't say which stack it left, so neither can the strip.
        case .unstack: "Taken off its list."
        case .comeBack(let at, let ifNoReply):
            "Snoozed until \(at.formatted(.dateTime.weekday(.wide).hour().minute()))\(ifNoReply == true ? ", unless someone answers" : "")."
        case .cancelComeBack: "Unsnoozed."
        case .categorize(.newsletter): "Moved to the feed."
        case .categorize(.invoice): "Moved to the paper trail as an invoice."
        case .categorize(.receipt): "Moved to the paper trail as a receipt."
        case .categorize(.conversation): "Moved to Home."
        case .categorize(.notification): "Moved to notifications."
        case .trash: "Removed."
        case .allowSender: "Let in."
        case .blockSender: "Blocked."
        default: "Done."
        }
    }
}

/// The strip's button (Undo): white at 30%, brighter under the pointer.
private struct StripButtonLabel: View {
    let title: String
    @Environment(\.isControlHovered) private var hovered

    var body: some View {
        Text(title)
            .font(Theme.sans(12, weight: .medium))
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 12)
            .frame(height: 26)
            .background(hovered ? Theme.controlHovered : Theme.control, in: Capsule())
    }
}
