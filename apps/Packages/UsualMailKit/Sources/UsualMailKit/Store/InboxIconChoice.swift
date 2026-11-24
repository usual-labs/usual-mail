import Foundation
import Observation

/// Changing an inbox's icon from Settings (person only). The picker offers every icon the contract allows
/// (`InboxIcon.known`, in its order), the inbox's own marked. Choosing another saves it at once through
/// `MailStore.updateInbox`, which waits for the server, so until it answers the choice is `saving` and every place that
/// draws the inbox's icon (its row, the profile switch) still shows the old one; once the store keeps the answer they
/// change together. A refusal's words are taken from the store's problem, since the row shows them, and the inbox
/// keeps its icon.
@MainActor
@Observable
public final class InboxIconChoice {
    public enum State: Hashable, Sendable {
        case idle
        /// This icon is on its way to the server.
        case saving(InboxIcon)
        /// The server refused the last choice or couldn't be asked, in words; the inbox kept its icon.
        case refused(String)
    }

    /// One icon the picker offers, and whether it is the inbox's own.
    public struct Option: Hashable, Sendable, Identifiable {
        public let icon: InboxIcon
        public let isCurrent: Bool

        public var id: String { icon.rawValue }
    }

    public private(set) var state = State.idle

    public init() {}

    /// Every icon an inbox may have, in the contract's order, the inbox's own marked. An icon this app doesn't know (a
    /// newer server's) marks none.
    public static func options(current: InboxIcon) -> [Option] {
        InboxIcon.known.map { Option(icon: $0, isCurrent: $0 == current) }
    }

    public var isSaving: Bool {
        if case .saving = state { return true }
        return false
    }

    /// Why the last choice wasn't kept, if it wasn't.
    public var refusal: String? {
        if case .refused(let words) = state { return words }
        return nil
    }

    /// Saves `icon` as the inbox's. Choosing the icon it has, or choosing while a save is on its way, does nothing.
    public func choose(_ icon: InboxIcon, for inboxId: String, in store: MailStore) async {
        guard !isSaving, let inbox = store.lists.inbox(id: inboxId), inbox.icon != icon else { return }
        state = .saving(icon)
        let shown = store.problem?.id
        if await store.updateInbox(inboxId, InboxPatch(icon: icon)) {
            state = .idle
        } else {
            state = .refused(Self.refusal(since: shown, in: store))
        }
    }

    /// The store's words for a refusal it reported since `shown`, taken from it, since the row shows them.
    private static func refusal(since shown: UUID?, in store: MailStore) -> String {
        guard let problem = store.problem, problem.id != shown else {
            return "Your server didn't keep the icon. Try again."
        }
        store.dismissProblem()
        return problem.message
    }
}
