import SwiftUI
import UIKit
import UsualMailKit
import UsualMailUI

/// The iPhone app: the same packages as the Mac app, in the iPhone's own shell (UsualMailUI's `PhoneWindow`).
@main
struct UsualMailPhoneApp: App {
    @State private var session = AppSession(
        credentials: KeychainCredentialStore(), deviceName: UIDevice.current.name)

    init() {
        // Geist Serif, Geist Sans and Prociono come with the design package; register them before anything draws.
        Theme.registerFonts()
    }

    var body: some Scene {
        WindowGroup {
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
            // The design is light glass over a light wallpaper; a dark version comes later.
            .preferredColorScheme(.light)
        }
    }

    /// Pairing until the iPhone is paired, then the mail.
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
