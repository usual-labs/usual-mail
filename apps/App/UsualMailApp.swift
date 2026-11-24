import SwiftUI
import UsualMailKit
import UsualMailUI

@main
struct UsualMailApp: App {
    @State private var session = AppSession(
        credentials: KeychainCredentialStore(), deviceName: Host.current().localizedName ?? "Mac")

    init() {
        // Geist Serif, Geist Sans and Prociono come with the design package; register them before anything draws.
        Theme.registerFonts()
    }

    var body: some Scene {
        // One window: it holds the live connection to the server, and a second would open another.
        Window("Usual Mail", id: "main") {
            Group {
                #if DEBUG
                    if LaunchOptions.current.sample {
                        SampleMailView(session: sampleSession)
                    } else {
                        mail.task { await LaunchOptions.current.pairIfAsked(session) }
                    }
                #else
                    mail
                #endif
            }
            .frame(minWidth: 820, minHeight: 560)
            .launchSize()
            // The design is light glass over a light wallpaper; a dark version comes later.
            .preferredColorScheme(.light)
        }
        .windowStyle(.hiddenTitleBar)
        .windowBackgroundDragBehavior(.enabled)
        // The design's frame is a 14-inch MacBook Pro's window, 1512 × 982.
        .defaultSize(width: 1512, height: 982)
        .windowResizability(.contentMinSize)
    }

    /// Pairing until the Mac is paired, then the mail.
    private var mail: some View {
        RootView(session: session)
            .onAppear { session.restore() }
    }

    #if DEBUG
        /// A session that is never paired, for the sample (`-UsualMailSample YES`).
        @State private var sampleSession = AppSession(
            credentials: MemoryCredentialStore(), databaseDirectory: nil, deviceName: "Sample", listens: false)
    #endif
}
