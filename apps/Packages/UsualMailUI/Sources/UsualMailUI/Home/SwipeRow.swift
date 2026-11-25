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
    /// finger; behind it, in the room it leaves, what letting go would do, its icon and words, in a light grey until
    /// the row has gone `threshold` points, then in the ink, with a tap of the haptics. Let go past it, the row comes
    /// back and the action is done, as the row's menu does it (the undo strip says so); short of it, nothing. Snooze
    /// asks when first, with the menu's times. A way set to do nothing doesn't move. Only a sideways drag moves the row
    /// (`HorizontalPan`), so the list still scrolls, and a tap still opens the mail.
    struct SwipeRow: ViewModifier {
        let thread: MailThread
        @AppStorage(SwipeAction.leftKey) private var left = SwipeAction.leftDefault
        @AppStorage(SwipeAction.rightKey) private var right = SwipeAction.rightDefault
        @Environment(MailStore.self) private var store
        @State private var offset: CGFloat = 0
        @State private var choosingSnooze = false

        /// How far the row goes before letting go acts.
        static let threshold: CGFloat = 88

        func body(content: Content) -> some View {
            let now = store.now
            let steps = (left: left.step(for: thread, now: now), right: right.step(for: thread, now: now))
            let shown = offset < 0 ? steps.left : offset > 0 ? steps.right : nil
            let past = abs(offset) >= Self.threshold
            content
                .offset(x: offset)
                .background(alignment: offset < 0 ? .trailing : .leading) {
                    if let shown { backdrop(shown, past: past) }
                }
                .gesture(
                    HorizontalPan { translation in
                        // A way that does nothing doesn't move.
                        if translation < 0 && steps.left == nil || translation > 0 && steps.right == nil {
                            offset = 0
                        } else {
                            offset = translation
                        }
                    } ended: { translation in
                        let step = translation < 0 ? steps.left : steps.right
                        withAnimation(Motion.move) { offset = 0 }
                        if abs(translation) >= Self.threshold, let step { finish(step) }
                    }
                )
                .sensoryFeedback(.impact(weight: .medium), trigger: past) { was, now in now && !was }
                .confirmationDialog("Snooze until", isPresented: $choosingSnooze, titleVisibility: .visible) {
                    ForEach(SnoozeChoice.choices(now: store.now)) { choice in
                        Button(choice.title) { act(.comeBack(at: choice.at, ifNoReply: choice.ifNoReply)) }
                    }
                }
                .accessibilityActions {
                    // The same actions without a swipe, for VoiceOver.
                    ForEach([steps.left, steps.right].compactMap(\.self), id: \.words) { step in
                        Button(step.words) { finish(step) }
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

        /// What shows in the room the row leaves: as wide as that room, the icon and words at its inner edge.
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
    /// `changed` with how far it has gone, `ended` with how far it went (nothing when cancelled).
    struct HorizontalPan: UIGestureRecognizerRepresentable {
        let changed: (CGFloat) -> Void
        let ended: (CGFloat) -> Void

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
            case .ended: ended(translation)
            case .cancelled, .failed: ended(0)
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
