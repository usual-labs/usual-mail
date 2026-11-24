import SwiftUI

/// A duration, and what it becomes when the person asks for reduced motion (0 stops the movement).
public struct UsualDuration: Equatable, Sendable {
    public let seconds: Double
    public let reducedSeconds: Double

    public func seconds(reduceMotion: Bool) -> Double { reduceMotion ? reducedSeconds : seconds }
}

/// A cubic Bézier easing, as in CSS `cubic-bezier(x1, y1, x2, y2)`.
public struct UsualEasing: Equatable, Sendable {
    public let x1: Double
    public let y1: Double
    public let x2: Double
    public let y2: Double

    public init(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
        (self.x1, self.y1, self.x2, self.y2) = (x1, y1, x2, y2)
    }

    /// The animation for `duration`, or nil (no animation) when reduced motion turns it into 0.
    public func animation(_ duration: UsualDuration, reduceMotion: Bool) -> Animation? {
        let seconds = duration.seconds(reduceMotion: reduceMotion)
        return seconds > 0 ? .timingCurve(x1, y1, x2, y2, duration: seconds) : nil
    }
}

extension View {
    /// Animates changes to `value` with a Usual Mail duration and easing, and not at all for movement when the
    /// person asks for reduced motion. Fades (`UsualDuration.fade`) keep their duration.
    public func usualAnimation<Value: Equatable>(
        _ duration: UsualDuration, easing: UsualEasing = .standard, value: Value
    ) -> some View {
        modifier(UsualAnimationModifier(duration: duration, easing: easing, value: value))
    }
}

private struct UsualAnimationModifier<Value: Equatable>: ViewModifier {
    let duration: UsualDuration
    let easing: UsualEasing
    let value: Value
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.animation(easing.animation(duration, reduceMotion: reduceMotion), value: value)
    }
}
