import Observation
import SwiftUI
import UsualMailKit

extension View {
    /// On the iPhone, a Home row that does `SwipeAction`s when swiped (`SwipeRow`); nothing on the Mac.
    func homeSwipes(_ thread: MailThread) -> some View {
        swipes(.home, [thread])
    }

    /// On the iPhone, a row of `list` standing for `threads` (one, or a notification group's, newest first) that does
    /// the list's `SwipeAction`s when swiped (`SwipeRow`); nothing on the Mac. A Feed post's header and body each take
    /// one `part`, sharing one `model`, so they move as one.
    @ViewBuilder func swipes(
        _ list: SwipeList, _ threads: [MailThread], model: SwipeModel? = nil, part: SwipePart = .whole
    ) -> some View {
        #if os(iOS)
            modifier(SwipeRow(list: list, threads: threads, shared: model, part: part))
        #else
            self
        #endif
    }
}

/// Where a swiped row is, and what letting go of it asks, kept by the row, or by a Feed post for its header and its
/// body together (`SwipePart`).
@MainActor
@Observable
final class SwipeModel {
    /// How far the row is drawn from its place.
    var offset: CGFloat = 0
    /// Snooze's times, asked for.
    var choosingSnooze = false
    /// A step that asks first (block, unsubscribe), waiting for the answer.
    var confirming: SwipeStep?
    /// The question asked last, kept after the answer so the dialog's title stays while it goes.
    var question = SwipeQuestion.block
}

/// Which part of a row a swipe moves: a whole row, or a Feed post's header (`top`: the action's words, the haptic tap,
/// what letting go asks and VoiceOver's actions are its) and its body (`bottom`: it only moves, with the box behind it).
/// The box behind them meets between the two, rounded at the post's top and foot.
enum SwipePart: Sendable {
    case whole, top, bottom
}

#if os(iOS)
    import UIKit

    /// A row under a finger moving sideways (`SwipeAction`, the owner's words of 2026-11-25 and 2026-11-27): the row
    /// follows the finger, then resists, never going past `SwipeDrag.limit`. Behind it, a rounded box at the row's edge
    /// as wide as the room the row leaves, with the action's icon and words at that edge: the icons' navy on a faint
    /// grey until the row has gone `SwipeDrag.threshold` points, then white on the ink, with a tap of the haptics. Let go
    /// past it, or flicked fast enough to reach it (`SwipeDrag.commits`), the row comes back and the action is done, as
    /// the row's menu does it (the undo strip says so); short of it, nothing. Snooze asks when first, with the menu's
    /// times; block and unsubscribe ask whether (`SwipeQuestion`), and unsubscribe then blocks the sender and asks the
    /// server to have them stop (`MailStore.unsubscribe(threadID:)`). A way set to do nothing doesn't move. Only a sideways drag moves the row
    /// (`HorizontalPan`), so the list still scrolls, and a tap still opens the mail.
    struct SwipeRow: ViewModifier {
        let list: SwipeList
        let threads: [MailThread]
        let shared: SwipeModel?
        let part: SwipePart
        @AppStorage private var left: SwipeAction
        @AppStorage private var right: SwipeAction
        @Environment(MailStore.self) private var store
        @State private var own = SwipeModel()

        init(list: SwipeList, threads: [MailThread], shared: SwipeModel?, part: SwipePart) {
            self.list = list
            self.threads = threads
            self.shared = shared
            self.part = part
            _left = AppStorage(wrappedValue: list.leftDefault, list.leftKey)
            _right = AppStorage(wrappedValue: list.rightDefault, list.rightKey)
        }

        private var model: SwipeModel { shared ?? own }

        func body(content: Content) -> some View {
            let model = model
            let now = store.now
            // A server older than 0.1.5 can't unsubscribe: there the way set to unsubscribe blocks, and asks as blocking.
            let stepFor = { (action: SwipeAction) in
                (action == .unsubscribe && !store.serverUnsubscribes ? .block : action).step(for: threads, now: now)
            }
            let steps = (left: stepFor(left), right: stepFor(right))
            let step = { (side: SwipeDrag.Side?) in side == .left ? steps.left : side == .right ? steps.right : nil }
            let offset = model.offset
            let shown = step(SwipeDrag.side(of: offset))
            let past = abs(offset) >= SwipeDrag.threshold
            let moved =
                content
                .offset(x: offset)
                .background(alignment: offset < 0 ? .trailing : .leading) {
                    if let shown { backdrop(shown, offset: offset, past: past) }
                }
                .gesture(
                    HorizontalPan { translation in
                        // A way that does nothing doesn't move.
                        model.offset =
                            step(SwipeDrag.side(of: translation)) == nil ? 0 : SwipeDrag.offset(for: translation)
                    } ended: { translation, velocity in
                        let chosen = step(SwipeDrag.side(of: translation))
                        withAnimation(Motion.move) { model.offset = 0 }
                        if let chosen, SwipeDrag.commits(translation: translation, velocity: velocity) {
                            finish(chosen)
                        }
                    }
                )
            if part == .bottom {
                moved
            } else {
                moved
                    .sensoryFeedback(.impact(weight: .medium), trigger: past) { was, now in now && !was }
                    .confirmationDialog(
                        "Snooze until", isPresented: Bindable(model).choosingSnooze, titleVisibility: .visible
                    ) {
                        // The times from when it opens, not from the store's last look at the clock.
                        ForEach(SnoozeChoice.choices(now: Date())) { choice in
                            Button(choice.title) { act(choice.input, on: threadIDs) }
                        }
                    }
                    .confirmationDialog(
                        questionTitle, isPresented: confirmingBinding, titleVisibility: .visible,
                        presenting: model.confirming
                    ) { step in
                        Button(step.asks?.button ?? step.spoken, role: .destructive) { answerYes(step) }
                    } message: { step in
                        Text(verbatim: step.asks?.words ?? "")
                    }
                    .accessibilityActions {
                        // The same actions without a swipe, for VoiceOver, in the row menu's words; one when both ways
                        // do the same.
                        if let left = steps.left {
                            Button(left.spoken) { finish(left) }
                        }
                        if let right = steps.right, right != steps.left {
                            Button(right.spoken) { finish(right) }
                        }
                    }
            }
        }

        private var threadIDs: [String] { threads.map(\.id) }

        /// "Block Kestrel Roasters?", "Unsubscribe from Kestrel Roasters?": the sender the row names.
        private var questionTitle: String {
            let question = model.question
            guard let thread = threads.first else { return question.title(nil) }
            return question.title(
                HomeWords.shownSender(of: thread, inbox: store.lists.inbox(id: thread.inboxId)).name)
        }

        /// The question's red button: unsubscribing goes through the store's own way; blocking is the row menu's.
        private func answerYes(_ step: SwipeStep) {
            if step.asks == .unsubscribe, let threadID = step.targets.first {
                Task { await store.unsubscribe(threadID: threadID) }
            } else if let input = step.input {
                act(input, on: step.targets)
            }
        }

        private var confirmingBinding: Binding<Bool> {
            let model = model
            return Binding(get: { model.confirming != nil }, set: { if !$0 { model.confirming = nil } })
        }

        /// Letting go past the threshold: the action, snooze's times, or the question before it.
        private func finish(_ step: SwipeStep) {
            if let question = step.asks {
                model.question = question
                model.confirming = step
            } else if let input = step.input {
                act(input, on: step.targets)
            } else {
                model.choosingSnooze = true
            }
        }

        private func act(_ input: ActionInput, on threadIDs: [String]) {
            Task { await store.perform(input, on: threadIDs) }
        }

        /// The box in the room the row leaves, at the row's edge, its icon and words at that edge (none on a post's
        /// body); rounded at a whole row's corners, a post header's top ones or its body's foot ones.
        private func backdrop(_ step: SwipeStep, offset: CGFloat, past: Bool) -> some View {
            let ink = past ? Color.white : Theme.icon
            let radius: CGFloat = 12
            let shape = UnevenRoundedRectangle(
                topLeadingRadius: part == .bottom ? 0 : radius, bottomLeadingRadius: part == .top ? 0 : radius,
                bottomTrailingRadius: part == .top ? 0 : radius, topTrailingRadius: part == .bottom ? 0 : radius,
                style: .continuous)
            return HStack(spacing: 6) {
                if part != .bottom {
                    step.icon.view(size: 18, tint: ink)
                    Text(verbatim: step.words)
                        .font(Theme.sans(12, weight: .medium))
                        .foregroundStyle(ink)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .padding(.horizontal, 14)
            .frame(width: max(0, abs(offset) - 8), alignment: offset < 0 ? .trailing : .leading)
            .frame(maxHeight: .infinity)
            .background(past ? Theme.ink : Color.black.opacity(0.06), in: shape)
            .clipShape(shape)
            .animation(Motion.reveal, value: past)
            .accessibilityHidden(true)
        }
    }

    /// A pan that starts only when the finger moves more sideways than up or down, so a list's scroll keeps the rest:
    /// `changed` with how far it has gone, `ended` with how far it went and how fast it was moving (nothing when
    /// cancelled).
    struct HorizontalPan: UIGestureRecognizerRepresentable {
        let changed: (CGFloat) -> Void
        let ended: (CGFloat, CGFloat) -> Void

        func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

        func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
            let pan = UIPanGestureRecognizer()
            pan.delegate = context.coordinator
            return pan
        }

        func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
            let translation = recognizer.translation(in: recognizer.view).x
            switch recognizer.state {
            case .changed: changed(translation)
            case .ended: ended(translation, recognizer.velocity(in: recognizer.view).x)
            case .cancelled, .failed: ended(0, 0)
            default: break
            }
        }

        final class Coordinator: NSObject, UIGestureRecognizerDelegate {
            func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
                guard let pan = recognizer as? UIPanGestureRecognizer else { return false }
                let velocity = pan.velocity(in: pan.view)
                return abs(velocity.x) > abs(velocity.y) * 1.2
            }
        }
    }
#endif
