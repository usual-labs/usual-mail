// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "UsualMailKit",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "UsualMailKit", targets: ["UsualMailKit"])
    ],
    dependencies: [
        // The on-device copy of mail. Pinned exactly; see docs/agents/apps.md for why SQLite through GRDB.
        .package(url: "https://github.com/groue/GRDB.swift.git", exact: "7.12.0")
    ],
    targets: [
        .target(
            name: "UsualMailKit",
            dependencies: [.product(name: "GRDB", package: "GRDB.swift")],
            // A copy of core/fixtures/sample.json (scripts/copy-sample.sh), for previews and tests.
            resources: [.copy("Resources/sample.json")]
        ),
        .testTarget(name: "UsualMailKitTests", dependencies: ["UsualMailKit"]),
    ]
)
