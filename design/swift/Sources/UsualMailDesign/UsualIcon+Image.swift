import SwiftUI

extension UsualIcon {
    /// The icon as a template image from the package's asset catalog. It takes the foreground style.
    public var image: Image { Image(rawValue, bundle: .module) }

    /// The icon at a size from `UsualSize`, such as `UsualSize.iconMd`.
    public func view(size: CGFloat) -> some View {
        image.resizable().scaledToFit().frame(width: size, height: size).accessibilityHidden(true)
    }
}

extension Bundle {
    /// The bundle holding the fonts and Icons.xcassets, for code outside the package that needs it.
    public static var usualMailDesign: Bundle { .module }
}
