import SwiftUI
import UsualMailKit

/// The chips under the field: first the filters in force, whether chosen (a person from People) or typed and
/// understood by the server (`from:anna`), each removable with its ×; then one toggle per kind, the categories, then
/// Screening and Archived (`done`). The row scrolls sideways when it doesn't fit.
struct SearchChipsRow: View {
    let model: SearchModel

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(model.chips, id: \.self) { chip in
                    SearchChipButton(
                        title: SearchWords.chip(chip, person: model.chosenPerson), on: true, removable: true
                    ) {
                        withAnimation(Motion.move) { model.remove(chip) }
                    }
                    .transition(.blurReveal)
                }
                ForEach(SearchKind.all, id: \.self) { kind in
                    SearchChipButton(title: SearchWords.kind(kind), on: model.filters.kinds?.contains(kind) == true) {
                        model.toggle(kind)
                    }
                }
            }
            .padding(.vertical, 2)
            .padding(.horizontal, Theme.pageInset)
        }
        .scrollIndicators(.never)
        .animation(Motion.reveal, value: model.chips)
    }
}

/// One chip: a small capsule, white with ink words while on, clear with quieter words while off; a filter's chip ends
/// in ×, which removes it.
private struct SearchChipButton: View {
    let title: String
    let on: Bool
    var removable = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            SearchChipLabel(title: title, on: on, removable: removable)
        }
        .buttonStyle(PlainControlStyle())
        .accessibilityLabel(removable ? "Remove \(title)" : title)
        .accessibilityAddTraits(on && !removable ? .isSelected : [])
    }
}

private struct SearchChipLabel: View {
    let title: String
    let on: Bool
    let removable: Bool
    @Environment(\.isControlHovered) private var hovered

    var body: some View {
        HStack(spacing: 4) {
            Text(verbatim: title)
                .font(Theme.sans(10))
                .lineLimit(1)
                .fixedSize()
            if removable {
                Image(systemName: "xmark")
                    .font(.system(size: 7, weight: .semibold))
            }
        }
        .foregroundStyle(on ? Theme.ink : Theme.secondary)
        .padding(.horizontal, 10)
        .frame(height: 22)
        .background(Color.white.opacity(on ? 1 : (hovered ? 0.5 : 0.25)), in: Capsule())
        .overlay(Capsule().stroke(Theme.hairline, lineWidth: on ? 1 : 0.5))
    }
}
