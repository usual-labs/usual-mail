import SwiftUI
import UsualMailKit

/// The app's root: pairing until the device is paired, then the mail (the Mac's window, or the iPhone's).
public struct RootView: View {
    let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    public var body: some View {
        switch session.state {
        case .starting:
            Wallpaper()
        case .unpaired:
            PairingView(session: session)
        case .paired(let store):
            #if os(macOS)
                MailWindow(session: session)
                    .environment(store)
                    .id(ObjectIdentifier(store))
            #else
                PhoneWindow(session: session)
                    .environment(store)
                    .id(ObjectIdentifier(store))
            #endif
        }
    }
}
