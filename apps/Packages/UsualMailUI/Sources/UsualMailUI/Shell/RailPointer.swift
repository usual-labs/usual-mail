#if os(macOS)
    import AppKit
    import SwiftUI

    /// Whether the pointer is over the rail, read from the window when asked (`RailOpening.findPointer`): the rail's hover
    /// isn't reported while mail is dragged, so when a drag ends the rail asks this where the pointer really is.
    @MainActor
    final class RailPointer {
        fileprivate weak var view: NSView?

        /// The pointer is over the rail's column now; false while the rail isn't in a window.
        var isOnRail: Bool {
            guard let view, let window = view.window else { return false }
            return view.bounds.contains(view.convert(window.mouseLocationOutsideOfEventStream, from: nil))
        }
    }

    /// The rail's column as the window has it, for `RailPointer`, behind the rail: it draws nothing and takes no clicks,
    /// hover or drops, which go to the rail as before.
    struct RailPointerArea: NSViewRepresentable {
        let pointer: RailPointer

        func makeNSView(context: Context) -> NSView {
            let view = PassThrough()
            pointer.view = view
            return view
        }

        func updateNSView(_ view: NSView, context: Context) {
            pointer.view = view
        }

        private final class PassThrough: NSView {
            override func hitTest(_ point: NSPoint) -> NSView? { nil }
        }
    }
#endif
