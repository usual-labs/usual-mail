import SwiftUI
import UsualMailDesign
import UsualMailKit

/// Settings: the page of the tab chosen at the top right (`SettingsTab`): Accounts, AI, Appearance, Blocked or About.
/// No page carries a title of its own (its tab says it); each is groups with a title, rows, and a quiet line of
/// explanation where a setting needs one. Each page starts at the top.
struct SettingsView: View {
    let session: AppSession
    let tab: SettingsTab
    /// The active profile, which the Blocked tab follows: nil, every inbox, as Settings is a stack of its own that no
    /// profile scopes.
    let inboxId: String?

    var body: some View {
        ScrollView {
            page
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.page)
        }
        .scrollIndicators(.never)
        // The icon buttons' tooltips, drawn over the page so neither the rows below nor its edge cut them off.
        .hostsTooltips()
        .id(tab)
        .transition(.blurReveal)
        .revealOnAppear()
    }

    @ViewBuilder private var page: some View {
        switch tab {
        case .accounts: AccountsTab(session: session)
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

    /// A tab's groups, 20 apart.
    static func page(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 20) { content() }
    }

    /// A titled group of Settings, with `trailing` at the title's right (the usage's period switch).
    static func group(
        _ title: String, trailing: some View = EmptyView(), @ViewBuilder _ content: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(title)
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.ink)
                Spacer(minLength: 0)
                trailing
            }
            content()
        }
    }

    static func words(_ text: String) -> some View {
        Text(verbatim: text)
            .font(Theme.sans(12))
            .foregroundStyle(Theme.secondary)
    }

    /// One quiet line of explanation under a setting, in the time colour.
    static func note(_ text: String) -> some View {
        Text(verbatim: text)
            .font(Theme.sans(10))
            .foregroundStyle(Theme.time)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Words saying why something was refused, in red.
    static func refusal(_ text: String) -> some View {
        Text(verbatim: text)
            .font(Theme.sans(10))
            .foregroundStyle(UsualColor.danger)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// A link-style button in the page's text.
    static func link(_ title: String, size: CGFloat = 12, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .linkStyle()
            .pointer()
            .font(Theme.sans(size))
    }
}
