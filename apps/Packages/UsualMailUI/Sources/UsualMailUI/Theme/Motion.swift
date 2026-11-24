import SwiftUI

/// The app's motion: Apple's springs for anything that moves or changes size, and a blur reveal for anything that
/// appears. Under Reduce Motion, things only fade.
enum Motion {
    /// Switching tabs and places, opening and closing a mail: a spring that settles without a wobble.
    static let move = Animation.spring(duration: 0.42, bounce: 0.12)
    /// Something appearing: it comes into focus as it fades in.
    static let reveal = Animation.smooth(duration: 0.4)
    /// Something leaving, quicker than it came.
    static let leave = Animation.easeOut(duration: 0.18)
    /// How far apart a list's items start appearing, and the longest any item waits.
    static let stagger = 0.035
    static let longestWait = 0.3

    /// The wait before a list's item at `index` appears.
    static func delay(at index: Int) -> Double {
        min(Double(index) * stagger, longestWait)
    }

    /// Glass coming or going: a spring with a little more give, so it pops.
    static let pop = Animation.spring(duration: 0.38, bounce: 0.3)

    /// The blur at the start of a reveal, in points.
    static let blur: CGFloat = 10
}

/// A view at `progress` of a reveal: blurred and clear at 0, sharp and whole at 1.
struct BlurReveal: ViewModifier {
    let progress: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .blur(radius: reduceMotion ? 0 : Motion.blur * (1 - progress))
            .opacity(progress)
    }
}

extension AnyTransition {
    /// Comes into focus as it appears, goes out of focus a little faster as it leaves.
    static var blurReveal: AnyTransition {
        .asymmetric(
            insertion: .modifier(active: BlurReveal(progress: 0), identity: BlurReveal(progress: 1)),
            removal: .modifier(active: BlurReveal(progress: 0), identity: BlurReveal(progress: 1))
                .animation(Motion.leave))
    }

    /// Glass appearing as glass does: from small to full size, and back the same way when it goes. No blur.
    static var glassPop: AnyTransition {
        .scale(scale: 0.4).combined(with: .opacity).animation(Motion.pop)
    }

    /// For a screen that reveals its own parts: it only fades out as the next one comes.
    static var handOver: AnyTransition {
        .asymmetric(insertion: .identity, removal: .opacity.animation(Motion.leave))
    }
}

/// Reveals a view the first time it appears, after `delay`.
private struct RevealOnAppear: ViewModifier {
    let delay: Double
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .modifier(BlurReveal(progress: shown ? 1 : 0))
            .onAppear {
                withAnimation(Motion.reveal.delay(delay)) { shown = true }
            }
    }
}

extension View {
    /// Comes into focus when it appears, after `delay` (a list passes `Motion.delay(at:)`).
    func revealOnAppear(delay: Double = 0) -> some View {
        modifier(RevealOnAppear(delay: delay))
    }

    /// Comes into focus when `shown` turns true, and goes out of focus when it turns false, without changing layout.
    func reveal(_ shown: Bool) -> some View {
        modifier(BlurReveal(progress: shown ? 1 : 0))
            .animation(shown ? Motion.reveal : Motion.leave, value: shown)
    }
}
