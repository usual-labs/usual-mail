import SwiftUI
import UsualMailKit

/// An inbox's icon in Settings, which is also the control that changes it (owner's words of 2026-11-20: "in the
/// settings user should be able to change the icon for the inboxes"). The small button, a soft circle under the
/// pointer, opens a popover of every icon an inbox may have (`InboxIconChoice.options`) in rows of seven, each a glass
/// button, the inbox's own tinted as a chosen rail button is. Choosing one closes the popover and saves it at once.
/// Inbox changes wait for the server, so until it answers a small spinner stands in for the icon; then the row, the
/// profile switch and every other place that draws it change together, from the store's copy. The row says a
/// refusal (`InboxIconChoice.refusal`). Esc closes the popover, as it does any popover.
struct InboxIconPicker: View {
    let inbox: Inbox
    let choice: InboxIconChoice
    @Environment(MailStore.self) private var store
    @State private var picking = false

    /// Icons in a row of the popover: the fourteen make two rows of seven.
    static let columns = 7

    var body: some View {
        Button {
            picking = true
        } label: {
            InboxIconLabel(icon: inbox.icon, saving: choice.isSaving)
        }
        .buttonStyle(PlainControlStyle())
        .disabled(choice.isSaving)
        .tooltip(picking || choice.isSaving ? nil : "Change icon")
        .accessibilityLabel("Change icon for \(inbox.name)")
        .accessibilityValue(choice.isSaving ? "Saving" : Self.name(inbox.icon))
        .popover(isPresented: $picking, arrowEdge: .bottom) {
            grid
        }
    }

    private var grid: some View {
        GlassEffectContainer(spacing: 8) {
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(32), spacing: 8), count: Self.columns), spacing: 8) {
                ForEach(InboxIconChoice.options(current: inbox.icon)) { option in
                    Button {
                        choose(option.icon)
                    } label: {
                        Icon(option.icon).view()
                            .frame(width: 32, height: 32)
                            .glassControl(selected: option.isCurrent)
                    }
                    .buttonStyle(PlainControlStyle())
                    .accessibilityLabel(Self.name(option.icon))
                    .accessibilityAddTraits(option.isCurrent ? .isSelected : [])
                }
            }
        }
        .padding(12)
    }

    /// Closes the popover and saves the icon; choosing the one the inbox has only closes it.
    private func choose(_ icon: InboxIcon) {
        picking = false
        Task { await choice.choose(icon, for: inbox.id, in: store) }
    }

    /// An icon's name, for VoiceOver.
    static func name(_ icon: InboxIcon) -> String {
        switch icon {
        case .person: "Person"
        case .building: "Building"
        case .briefcase: "Briefcase"
        case .house: "House"
        case .shop: "Shop"
        case .globe: "Globe"
        case .plane: "Plane"
        case .wallet: "Wallet"
        case .family: "Family"
        case .rocket: "Rocket"
        case .school: "School"
        case .heart: "Heart"
        case .star: "Star"
        case .leaf: "Leaf"
        case .unknown(let raw): raw
        }
    }
}

/// The row's icon as the design draws it, on a soft circle under the pointer; a small spinner in its place while a new
/// one is on its way to the server.
private struct InboxIconLabel: View {
    let icon: InboxIcon
    let saving: Bool
    @Environment(\.isControlHovered) private var hovered

    var body: some View {
        ZStack {
            if saving {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 16, height: 16)
                    .transition(.blurReveal)
            } else {
                Icon(icon).view()
                    .id(icon)
                    .transition(.blurReveal)
            }
        }
        .frame(width: 24, height: 24)
        .background(Circle().fill(Color.black.opacity(hovered ? 0.06 : 0)))
        .contentShape(Circle())
        .animation(Motion.reveal, value: saving)
        .animation(Motion.reveal, value: icon)
    }
}
