#if os(iOS)
    import SwiftUI

    /// On the iPhone, Settings' choice of what swiping does on Home, Notifications and the Feed, each way
    /// (`SwipeList`, `SwipeAction`; the owner's words of 2026-11-25, "these settings should be changable in settings",
    /// and of 2026-11-27, "they need to be changeable into the settings"): a section of the Appearance tab per list, a
    /// row a way, the system's menu at its right. Kept on this iPhone.
    struct SwipeSettings: View {
        var body: some View {
            ForEach(SwipeList.allCases) { list in
                let last = list == SwipeList.allCases.last
                SettingsView.group(
                    list.title, footer: [list.footer] + (last ? ["These choices stay on this iPhone."] : [])
                ) {
                    SwipeChoice(list: list, side: .left)
                    SwipeChoice(list: list, side: .right)
                }
            }
        }
    }

    /// One way's choice for one list.
    private struct SwipeChoice: View {
        let list: SwipeList
        let side: SwipeDrag.Side
        @AppStorage private var action: SwipeAction

        init(list: SwipeList, side: SwipeDrag.Side) {
            self.list = list
            self.side = side
            _action =
                side == .left
                ? AppStorage(wrappedValue: list.leftDefault, list.leftKey)
                : AppStorage(wrappedValue: list.rightDefault, list.rightKey)
        }

        var body: some View {
            Picker(selection: $action) {
                ForEach(SwipeAction.allCases) { option in
                    Text(verbatim: option.title).tag(option)
                }
            } label: {
                Text(verbatim: side == .left ? "Swipe left" : "Swipe right")
                    .foregroundStyle(Theme.ink)
            }
            .pickerStyle(.menu)
            .tint(Theme.secondary)
        }
    }
#endif
