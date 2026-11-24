import SwiftUI
import UsualMailKit

/// A sender's initials (`initials(_:)`) on a soft circle, 16 points: one of six colour pairs from the design, chosen by
/// `key` (their address, else their name: `key(for:in:)`) so a sender keeps their colour. With a sender picture
/// (`avatar`, docs/contract-avatars.md) the picture fades in over the initials once it is loaded through the server, or
/// shows at once when it is already in memory, without changing the size; until then, and whenever it can't be had,
/// the initials show. No badge, and hidden from accessibility like the initials.
struct Avatar: View {
    let name: String
    let key: String
    var avatar: SenderPicture? = nil
    @Environment(\.senderPictures) private var pictures
    /// The still loaded for a picture id, so a changed picture never shows the old one.
    @State private var loaded: (id: String, still: CGImage)?

    static let side: CGFloat = 16

    var body: some View {
        let colors = Avatar.colors(for: key)
        let initials = Avatar.initials(name)
        Circle()
            .fill(colors.background)
            .frame(width: Self.side, height: Self.side)
            .overlay {
                Text(initials)
                    .font(Theme.sans(initials.count > 1 ? 7 : 9, weight: .semibold))
                    .foregroundStyle(colors.ink)
            }
            .overlay {
                if let avatar, let still = still(for: avatar) {
                    SenderPictureFace(still: still, fit: avatar.fit)
                        .transition(.opacity)
                }
            }
            .task(id: avatar?.id) { await load() }
            .accessibilityHidden(true)
    }

    /// The still for this picture: the one this view loaded, else one already in memory.
    private func still(for avatar: SenderPicture) -> CGImage? {
        if let loaded, loaded.id == avatar.id { return loaded.still }
        return pictures?.cached(avatar)
    }

    /// Loads the picture unless it is already in memory, then fades it in once.
    private func load() async {
        guard let avatar, let id = avatar.id, let pictures, pictures.cached(avatar) == nil,
            let still = await pictures.still(for: avatar), !Task.isCancelled
        else { return }
        withAnimation(Motion.reveal) { loaded = (id, still) }
    }

    struct Colors: Equatable {
        let background: Color
        let ink: Color
    }

    /// The design's pairs: green, purple, sand, blue, red, slate.
    static let palette: [Colors] = [
        Colors(background: Color(hex: 0xDDE9E2), ink: Color(hex: 0x365C49)),
        Colors(background: Color(hex: 0xE9DFF0), ink: Color(hex: 0x694A7C)),
        Colors(background: Color(hex: 0xF1E4D0), ink: Color(hex: 0x785A2E)),
        Colors(background: Color(hex: 0xDCE7F3), ink: Color(hex: 0x3C597D)),
        Colors(background: Color(hex: 0xF0DDDA), ink: Color(hex: 0x874F48)),
        Colors(background: Color(hex: 0xE3E3EF), ink: Color(hex: 0x57577D)),
    ]

    /// The same pair for the same key in every run (Swift's own hashing changes per process).
    static func colors(for key: String) -> Colors {
        var hash: UInt32 = 2_166_136_261
        for byte in key.lowercased().utf8 {
            hash = (hash ^ UInt32(byte)) &* 16_777_619
        }
        return palette[Int(hash % UInt32(palette.count))]
    }

    /// What a thread's sender's colour is chosen by, the same in all their threads: their address (the thread's own
    /// sender address when it has no participants), else their name, else the thread's subject, in lower case. Never
    /// the thread's id, which would give one sender a new colour in every thread. Blank values count as missing.
    nonisolated static func key(for sender: Address?, in thread: MailThread) -> String {
        let candidates = [sender.map(\.email) ?? thread.sender, sender?.name, thread.subject]
        let key = candidates.lazy.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first {
            !$0.isEmpty
        }
        return (key ?? "").lowercased()
    }
}

/// A sender picture drawn in the avatar's circle, a still. `fill` fills the circle, cut to it; `inset` (and a fit this
/// app doesn't know) sits on a white disc, scaled to fit inside about three quarters of it, about 12% clear all round.
struct SenderPictureFace: View {
    let still: CGImage
    let fit: SenderPictureFit

    /// How much of the circle's width an inset picture may take.
    static let insetShare: CGFloat = 0.76

    var body: some View {
        let image = Image(decorative: still, scale: 1).resizable().interpolation(.high).antialiased(true)
        Group {
            if fit.fillsTheCircle {
                image.scaledToFill()
            } else {
                Circle()
                    .fill(.white)
                    .overlay {
                        image.scaledToFit()
                            .frame(width: Avatar.side * Self.insetShare, height: Avatar.side * Self.insetShare)
                    }
            }
        }
        .frame(width: Avatar.side, height: Avatar.side)
        .clipShape(Circle())
    }
}

extension EnvironmentValues {
    /// Where sender pictures come from: the store's (`MailStore.senderPictures`), set by the window. Without one,
    /// avatars show initials.
    @Entry var senderPictures: SenderPictures? = nil
}

extension Color {
    /// A colour from a hex number, for the design's fixed values.
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255)
    }
}
