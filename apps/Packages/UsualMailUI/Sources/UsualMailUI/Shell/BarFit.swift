import CoreGraphics
import UsualMailDesign

#if os(iOS)
    import UIKit
#else
    import AppKit
#endif

/// How wide the row of capsules is (`TopBar`), to see on the iPhone whether the chosen tab's name fits beside the other
/// capsules: with the larger controls of 2026-11-25 (`ControlSize`), "Notifications" named no longer fits every
/// screen, and Settings' chosen tab beside its back button fits none. Each capsule is measured as `TopBar.capsule`
/// draws it: with an icon alone, round; with words, its ends' insets, the icon, 6 and the words (the screening
/// capsule's insets 10 and its gap 4); a gap at its least, and `ControlSize.spacing` between the items.
enum BarFit {
    /// The row's width with each item showing `title(item)`, the words measured by `words` (`measure` in the app).
    static func width(
        _ items: [TopBar.Item], title: (TopBar.Item) -> String?, words: (String) -> CGFloat = measure
    ) -> CGFloat {
        let widths = items.map { item -> CGFloat in
            switch item {
            case .gap: ControlSize.spacing
            case .screening: capsule(title(item), inset: 10, spacing: 4, words: words)
            default: capsule(title(item), inset: ControlSize.inset, spacing: 6, words: words)
            }
        }
        return widths.reduce(0, +) + ControlSize.spacing * CGFloat(max(0, items.count - 1))
    }

    /// One capsule's width: round with an icon alone, else as wide as its icon and words.
    static func capsule(_ title: String?, inset: CGFloat, spacing: CGFloat, words: (String) -> CGFloat) -> CGFloat {
        guard let title else { return max(ControlSize.height, 2 * inset + ControlSize.icon) }
        return max(ControlSize.height, 2 * inset + ControlSize.icon + spacing + words(title))
    }

    /// How wide `words` are in the capsules' type (Geist at `ControlSize.text`), rounded up.
    static func measure(_ words: String) -> CGFloat {
        let name = UsualFonts.face(.sans, weight: .regular)?.postScriptName ?? "Geist-Regular"
        #if os(iOS)
            let font = UIFont(name: name, size: ControlSize.text) ?? .systemFont(ofSize: ControlSize.text)
        #else
            let font = NSFont(name: name, size: ControlSize.text) ?? .systemFont(ofSize: ControlSize.text)
        #endif
        return (words as NSString).size(withAttributes: [.font: font]).width.rounded(.up)
    }
}
