#if os(iOS)
    import SwiftUI

    /// On the iPhone, Settings' choice of what swiping a mail on Home does, each way (`SwipeAction`; the owner's words
    /// of 2026-11-25, "these settings should be changable in settings"), a section of the Appearance tab: a row a way,
    /// the system's menu at its right. Kept on this iPhone.
    struct SwipeSettings: View {
        @AppStorage(SwipeAction.leftKey) private var left = SwipeAction.leftDefault
        @AppStorage(SwipeAction.rightKey) private var right = SwipeAction.rightDefault

        var body: some View {
            SettingsView.group(
                "Swiping a mail", footer: ["What a swipe on a mail on Home does. The choice stays on this iPhone."]
            ) {
                choice("Swipe left", $left)
                choice("Swipe right", $right)
            }
        }

        private func choice(_ title: String, _ action: Binding<SwipeAction>) -> some View {
            Picker(selection: action) {
                ForEach(SwipeAction.allCases) { option in
                    Text(verbatim: option.title).tag(option)
                }
            } label: {
                Text(verbatim: title)
                    .foregroundStyle(Theme.ink)
            }
            .pickerStyle(.menu)
            .tint(Theme.secondary)
        }
    }
#endif
