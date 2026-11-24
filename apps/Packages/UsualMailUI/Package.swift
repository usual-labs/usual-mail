// swift-tools-version: 6.2
import PackageDescription

// The screens of both apps: the Mac shell is fenced with `#if os(macOS)`, the iPhone shell (Phone/) with `#if os(iOS)`.
let package = Package(
    name: "UsualMailUI",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "UsualMailUI", targets: ["UsualMailUI"])
    ],
    dependencies: [
        .package(path: "../UsualMailKit"),
        // Usual Mail's fonts and design values (design/swift in the repository), used as they are.
        .package(path: "../../../design/swift"),
    ],
    targets: [
        .target(
            name: "UsualMailUI",
            dependencies: ["UsualMailKit", .product(name: "UsualMailDesign", package: "swift")],
            // The design's icons and wallpaper (Figma, 2026-11-17).
            resources: [.process("Resources")]
        ),
        .testTarget(name: "UsualMailUITests", dependencies: ["UsualMailUI"]),
    ]
)
