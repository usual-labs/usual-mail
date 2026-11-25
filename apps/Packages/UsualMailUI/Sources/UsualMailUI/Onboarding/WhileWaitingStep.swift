import SwiftUI
import UsualMailKit

/// "While your mail comes in": nine slides on what Usual Mail does (arrows, dots, and the left and right keys), each
/// with its clip of the feature (`TourClip`: the Mac app on the tour's sample, a pointer moving and clicking, looping;
/// still with Reduce Motion on), and at the foot how the first sorting goes and "Go to Home", which is always there.
struct WhileWaitingStep: View {
    let home: () -> Void
    @Environment(MailStore.self) private var store
    @State private var index = 0

    private let slides = Onboarding.slides
    /// The clips' proportions (a 1512 × 982 window, framed at 1280 × 832).
    private static let aspect: CGFloat = TourClip.aspect
    /// What the card takes beside the clip: its own padding, and on the iPhone its 16 from the screen's edges (it overflowed
    /// a 402-point screen before, seen 2026-11-25).
    #if os(iOS)
        private static let sideRoom: CGFloat = 48 + 32
    #else
        private static let sideRoom: CGFloat = 48
    #endif

    var body: some View {
        GeometryReader { geometry in
            // As wide as the mail card, smaller in a short window or on the iPhone, so the whole step stays on screen.
            let width = min(
                652, geometry.size.width - Self.sideRoom, max(300, (geometry.size.height - 320) * Self.aspect))
            VStack(alignment: .leading, spacing: 16) {
                // One player a slide, crossfading as the slide changes, so a clip always starts from its beginning.
                ZStack {
                    TourClipView(clip: TourClip.all[min(index, TourClip.all.count - 1)])
                        .id(index)
                        .transition(.opacity)
                }
                .frame(width: width, height: width / Self.aspect)
                .background(Theme.card)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.hairline) }
                .accessibilityElement()
                .accessibilityLabel("A short clip of this in Usual Mail")
                HStack(alignment: .center, spacing: 12) {
                    arrow("chevron.left", label: "Previous", key: .leftArrow, enabled: index > 0) { show(index - 1) }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(slides[index].title)
                            .font(Theme.sans(16, weight: .medium))
                            .foregroundStyle(Theme.ink)
                        StepText(slides[index].line)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id(index)
                    .transition(.blurReveal)
                    arrow("chevron.right", label: "Next", key: .rightArrow, enabled: index < slides.count - 1) {
                        show(index + 1)
                    }
                }
                .frame(minHeight: 48)
                dots
                Divider().opacity(0.5)
                HStack(alignment: .center) {
                    Text(verbatim: Onboarding.progressWords(status: store.aiStatus, inboxes: store.lists.inboxes))
                        .font(Theme.sans(12))
                        .foregroundStyle(Theme.secondary)
                        .contentTransition(.opacity)
                    Spacer(minLength: 12)
                    PrimaryButton(title: "Go to Home", action: home)
                }
            }
            .onboardingCard(width: width + 48)
            .revealOnAppear()
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: OnboardingLayout.cardAlignment)
        }
    }

    private var dots: some View {
        HStack(spacing: 8) {
            ForEach(slides.indices, id: \.self) { slide in
                Button {
                    show(slide)
                } label: {
                    SlideDot(current: slide == index)
                }
                .buttonStyle(PlainControlStyle())
                .accessibilityLabel("Slide \(slide + 1) of \(slides.count)")
                .accessibilityAddTraits(slide == index ? .isSelected : [])
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func arrow(
        _ symbol: String, label: String, key: KeyEquivalent, enabled: Bool, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            SlideArrow(symbol: symbol)
        }
        .buttonStyle(PlainControlStyle())
        .keyboardShortcut(key, modifiers: [])
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
        .accessibilityLabel(label)
    }

    private func show(_ slide: Int) {
        guard slides.indices.contains(slide) else { return }
        withAnimation(Motion.reveal) { index = slide }
    }
}

/// A carousel arrow: a white circle on the card, brighter under the pointer.
private struct SlideArrow: View {
    let symbol: String
    @Environment(\.isControlHovered) private var hovered

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Theme.icon)
            .frame(width: 32, height: 32)
            .background(Color.white.opacity(hovered ? 0.95 : 0.7), in: Circle())
            .overlay { Circle().strokeBorder(Theme.hairline) }
    }
}

/// A carousel dot: dark for the slide shown, darker under the pointer for the others.
private struct SlideDot: View {
    let current: Bool
    @Environment(\.isControlHovered) private var hovered

    var body: some View {
        Circle()
            .fill(Theme.ink.opacity(current ? 0.8 : hovered ? 0.45 : 0.2))
            .frame(width: 6, height: 6)
            .padding(3)
            .contentShape(Rectangle())
    }
}
