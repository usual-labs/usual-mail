import SwiftUI
import UsualMailKit

/// Settings' AI tab: the service the server's AI reaches and each job's model (`AISettingsRows`), how it stands and how
/// much it still has to do, then what it used (`AIUsageSection`), asked for while the tab shows. It doesn't set the AI
/// key; if it ever does, it must first show the server's disclosure, as onboarding does.
struct AITab: View {
    @Environment(MailStore.self) private var store

    var body: some View {
        SettingsView.page {
            if let settings = store.aiSettings {
                SettingsView.group("Service") {
                    AISettingsRows(settings: settings)
                }
            }
            if let status = store.aiStatus {
                SettingsView.group("State") {
                    SettingsView.words(SettingsView.aiWords(status))
                }
            }
            if store.aiSettings == nil, store.aiStatus == nil, store.aiUsage == nil {
                SettingsView.words("Your server hasn't told this Mac about its AI yet.")
            }
            AIUsageSection()
        }
        .animation(Motion.reveal, value: store.aiUsage == nil)
        .fetchesAiUsage()
    }
}
