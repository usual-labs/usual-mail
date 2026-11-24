import Combine
import SwiftUI

#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

extension View {
    /// Runs `action` each time the app comes back to the front (the Mac app activated again, the iPhone app back from
    /// the background), for a screen that should ask its server again for something that may have changed elsewhere.
    func onAppBecomesActive(_ action: @escaping @MainActor () -> Void) -> some View {
        #if os(macOS)
            onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                action()
            }
        #else
            onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                action()
            }
        #endif
    }
}
