import SwiftUI
import UsualMailDesign
import UsualMailKit

/// Settings: the page of the tab chosen in its row (`SettingsTab`): Accounts, AI, Appearance, Blocked or About. No page
/// carries a title of its own (its tab says it). Each is a form of sections (the owner's words of 2026-11-25: "the
/// settings pages are not structured both in mac and iphone ... no good data architecture"): a section's title over
/// its rows, each row a name at the left and its value or control at the right, and under the section a quiet line
/// where a setting needs one. The system draws the form each platform's way (`page`): on the Mac as System Settings
/// does, in grouped boxes; on the iPhone as an iPhone's settings are, inset rows a finger can press, with full-size
/// switches, menus and whole-row buttons (the owner's: "the buttons and controls in iphone should be mobile friendly
/// and should be different than mac os"). Each page starts at the top.
struct SettingsView: View {
    let session: AppSession
    let tab: SettingsTab
    /// The active profile, which the Blocked tab follows: nil, every inbox, as Settings is a stack of its own that no
    /// profile scopes.
    let inboxId: String?
    /// The Gmail inbox the Accounts tab signs in with Google again as it opens (`Navigation.accountsSignIn`).
    var accountsSignIn: String? = nil
    /// The Accounts tab took that sign-in (`Navigation.accountsSignInStarted`).
    var accountsSignInStarted: @MainActor () -> Void = {}

    var body: some View {
        page
            // The icon buttons' tooltips, drawn over the page so neither the rows below nor its edge cut them off.
            .hostsTooltips()
            .id(tab)
            .transition(.blurReveal)
            .revealOnAppear()
    }

    @ViewBuilder private var page: some View {
        switch tab {
        case .accounts: AccountsTab(session: session, signingIn: accountsSignIn, started: accountsSignInStarted)
        case .ai: AITab()
        case .appearance: AppearanceTab()
        case .blocked: BlockedTab(inboxId: inboxId)
        case .about: AboutTab()
        }
    }

    /// Whether the AI works, and how much it still has to do.
    static func aiWords(_ status: AiStatus) -> String {
        let state = status.state == .working ? "Working." : AIWords.sentence(for: status)
        return [state, AIWords.waiting(status.pending)].compactMap(\.self).joined(separator: " ")
    }

    /// A tab's page: its sections in a grouped form, on the card's own ground, scrolling.
    static func page(@ViewBuilder _ content: () -> some View) -> some View {
        Form { content() }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            .scrollIndicators(.never)
            .font(Theme.sans(SettingsType.body))
    }

    /// One section: its title (and `trailing` at the title's right, as the usage's period), its rows, and under them
    /// `footer`'s quiet lines.
    static func group(
        _ title: String?, trailing: some View = EmptyView(), footer: [String] = [],
        @ViewBuilder _ content: () -> some View
    ) -> some View {
        Section {
            content()
        } header: {
            if let title {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(verbatim: title)
                        .font(Theme.sans(SettingsType.header, weight: .semibold))
                        .foregroundStyle(SettingsType.headerInk)
                        .textCase(nil)
                    Spacer(minLength: 0)
                    trailing
                }
            }
        } footer: {
            if !footer.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(footer, id: \.self) { note($0) }
                }
            }
        }
    }

    /// A row of a name and its value: the name in ink at the left, the value in grey at the right, selectable.
    static func row(_ name: String, value: String) -> some View {
        LabeledContent {
            Text(verbatim: value)
                .foregroundStyle(Theme.secondary)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        } label: {
            Text(verbatim: name)
                .foregroundStyle(Theme.ink)
        }
    }

    /// A row's action: a whole row on the iPhone, in the tint or red for a `destructive` one; the Mac's button.
    static func action(
        _ title: String, icon: String? = nil, destructive: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(role: destructive ? .destructive : nil, action: action) {
            if let icon {
                Label(title, systemImage: icon)
            } else {
                Text(verbatim: title)
            }
        }
        .pointer()
    }

    /// Words in a row, in grey.
    static func words(_ text: String) -> some View {
        Text(verbatim: text)
            .font(Theme.sans(SettingsType.body))
            .foregroundStyle(Theme.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// One quiet line of explanation, in the time colour.
    static func note(_ text: String) -> some View {
        Text(verbatim: text)
            .font(Theme.sans(SettingsType.note))
            .foregroundStyle(Theme.time)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Words saying why something was refused, in red.
    static func refusal(_ text: String) -> some View {
        Text(verbatim: text)
            .font(Theme.sans(SettingsType.note))
            .foregroundStyle(UsualColor.danger)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// A link-style button in a row's text.
    static func link(_ title: String, size: CGFloat = SettingsType.body, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .linkStyle()
            .pointer()
            .font(Theme.sans(size))
    }
}

/// Settings' type: on the Mac the app's 12 points, notes 10, titles 12 in ink; on the iPhone a phone's reading sizes,
/// rows 15, notes and titles 13, titles in grey as an iPhone's section titles are.
enum SettingsType {
    #if os(iOS)
        static let body: CGFloat = 15
        static let note: CGFloat = 13
        static let header: CGFloat = 13
        static let headerInk = Theme.secondary
    #else
        static let body: CGFloat = 12
        static let note: CGFloat = 10
        static let header: CGFloat = 12
        static let headerInk = Theme.ink
    #endif
}
