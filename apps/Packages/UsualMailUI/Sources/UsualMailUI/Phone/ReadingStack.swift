import CoreGraphics
import SwiftUI

/// How a swipe in from the screen's left edge on the iPhone's mail page goes (`ReadingStack`), kept apart from the view
/// so it is tested: the page follows the finger, never left of where it sits, and letting go goes back when the page has
/// gone past `share` of the width, or when the finger's speed carries it there (`projection`), as iOS's own back swipe
/// judges it; a flick back toward the edge stays.
enum EdgeBack {
    static let share: CGFloat = 0.35
    static let projection: CGFloat = 0.15
    /// How far the list under the page starts to its left, as a share of the width, as iOS's list under a page does.
    static let parallax: CGFloat = 0.3

    /// How near the screen's left edge a swipe must start, in points.
    static let edge: CGFloat = 30

    /// Whether a pan begins a swipe back: it started within `edge` of the screen's left edge (`start`, in the
    /// window's points) and moves rightward more than up or down.
    static func starts(at start: CGFloat, velocity: CGPoint) -> Bool {
        start <= edge && velocity.x > 0 && velocity.x > abs(velocity.y)
    }

    /// Where the page is drawn for a finger `translation` from where it began.
    static func offset(for translation: CGFloat) -> CGFloat {
        max(0, translation)
    }

    /// Whether letting go goes back.
    static func commits(translation: CGFloat, velocity: CGFloat, width: CGFloat) -> Bool {
        guard translation > 0, velocity >= 0 || translation >= width * 0.5 else { return false }
        return translation + velocity * projection >= width * share
    }
}

#if os(iOS)
    import UIKit

    /// On the iPhone, a list and the mail opened from it (owner's words of 2026-11-26: "slide from left to right from
    /// left of screen should act as back button like native ios gesture"). The list stays under the page, out of sight
    /// and untouchable, so a swipe in from the screen's left edge (`EdgePan`) shows it: the page follows the finger
    /// with a shadow at its edge, the list coming in from a little to its left, dimmed until the page has gone. Let go
    /// far enough or fast enough (`EdgeBack`), the page carries on off the card and the mail closes (`back`, with no
    /// animation of its own then, so the page doesn't come back to fade); short of it, the page goes back. VoiceOver's
    /// escape goes back too. Coming back to the list finds it where it was.
    struct ReadingStack<List: View>: View {
        let reading: String?
        /// Closes the mail (`Navigation.back`), unanimated.
        let back: @MainActor () -> Void
        @ViewBuilder var list: List
        @State private var drag: CGFloat = 0
        /// Set while the swipe carries the page off, so it leaves without the hand-over's fade.
        @State private var leaving = false

        var body: some View {
            GeometryReader { geometry in
                let width = max(1, geometry.size.width)
                let progress = min(1, drag / width)
                ZStack {
                    list
                        .offset(x: reading == nil ? 0 : -(1 - progress) * width * EdgeBack.parallax)
                        .opacity(reading == nil ? 1 : drag > 0 ? 0.6 + 0.4 * progress : 0)
                        .allowsHitTesting(reading == nil)
                        .accessibilityHidden(reading != nil)
                    if let reading {
                        ReadingView(threadID: reading)
                            .background {
                                if drag > 0 {
                                    Rectangle()
                                        .fill(Self.ground)
                                        .shadow(color: .black.opacity(0.14 * (1 - progress)), radius: 10, x: -3)
                                        .ignoresSafeArea(edges: .bottom)
                                }
                            }
                            .offset(x: drag)
                            .gesture(
                                EdgePan { translation in
                                    drag = EdgeBack.offset(for: translation)
                                } ended: { translation, velocity in
                                    finish(translation: translation, velocity: velocity, width: width)
                                }
                            )
                            .accessibilityAction(.escape) { withAnimation(Motion.move) { back() } }
                            .transition(leaving ? .identity : .handOver)
                    }
                }
                .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top)
            }
            .onChange(of: reading) { _, opened in
                drag = 0
                leaving = false
                // Search's field stays under the mail now, so its keyboard is put away rather than left over the mail.
                if opened != nil {
                    UIApplication.shared.sendAction(
                        #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                }
            }
        }

        /// The card's ground without the wallpaper through it, under the page while it moves so the list doesn't
        /// show through.
        private static var ground: Color { Color(red: 247 / 255, green: 247 / 255, blue: 247 / 255) }

        private func finish(translation: CGFloat, velocity: CGFloat, width: CGFloat) {
            guard EdgeBack.commits(translation: translation, velocity: velocity, width: width) else {
                withAnimation(Motion.move) { drag = 0 }
                return
            }
            leaving = true
            withAnimation(.easeOut(duration: 0.22)) {
                drag = width
            } completion: {
                var quiet = Transaction()
                quiet.disablesAnimations = true
                withTransaction(quiet) { back() }
            }
        }
    }

    /// A pan that starts only near the screen's left edge, moving right (`EdgeBack.starts`), before any other pan
    /// under it (the mail's own scrolling waits for it to fail), as iOS's back swipe does: `changed` with how far it has
    /// gone, `ended` with how far it went and how fast it was moving (nothing when cancelled). A plain pan rather than
    /// the system's edge pan, whose start the simulator's injected touches never make.
    struct EdgePan: UIGestureRecognizerRepresentable {
        let changed: (CGFloat) -> Void
        let ended: (CGFloat, CGFloat) -> Void

        func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

        func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
            let pan = UIPanGestureRecognizer()
            pan.delegate = context.coordinator
            return pan
        }

        func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
            let translation = recognizer.translation(in: nil).x
            switch recognizer.state {
            case .changed: changed(translation)
            case .ended: ended(translation, recognizer.velocity(in: nil).x)
            case .cancelled, .failed: ended(0, 0)
            default: break
            }
        }

        final class Coordinator: NSObject, UIGestureRecognizerDelegate {
            func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
                guard let pan = recognizer as? UIPanGestureRecognizer else { return false }
                // In the window's points: where the finger is, less how far it has come, is where it started.
                let start = pan.location(in: nil).x - pan.translation(in: nil).x
                return EdgeBack.starts(at: start, velocity: pan.velocity(in: nil))
            }

            func gestureRecognizer(
                _ recognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer
            ) -> Bool {
                other is UIPanGestureRecognizer
            }
        }
    }
#endif
