import Foundation

#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

/// Opening a web address outside the app, in the person's browser.
enum Links {
    @MainActor
    static func open(_ url: URL) {
        #if os(macOS)
            NSWorkspace.shared.open(url)
        #else
            UIApplication.shared.open(url)
        #endif
    }
}
