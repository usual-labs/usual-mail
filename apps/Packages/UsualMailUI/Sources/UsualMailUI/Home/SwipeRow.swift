import SwiftUI
import UsualMailKit

extension View {
    /// On the iPhone, a Home row that does `SwipeAction`s when swiped (`SwipeRow`); nothing on the Mac.
    @ViewBuilder func homeSwipes(_ thread: MailThread) -> some View {
        #if os(iOS)
            modifier(SwipeRow(thread: thread))
        #else
            self
        #endif
    }
}

#if os(iOS)
    import UIKit

    /// A Home row under a finger moving sideways (`SwipeAction`, the owner's words of 2026-11-25): the row follows the
    /// finger, then resists, never going past `SwipeDrag.limit`. Behind it, a rounded box at the row's edge as wide as
    /// the room the row leaves, with the action's icon and words at that edge: the icons' navy on a faint grey until the
    /// row has gone `SwipeDrag.threshold` points, then white on the ink, with a tap of the haptics. Let go past it, or
    /// flicked fast enough to reach it (`SwipeDrag.commits`), the row comes back and the action is done, as the row's
    /// menu does it (the undo strip says so); short of it, nothing. Snooze asks when first, with the menu's times. A
    /// way set to do nothing doesn't move. Only a sideways drag moves the row (`HorizontalPan`), so the list still
    /// scrolls, and a tap still opens the mail.
    struct SwipeRow: ViewModifier {
        let thread: MailThread
        @AppStorage(SwipeAction.leftKey) private var left = SwipeAction.leftDefault
        @AppStorage(SwipeAction.rightKey) private var right = SwipeAction.rightDefault
        @Environment(MailStore.self) private var store
        @State private var offset: CGFloat = 0
        @State private var choosingSnooze = false

        func body(content: Content) -> some View {
            let now = store.now
            let steps = (left: left.step(for: thread, now: now), right: right.step(for: thread, now: now))
            let step = { (side: SwipeDrag.Side?) in side == .left ? steps.left : side == .right ? steps.right : nil }
            let shown = step(SwipeDrag.side(of: offset))
            let past = abs(offset) >= SwipeDrag.threshold
            content
                .offset(x: offset)
                .background(alignment: offset < 0 ? .trailing : .leading) {
                    if let shown { backdrop(shown, past: past) }
                }
                .gesture(
                    HorizontalPan { translation in
                        // A way that does nothing doesn't move.
                        offset = step(SwipeDrag.side(of: translation)) == nil ? 0 : SwipeDrag.offset(for: translation)
                    } ended: { translation, velocity in
                        let chosen = step(SwipeDrag.side(of: translation))
                        withAnimation(Motion.move) { offset = 0 }
                        if let chosen, SwipeDrag.commits(translation: translation, velocity: velocity) {
                            finish(chosen)
                        }
                    }
                )
                .sensoryFeedback(.impact(weight: .medium), trigger: past) { was, now in now && !was }
                .confirmationDialog("Snooze until", isPresented: $choosingSnooze, titleVisibility: .visible) {
                    ForEach(SnoozeChoice.choices(now: store.now)) { choice in
                        Button(choice.title) { act(choice.input) }
                    }
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

        /// Letting go past the threshold: the action, or snooze's times.
        private func finish(_ step: SwipeStep) {
            if let input = step.input {
                act(input)
            } else {
                choosingSnooze = true
            }
        }

        private func act(_ input: ActionInput) {
            Task { await store.perform(input, on: [thread.id]) }
        }

        /// The box in the room the row leaves, at the row's edge, its icon and words at that edge.
        private func backdrop(_ step: SwipeStep, past: Bool) -> some View {
            let ink = past ? Color.white : Theme.icon
            return HStack(spacing: 6) {
                step.icon.view(size: 18, tint: ink)
                Text(verbatim: step.words)
                    .font(Theme.sans(12, weight: .medium))
                    .foregroundStyle(ink)
                    .lineLimit(1)
                    .fixedSize()
            }
            .padding(.horizontal, 14)
            .frame(width: max(0, abs(offset) - 8), alignment: offset < 0 ? .trailing : .leading)
            .frame(maxHeight: .infinity)
            .background(
                past ? Theme.ink : Color.black.opacity(0.06),
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
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
