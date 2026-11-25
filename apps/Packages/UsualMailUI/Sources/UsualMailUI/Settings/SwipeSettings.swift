#if os(iOS)
    import SwiftUI

    /// On the iPhone, Settings' choice of what swiping a mail on Home does, each way (`SwipeAction`; the owner's words
    /// of 2026-11-25, "these settings should be changable in settings"), in the Appearance tab: kept on this iPhone.
    struct SwipeSettings: View {
        @AppStorage(SwipeAction.leftKey) private var left = SwipeAction.leftDefault
        @AppStorage(SwipeAction.rightKey) private var right = SwipeAction.rightDefault

        var body: some View {
            SettingsView.group("Swiping a mail") {
                choice("Swipe left", $left)
                choice("Swipe right", $right)
                SettingsView.note("What a swipe on a mail on Home does. The choice stays on this iPhone.")
            }
        }

        /// One way's choice: its name, and the system's menu of what it can do.
        private func choice(_ title: String, _ action: Binding<SwipeAction>) -> some View {
            HStack(spacing: 12) {
                Text(verbatim: title)
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.secondary)
                Spacer(minLength: 0)
                Picker(title, selection: action) {
                    ForEach(SwipeAction.allCases) { option in
                        Text(verbatim: option.title).tag(option)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(Theme.ink)
            }
        }
    }
#endif
