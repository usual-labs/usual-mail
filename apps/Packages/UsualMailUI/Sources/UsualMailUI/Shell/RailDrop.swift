import SwiftUI
import UniformTypeIdentifiers
import UsualMailKit

/// What dropping dragged mail on the rail does (owner's words of 2026-11-20: "drop it to any icon of reply, snooze and
/// pin icons on the sidebar, and then that email will be moved to those pages"): the same actions as the row's menu,
/// so the undo strip says what happened.
enum MailDrop {
    /// The rail's buttons that take mail: To reply, Pinned and Snoozed (`Rail.lists`).
    static let targets: [Place] = [.toReply, .pinned, .snoozed]

    enum Outcome: Equatable {
        /// Do this to these threads.
        case act(ActionInput, [String])
        /// Ask when these threads come back (`SnoozeChoice`), then snooze them.
        case chooseSnooze([String])
        case nothing
    }

    /// What dropping `drag` on `target` does, with the threads as the copy (`lists`) has them at `now`. To reply and
    /// Pinned put them on that stack, which takes them off the other; Snoozed asks when they come back. A thread
    /// already there is left alone, so a drop on the list it is on does nothing. Anywhere else, or threads the copy
    /// doesn't hold, nothing.
    static func outcome(of drag: MailDrag, on target: Place?, lists: MailLists, now: Date) -> Outcome {
        var seen = Set<String>()
        let threads = drag.threadIDs.filter { seen.insert($0).inserted }.compactMap(lists.thread(id:))
        let moving: [MailThread]
        switch target {
        case .toReply: moving = threads.filter { $0.stack != .replyLater }
        case .pinned: moving = threads.filter { $0.stack != .setAside }
        case .snoozed: moving = threads.filter { !$0.isWaiting(at: now) }
        default: return .nothing
        }
        let ids = moving.map(\.id)
        guard !ids.isEmpty else { return .nothing }
        switch target {
        case .toReply: return .act(.stack(.replyLater), ids)
        case .pinned: return .act(.stack(.setAside), ids)
        default: return .chooseSnooze(ids)
        }
    }
}

/// Where the rail takes dropped mail: the button whose frame, a little larger, holds the point. Frames and points are
/// in the rail's own coordinates (`space`). The frames are the buttons' as laid out, narrow or open: a mail drag opens
/// the rail at once (`RailOpening`), and then a button's whole width counts, its name and count too; the gaps between
/// buttons still take nothing. Nor does the card: in a narrow window the open rail lies over the card's edge
/// (`RailFit.reachesCard`), over the rows a drag starts from, so mail let go there, where it was picked up too, stays
/// put; the rail's own column, up to the card's edge, still takes it.
enum RailDrop {
    static let space = "rail-drop"
    /// How far past a button's edge still counts as on it: less than half the gap between two buttons.
    static let slack: CGFloat = 3

    /// The button at `point`, if it takes mail. `cardEdge` is where the card starts, in the rail's coordinates
    /// (`MailLayout.railRoom` and the gap).
    static func target(at point: CGPoint, in frames: [Place: CGRect], cardEdge: CGFloat = .infinity) -> Place? {
        guard point.x < cardEdge else { return nil }
        return MailDrop.targets.first { frames[$0]?.insetBy(dx: -slack, dy: -slack).contains(point) == true }
    }
}

extension View {
    /// The rail as the place dragged mail is dropped: it follows the drag over it (`MailDragState`) and acts on a drop
    /// on To reply, Pinned or Snoozed (`MailDrop`). `frames` are those three buttons' frames in `RailDrop.space`, and
    /// `cardEdge` where the card starts there.
    func railDropZone(frames: [Place: CGRect], cardEdge: CGFloat) -> some View {
        modifier(RailDropZone(frames: frames, cardEdge: cardEdge))
    }
}

private struct RailDropZone: ViewModifier {
    let frames: [Place: CGRect]
    let cardEdge: CGFloat
    @Environment(MailDragState.self) private var drag: MailDragState?
    @Environment(MailStore.self) private var store

    func body(content: Content) -> some View {
        if let drag {
            let store = self.store
            content
                .coordinateSpace(.named(RailDrop.space))
                .onDrop(
                    of: [.usualMailThreads],
                    delegate: RailDropDelegate(drag: drag, frames: frames, cardEdge: cardEdge) { mail, target in
                        Self.dropped(mail, on: target, drag: drag, store: store)
                    })
        } else {
            content
        }
    }

    /// What the mail let go on `target` does, once it is read (the drag itself ended as it was let go).
    private static func dropped(_ mail: MailDrag, on target: Place, drag: MailDragState, store: MailStore) {
        switch MailDrop.outcome(of: mail, on: target, lists: store.lists, now: store.now) {
        case .act(let action, let threadIDs):
            Task { await store.perform(action, on: threadIDs) }
        case .chooseSnooze(let threadIDs):
            drag.snoozing = threadIDs
        case .nothing:
            break
        }
    }
}

/// Follows mail dragged over the rail and takes it on a drop. Only the app's own type is taken
/// (`UTType.usualMailThreads`), so text or files from another app go unnoticed. Between the buttons, over the ones
/// that take no mail and over the card, a drop is refused. A drop ends the drag as it is let go, before the mail is
/// read, so the rail shows it at once.
private struct RailDropDelegate: DropDelegate {
    let drag: MailDragState
    let frames: [Place: CGRect]
    let cardEdge: CGFloat
    let drop: @MainActor @Sendable (MailDrag, Place) -> Void

    private func target(_ info: DropInfo) -> Place? {
        RailDrop.target(at: info.location, in: frames, cardEdge: cardEdge)
    }

    func validateDrop(info: DropInfo) -> Bool {
        info.hasItemsConforming(to: [.usualMailThreads])
    }

    func dropEntered(info: DropInfo) {
        drag.over(target(info))
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        let place = target(info)
        drag.over(place)
        return DropProposal(operation: place == nil ? .forbidden : .copy)
    }

    func dropExited(info: DropInfo) {
        drag.leftRail()
    }

    func performDrop(info: DropInfo) -> Bool {
        guard let place = target(info), let provider = info.itemProviders(for: [.usualMailThreads]).first else {
            drag.ended()
            return false
        }
        drag.dropped(on: place)
        let drop = self.drop
        _ = provider.loadTransferable(type: MailDrag.self) { result in
            guard let mail = try? result.get() else { return }
            Task { @MainActor in drop(mail, place) }
        }
        return true
    }
}

/// When mail dropped on Snoozed comes back: the row menu's five choices, in a popover at the Snoozed button. Choosing
/// one snoozes it; closing it leaves the mail where it was.
struct SnoozeDropMenu: View {
    @Environment(MailDragState.self) private var drag: MailDragState?
    @Environment(MailStore.self) private var store

    var body: some View {
        SnoozeMenu { choice in
            guard case .act(let action, let threadIDs) = drag?.choose(choice) else { return }
            Task { await store.perform(action, on: threadIDs) }
        }
    }
}
