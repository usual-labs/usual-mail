import SwiftUI

/// What an icon means, in a small frosted label that comes a moment after the pointer rests on it (owner's direction
/// of 2026-11-18): under a tab, to the right of the rail, to the left of a Notifications row's seen tick. It replaces
/// the system's tooltip, which waits about a second.
/// It comes in a blur reveal and goes as soon as the pointer leaves. It is frosted rather than glass, so it doesn't
/// melt into the glass beside it. A nil text shows nothing, for a control that already says what it is (an open tab).
/// Inside a scrolling area (`hostsTooltips()`), which would cut it off, the area draws the label instead.
struct Tooltip: ViewModifier {
    let text: String?
    /// `.bottom`: under the control; `.trailing`: to its right; `.leading`: to its left.
    let edge: Edge
    @State private var hovering = false
    @State private var shown = false
    @Environment(\.tooltipsHosted) private var hosted

    /// How long the pointer rests before the label comes.
    static let delay: Duration = .milliseconds(350)

    func body(content: Content) -> some View {
        let showing = shown || LaunchOptions.current.showsTooltips
        content
            .onHover { hovering = $0 }
            .overlay(alignment: alignment) {
                if !hosted, let text, showing {
                    TooltipLabel(text: text)
                        .hanging(from: edge)
                        .allowsHitTesting(false)
                        .transition(.blurReveal)
                }
            }
            .anchorPreference(key: HostedTooltip.Key.self, value: .bounds) { bounds in
                guard hosted, let text, showing else { return [] }
                return [HostedTooltip(text: text, edge: edge, bounds: bounds)]
            }
            .task(id: hovering && text != nil) {
                guard hovering, text != nil else {
                    withAnimation(Motion.leave) { shown = false }
                    return
                }
                try? await Task.sleep(for: Self.delay)
                guard !Task.isCancelled else { return }
                withAnimation(Motion.reveal) { shown = true }
            }
    }

    /// The control's edge the label hangs from.
    private var alignment: Alignment {
        switch edge {
        case .bottom: .bottom
        case .leading: .leading
        default: .trailing
        }
    }
}

/// A tooltip a scrolling area draws for one of its controls: what it says, and the control's place.
struct HostedTooltip: Identifiable {
    let text: String
    let edge: Edge
    let bounds: Anchor<CGRect>

    var id: String { text }

    struct Key: PreferenceKey {
        static var defaultValue: [HostedTooltip] { [] }

        static func reduce(value: inout [HostedTooltip], nextValue: () -> [HostedTooltip]) {
            value += nextValue()
        }
    }

    /// Where the label's frame of no size sits: the middle of the control's bottom, of its right side, or of its left.
    func point(in frame: CGRect) -> CGPoint {
        switch edge {
        case .bottom: CGPoint(x: frame.midX, y: frame.maxY)
        case .leading: CGPoint(x: frame.minX, y: frame.midY)
        default: CGPoint(x: frame.maxX, y: frame.midY)
        }
    }
}

extension EnvironmentValues {
    /// Inside a scrolling area that draws its controls' tooltips (`hostsTooltips()`).
    @Entry var tooltipsHosted = false
}

private struct TooltipLabel: View {
    let text: String

    /// Hung from a frame of no height (or width) at the control's edge: it sits outside the control whatever its own
    /// size.
    @ViewBuilder func hanging(from edge: Edge) -> some View {
        switch edge {
        case .bottom:
            padding(.top, 6)
                .frame(height: 0, alignment: .top)
        case .leading:
            padding(.trailing, 8)
                .frame(width: 0, alignment: .trailing)
        default:
            padding(.leading, 8)
                .frame(width: 0, alignment: .leading)
        }
    }

    var body: some View {
        Text(verbatim: text)
            .font(Theme.sans(10))
            .foregroundStyle(Theme.ink)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Theme.card, in: Capsule())
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().stroke(Theme.hairline.opacity(0.6), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
            .accessibilityHidden(true)
    }
}

extension View {
    /// Says what an icon-only control is, under it or to its right, once the pointer rests on it. Use in place of
    /// `.help`, and keep an accessibility label.
    func tooltip(_ text: String?, edge: Edge = .bottom) -> some View {
        modifier(Tooltip(text: text, edge: edge))
    }

    /// For a scrolling area, which cuts off whatever hangs outside it: its controls' tooltips are drawn over the area
    /// instead, at each control's edge, so they show beside it as anywhere else.
    func hostsTooltips() -> some View {
        environment(\.tooltipsHosted, true)
            .overlayPreferenceValue(HostedTooltip.Key.self) { tooltips in
                GeometryReader { proxy in
                    ForEach(tooltips) { tooltip in
                        TooltipLabel(text: tooltip.text)
                            .hanging(from: tooltip.edge)
                            .position(tooltip.point(in: proxy[tooltip.bounds]))
                            .transition(.blurReveal)
                    }
                }
                .allowsHitTesting(false)
            }
    }
}
