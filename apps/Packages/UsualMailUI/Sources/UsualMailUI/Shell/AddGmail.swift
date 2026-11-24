import SwiftUI
import UsualMailKit

#if os(macOS)
    /// The switch's plus: adds another Gmail account with the same Sign in with Google step as Settings' "Add Gmail…" and
    /// onboarding's "Add another Gmail" (`GoogleSignInStep`, which runs `GoogleSignInFlow` with this Mac's own token and
    /// refreshes the store once an inbox connects, so the new inbox joins the switch without a relaunch). The chosen
    /// profile stays as it was, as after Settings' "Add Gmail…".
    ///
    /// In a sheet, not a popover: the step follows the sign-in only while it is on screen (it stops when it disappears),
    /// and a popover on the Mac closes as soon as the person goes to another app, here the browser that Google's page
    /// brings forward, so the step would be gone before it could say how the sign-in ended. A sheet stays on the window
    /// while the person is at Google.
    struct AddGmailButton: View {
        @Environment(MailStore.self) private var store
        @Environment(\.railLook) private var look
        @Environment(\.windowSize) private var window
        @State private var isOpen = false

        /// Its name, beside it while the rail is open, and under the pointer while it is narrow.
        static let help = AddGmailSheet.title

        /// What the plus says under the pointer: nothing while its sheet is open, as an open menu's button says nothing,
        /// nor while the rail is open and names it.
        static func tooltip(isOpen: Bool, railOpen: Bool = false) -> String? {
            isOpen || railOpen ? nil : help
        }

        var body: some View {
            Button {
                isOpen = true
            } label: {
                ProfileIcon(icon: .add, selected: false, name: Self.help)
            }
            .buttonStyle(PlainControlStyle())
            .tooltip(Self.tooltip(isOpen: isOpen, railOpen: look.isOpen), edge: .trailing)
            .accessibilityLabel(Self.help)
            .sheet(isPresented: $isOpen) {
                AddGmailSheet { isOpen = false }
                    .environment(store)
                    .environment(\.windowSize, window)
            }
        }
    }
#endif

/// The plus's sheet: its title, the shared step, which opens Google's page at once, the note that another address must
/// be a test user, and Done. The step says how it stands; Done closes the sheet whenever the person likes, which stops
/// waiting (a sign-in finished at Google afterwards still connects on the server, and its inbox still comes to the
/// switch by the server's `inbox.changed`).
struct AddGmailSheet: View {
    let done: () -> Void
    /// The window the sheet is on, so it never grows taller than it (the presenter passes it on).
    @Environment(\.windowSize) private var window

    static let title = "Add a Gmail account"

    /// The most a sheet takes of its window's height: all of it but a margin, so a long set-up scrolls inside rather
    /// than running past the window. No limit while the window is unknown.
    static func maxHeight(window: CGSize) -> CGFloat? {
        window.height > 0 ? window.height - 48 : nil
    }

    /// The step for a new inbox, at once: the person already asked by clicking the plus, as with Settings' "Add Gmail…".
    /// No name, colour or icon is sent, so the server picks them; the switch draws its icon (`Icon(inbox.icon)`).
    static var step: GoogleSignInStep {
        GoogleSignInStep(startsAtOnce: true)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            StepTitle(Self.title)
            Self.step
            StepText(GmailStep.testUser, size: 10, color: Theme.time)
            HStack {
                Spacer(minLength: 0)
                Button(action: done) {
                    LightButtonLabel(title: "Done")
                }
                .buttonStyle(PlainControlStyle())
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        #if os(macOS)
            .frame(width: 380, alignment: .leading)
        #else
            .frame(maxWidth: .infinity, alignment: .leading)
        #endif
        .frame(maxHeight: Self.maxHeight(window: window))
    }
}
