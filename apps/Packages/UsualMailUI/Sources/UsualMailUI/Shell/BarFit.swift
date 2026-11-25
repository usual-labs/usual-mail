import CoreGraphics
import UsualMailDesign

#if os(iOS)
    import UIKit
#else
    import AppKit
#endif

/// How wide the row of capsules is (`TopBar`), to see on the iPhone whether the chosen tab's name fits beside the other
/// capsules: with the larger controls of 2026-11-25 (`ControlSize`), "Notifications" named no longer fits every
/// screen. Each capsule is measured as `TopBar.capsule` draws it: with an icon alone, round; with words, its ends'
/// insets, the icon, 6 and the words (the screening capsule's insets and gap its own, `TopBar.screeningInset` and
/// `screeningSpacing`); a gap at its least, and the measures' spacing between the items. The measures are this
/// platform's unless given, so the iPhone's are reasoned about on the Mac too.
enum BarFit {
    /// Whether `items`, each showing `title(item)`, fit `room` points.
    static func fits(
        _ items: [TopBar.Item], room: CGFloat, title: (TopBar.Item) -> String?,
        words: (String) -> CGFloat = { measure($0) }, measures: ControlMeasures = ControlSize.current
    ) -> Bool {
        width(items, title: title, words: words, measures: measures) <= room
    }

    /// The row's width with each item showing `title(item)`, the words measured by `words` (`measure` in the app).
    static func width(
        _ items: [TopBar.Item], title: (TopBar.Item) -> String?, words: (String) -> CGFloat = { measure($0) },
        measures: ControlMeasures = ControlSize.current
    ) -> CGFloat {
        let widths = items.map { item -> CGFloat in
            switch item {
            case .gap:
                measures.spacing
            case .screening:
                capsule(
                    title(item), inset: TopBar.screeningInset, spacing: TopBar.screeningSpacing, words: words,
                    measures: measures)
            default:
                capsule(title(item), inset: measures.inset, spacing: 6, words: words, measures: measures)
            }
        }
        return widths.reduce(0, +) + measures.spacing * CGFloat(max(0, items.count - 1))
    }

    /// One capsule's width: round with an icon alone, else as wide as its icon and words.
    static func capsule(
        _ title: String?, inset: CGFloat, spacing: CGFloat, words: (String) -> CGFloat,
        measures: ControlMeasures = ControlSize.current
    ) -> CGFloat {
        guard let title else { return max(measures.height, 2 * inset + measures.icon) }
        return max(measures.height, 2 * inset + measures.icon + spacing + words(title))
    }

    /// How wide `words` are in the capsules' type (Geist at `size`, this platform's by default), rounded up.
    static func measure(_ words: String, size: CGFloat = ControlSize.text) -> CGFloat {
        let name = UsualFonts.face(.sans, weight: .regular)?.postScriptName ?? "Geist-Regular"
        #if os(iOS)
            let font = UIFont(name: name, size: size) ?? .systemFont(ofSize: size)
        #else
            let font = NSFont(name: name, size: size) ?? .systemFont(ofSize: size)
        #endif
        return (words as NSString).size(withAttributes: [.font: font]).width.rounded(.up)
    }
}
