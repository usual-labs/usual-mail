import Combine
import SwiftUI

#if os(macOS)
    import AppKit
#endif

/// Content that is as tall as itself wherever it is offered the room, and scrolls only when it isn't: in a stack with a
/// height (the first run's card) it takes its full height when that fits and shrinks to what is left otherwise, down to
/// `floor`; offered no height (a sheet, a scrolling page) it is as tall as its content, at most `cap`.
///
/// The scroll bar never sits on the content: the content keeps its width, and the scroll view reaches `gutter` points
/// into the margin on its right, where the bar shows. A bar that appears while scrolling floats over that gutter; a bar
/// that is always shown takes its own width there, which the scroll view sets aside by itself, so the gutter is then
/// only what is left of it. While everything fits there is no bar at all. While more lies above or below, that edge
/// fades, so something cut by it reads as going on.
struct FittedScroll<Content: View>: View {
    var cap: CGFloat = .infinity
    var floor: CGFloat = 80
    var gutter: CGFloat = FittedScrollMetrics.gutter
    @ViewBuilder var content: Content
    @State private var edges = ScrollEdges()
    /// The width an always-shown bar takes, followed as the person's setting or their mouse changes it.
    @State private var fixedBar = FittedScrollMetrics.fixedBar

    var body: some View {
        FittedLayout(cap: cap, floor: floor) {
            ScrollView {
                content
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(
                        .trailing, FittedScrollMetrics.padding(gutter: gutter, fits: edges.fits, fixedBar: fixedBar))
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(edges.fits ? .never : .automatic)
            .onScrollGeometryChange(for: ScrollEdges.self) {
                ScrollEdges(content: $0.contentSize.height, visible: $0.visibleRect)
            } action: { _, now in
                edges = now
            }
            .mask { EdgeFade(edges: edges, gutter: gutter) }
            .layoutMark(.viewport)
            .transformPreference(FittedScrollFits.self) { $0.append(edges.fits) }
        }
        .padding(.trailing, -gutter)
        #if os(macOS)
            .onReceive(
                NotificationCenter.default.publisher(for: NSScroller.preferredScrollerStyleDidChangeNotification)
            ) {
                _ in fixedBar = FittedScrollMetrics.fixedBar
            }
        #endif
    }
}

enum FittedScrollMetrics {
    /// Room for the scroll bar beside the content, taken from the margin on its right: as wide as a bar that is always
    /// shown (17 points on the Mac; the card's margin is 24), so the content is as wide with that bar as without it.
    @MainActor
    static var gutter: CGFloat {
        #if os(macOS)
            NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy)
        #else
            12
        #endif
    }
    /// How far an edge with more beyond it fades.
    static let fade: CGFloat = 24

    /// The width a scroll bar that is always shown takes beside the content (the scroll view sets it aside itself);
    /// zero where bars appear only while scrolling, over the content's edge.
    @MainActor
    static var fixedBar: CGFloat {
        #if os(macOS)
            NSScroller.preferredScrollerStyle == .legacy
                ? NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy) : 0
        #else
            0
        #endif
    }

    /// The room kept on the content's right inside the scroll view: the whole gutter while it fits (no bar) or while a
    /// bar would float, less the width an always-shown bar already takes, so the content is as wide either way.
    static func padding(gutter: CGFloat, fits: Bool, fixedBar: CGFloat) -> CGFloat {
        fits ? gutter : max(gutter - fixedBar, 0)
    }
}

/// Sizes the scroll view: its own ideal height is its content's, so it is that, at most `cap`, and no more than it is
/// offered, though never less than `floor` (or its content, if smaller).
struct FittedLayout: Layout {
    let cap: CGFloat
    let floor: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let scroll = subviews.first else { return .zero }
        let natural = scroll.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
        let height = Self.height(natural: natural.height, offered: proposal.height, cap: cap, floor: floor)
        return CGSize(width: proposal.width ?? natural.width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }

    /// The content's height, at most `cap` and what is offered, at least `floor` unless the content is smaller.
    static func height(natural: CGFloat, offered: CGFloat?, cap: CGFloat, floor: CGFloat) -> CGFloat {
        let wanted = min(natural, cap)
        guard let offered, offered.isFinite else { return wanted }
        return max(min(wanted, offered), min(wanted, floor))
    }
}

/// Whether the content fits, and whether more lies above or below what shows.
struct ScrollEdges: Equatable, Sendable {
    var fits = true
    var moreAbove = false
    var moreBelow = false

    init() {}

    init(content: CGFloat, visible: CGRect) {
        fits = content <= visible.height + 0.5
        moreAbove = !fits && visible.minY > 0.5
        moreBelow = !fits && visible.maxY < content - 0.5
    }
}

/// The scroll view's mask: whole, but fading at an edge with more beyond it; the bar's gutter is never faded.
private struct EdgeFade: View {
    let edges: ScrollEdges
    let gutter: CGFloat

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                fade(from: edges.moreAbove ? 0 : 1, to: 1)
                Rectangle()
                fade(from: 1, to: edges.moreBelow ? 0 : 1)
            }
            Rectangle().frame(width: gutter)
        }
        .animation(.easeOut(duration: 0.15), value: edges)
    }

    private func fade(from: Double, to: Double) -> some View {
        LinearGradient(
            colors: [.black.opacity(from), .black.opacity(to)], startPoint: .top, endPoint: .bottom
        )
        .frame(height: FittedScrollMetrics.fade)
    }
}

/// Whether each `FittedScroll` inside fits its content, for a screen (or a test) that wants to know.
struct FittedScrollFits: PreferenceKey {
    static let defaultValue: [Bool] = []

    static func reduce(value: inout [Bool], nextValue: () -> [Bool]) {
        value += nextValue()
    }
}

/// Where a few pieces of a screen end up, by name: the first run's card, a fitted scroll's viewport, the Google
/// set-up's file section, its drop area and its note, and the agent's row with "Copy the prompt". Nothing in the app
/// reads them; the layout tests resolve them to check that the card keeps its margin and that what should show is
/// inside what shows.
struct LayoutMarks: PreferenceKey {
    static var defaultValue: [LayoutMark: Anchor<CGRect>] { [:] }

    static func reduce(value: inout [LayoutMark: Anchor<CGRect>], nextValue: () -> [LayoutMark: Anchor<CGRect>]) {
        value.merge(nextValue()) { _, new in new }
    }
}

enum LayoutMark: Hashable, Sendable {
    case card, viewport, file, drop, fileNote, promptActions
}

extension View {
    /// Marks this view's bounds under `name` (`LayoutMarks`), beside the marks inside it.
    func layoutMark(_ name: LayoutMark) -> some View {
        transformAnchorPreference(key: LayoutMarks.self, value: .bounds) { marks, bounds in marks[name] = bounds }
    }
}
