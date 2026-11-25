import SwiftUI
import UsualMailKit

/// Settings' AI tab, in sections: Service, the service the server's AI reaches and each job's model (`AISettingsRows`);
/// Status, how it stands and how much it still has to do; then Usage, what it used (`AIUsageSection`), asked for while
/// the tab shows. It doesn't set the AI
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
                SettingsView.group("Status") {
                    SettingsView.words(SettingsView.aiWords(status))
                }
            }
            if store.aiSettings == nil, store.aiStatus == nil, store.aiUsage == nil {
                SettingsView.group(nil) {
                    SettingsView.words("Your server hasn't told \(SettingsWords.device) about its AI yet.")
                }
            }
            AIUsageSection()
        }
        .animation(Motion.reveal, value: store.aiUsage == nil)
        .fetchesAiUsage()
    }
}
