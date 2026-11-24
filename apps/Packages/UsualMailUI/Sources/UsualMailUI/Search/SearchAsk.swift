import SwiftUI
import UsualMailKit

/// Ask, at the search field's right end (docs/contract-search.md, "Asking in a sentence"): a small glass capsule with
/// the free set's sparkles and the word, ⌘↩ its shortcut. It sends the sentence in the field to the server's AI, only
/// on this explicit action: plain typing and Enter stay an ordinary search. While the sentence is on its way it shows
/// "Asking…" with a small progress; the field stays editable, and typing cancels it (`SearchModel.ask`). It can't be
/// pressed with nothing in the field, over 200 characters, or while the server asks to wait. The privacy line is in its
/// tooltip, and its VoiceOver hint: only the sentence goes to the person's AI service, never their mail.
struct SearchAskButton: View {
    let model: SearchModel

    var body: some View {
        Button {
            model.ask()
        } label: {
            SearchAskLabel(asking: model.isAsking)
        }
        .buttonStyle(PlainControlStyle())
        .disabled(!model.canAsk)
        .keyboardShortcut(.return, modifiers: .command)
        // To its left, over the field, where the line has room; under it, the card's edge would cut it.
        .tooltip(SearchWords.askTooltip(waiting: model.askWaitsUntil != nil), edge: .leading)
        .accessibilityLabel(SearchWords.ask)
        .accessibilityHint(SearchWords.askPrivacy)
    }
}

private struct SearchAskLabel: View {
    let asking: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.isControlHovered) private var hovered

    var body: some View {
        HStack(spacing: 4) {
            if asking {
                ProgressView().controlSize(.mini).frame(width: 12, height: 12)
            } else {
                Icon.ask.view(size: 12)
            }
            Text(asking ? SearchWords.asking : SearchWords.ask)
                .font(Theme.sans(10))
                .foregroundStyle(Theme.ink)
                .fixedSize()
        }
        .padding(.horizontal, 8)
        .frame(height: 22)
        .contentShape(Capsule())
        .glassEffect(GlassControl.glass(selected: false, hovered: hovered), in: Capsule())
        .overlay(Capsule().stroke(Theme.hairline, lineWidth: 0.5))
        .opacity(enabled || asking ? 1 : 0.45)
    }
}

/// The quiet line under the chips once a sentence was asked (`SearchWords.askNote`): nothing when the AI understood
/// it, since the chips say it; "Searched as typed"; the server's reason the AI didn't answer; "try again shortly"; or
/// when the AI isn't set up, that, with the AI settings offered. It goes with the person's next change.
struct SearchAskNote: View {
    let outcome: SearchAskOutcome?
    let openAISettings: () -> Void

    var body: some View {
        if let outcome, let note = SearchWords.askNote(outcome) {
            HStack(spacing: 8) {
                Text(verbatim: note.words)
                    .font(Theme.sans(10))
                    .foregroundStyle(Theme.time)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if note.offersSettings {
                    QuietButton(SearchWords.aiSettings, action: openAISettings)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.pageInset)
            .transition(.blurReveal)
        }
    }
}
