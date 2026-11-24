// swift-tools-version: 6.2
import PackageDescription

// Usual Mail's design values for SwiftUI: colours, hats, type, space, radii, motion, the fonts and the icons.
// Sources/UsualMailDesign/Generated and Resources are written by `npm run build` in design/; don't edit them.
let package = Package(
    name: "UsualMailDesign",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "UsualMailDesign", targets: ["UsualMailDesign"])
    ],
    targets: [
        .target(name: "UsualMailDesign", resources: [.process("Resources")]),
        .testTarget(name: "UsualMailDesignTests", dependencies: ["UsualMailDesign"]),
    ]
)
