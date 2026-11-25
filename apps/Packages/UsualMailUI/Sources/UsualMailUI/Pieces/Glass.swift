import SwiftUI

extension EnvironmentValues {
    /// True while the pointer is over the enabled button this view is the label of (`PlainControlStyle`), so the label
    /// can answer it: glass a little brighter, a row softly highlighted, an icon darker.
    @Entry var isControlHovered = false
}

/// Whether the device has a pointer that can rest on things, as the Mac does. Without one (the iPhone), what the Mac
/// shows only under the pointer (a row's time, a seen row's tick) shows always.
enum Pointer {
    #if os(macOS)
        static let exists = true
    #else
        static let exists = false
    #endif
}

/// The glass controls' measures: on the Mac the design's 32 points high, 16-point icons and 12-point words, 14 from a
/// capsule's ends, 10 between capsules. On the iPhone larger, for a finger (the owner's words of 2026-11-25: "make the
/// header liquid glass controls size bigger", "make the bottom glass tabs and controls bigger"): 44 points, the least
/// Apple asks for a touch, 20-point icons, 14-point words, 12 from the ends (so an icon's capsule is round), 8 between.
enum ControlSize {
    #if os(iOS)
        static let height: CGFloat = 44
        static let icon: CGFloat = 20
        static let text: CGFloat = 14
        static let inset: CGFloat = 12
        static let spacing: CGFloat = 8
    #else
        static let height: CGFloat = 32
        static let icon: CGFloat = 16
        static let text: CGFloat = 12
        static let inset: CGFloat = 14
        static let spacing: CGFloat = 10
    #endif
}

/// The design's controls on the wallpaper: `ControlSize.height` high, round, of Liquid Glass. A selected one is tinted with the
/// design's white at 30%. A lit one is chosen, as the rail's current button is: white at `RailLook.lit` under clear
/// glass, so "chosen" looks one way across the app (the chosen tab in the top row, and a mail page button whose action
/// the mail already has: it is pinned, waits to be replied to, is snoozed or is done); its glass stays clear, as a tint
/// on one glass of a container lightens the others with it (`RailChosenTests`, `TabChosenTests`, `BarChosenTests`).
/// Under the pointer the glass brightens: a clear one, lit or not, takes a hint of white, a tinted one more. Glass that
/// is no button (the title capsule of To reply, Pinned, Snoozed and the Inbox page) isn't `interactive`: it doesn't
/// answer a press.
struct GlassControl: ViewModifier {
    var selected = false
    var lit = false
    var interactive = true
    /// Its least width and height: `ControlSize.height`, or a grid's own cell.
    var side = ControlSize.height
    @Environment(\.isControlHovered) private var hovered

    func body(content: Content) -> some View {
        content
            .frame(minWidth: side, minHeight: side)
            // Always there, so lighting a capsule or putting it out fades on the bar's spring.
            .background(Color.white.opacity(lit ? RailLook.lit : 0), in: Capsule())
            .contentShape(Capsule())
            .glassEffect(
                Self.glass(selected: selected, hovered: hovered).interactive(interactive), in: Capsule()
            )
    }

    static func glass(selected: Bool, hovered: Bool) -> Glass {
        switch (selected, hovered) {
        case (true, false): .regular.tint(Theme.control).interactive()
        case (true, true): .regular.tint(Theme.controlHovered).interactive()
        case (false, false): .clear.interactive()
        case (false, true): .clear.tint(Theme.controlHint).interactive()
        }
    }
}

extension View {
    func glassControl(
        selected: Bool = false, lit: Bool = false, interactive: Bool = true, side: CGFloat = ControlSize.height
    ) -> some View {
        modifier(GlassControl(selected: selected, lit: lit, interactive: interactive, side: side))
    }

    /// The pointing hand over something clickable that isn't a `PlainControlStyle` button (link-style and system
    /// buttons).
    func pointer() -> some View {
        #if os(macOS)
            pointerStyle(.link)
        #else
            self
        #endif
    }

    /// A button drawn as a link in a page's text: the Mac's link style, the iPhone's borderless one.
    func linkStyle() -> some View {
        #if os(macOS)
            buttonStyle(.link)
        #else
            buttonStyle(.borderless)
        #endif
    }

    /// A soft rounded highlight behind a row while the pointer is over it. For a button's label; it reaches a little
    /// past the row's edges, so nothing moves.
    func rowHover() -> some View {
        modifier(RowHover())
    }
}

private struct RowHover: ViewModifier {
    @Environment(\.isControlHovered) private var hovered

    func body(content: Content) -> some View {
        content.background {
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.black.opacity(hovered ? 0.035 : 0))
                .padding(-8)
        }
    }
}

/// A button that only shows its label: the glass around it is the control. While it can be pressed it shows the
/// pointing hand, and tells its label when the pointer is over it (`isControlHovered`).
struct PlainControlStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        PlainControl(configuration: configuration)
    }
}

private struct PlainControl: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
        configuration.label
            .environment(\.isControlHovered, enabled && hovering)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .onHover { hovering = $0 }
            #if os(macOS)
                .pointerStyle(enabled ? .link : nil)
            #endif
            .animation(.easeOut(duration: 0.15), value: hovering)
    }
}
