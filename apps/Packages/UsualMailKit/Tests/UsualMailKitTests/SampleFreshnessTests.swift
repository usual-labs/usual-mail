import Foundation
import Testing

@testable import UsualMailKit

struct SampleFreshnessTests {
    /// core/fixtures/sample.json, found from this file: apps/Packages/UsualMailKit/Tests/UsualMailKitTests/.
    static let coreSample = URL(filePath: #filePath)
        .deletingLastPathComponent()  // UsualMailKitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // UsualMailKit
        .deletingLastPathComponent()  // Packages
        .deletingLastPathComponent()  // apps
        .deletingLastPathComponent()  // usual-mail
        .appending(path: "core/fixtures/sample.json")

    @Test func theBundledSampleMatchesCore() throws {
        let core = try Data(contentsOf: Self.coreSample)
        let bundled = try Data(contentsOf: SampleData.bundledURL)
        #expect(
            bundled == core,
            "UsualMailKit's copy of sample.json differs from core/fixtures/sample.json. Run apps/scripts/copy-sample.sh."
        )
    }
}
