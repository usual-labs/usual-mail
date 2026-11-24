import Foundation
import Testing
import UsualMailDesign
import UsualMailKit

@testable import UsualMailUI

struct FontTests {
    @Test func theDesignFontsRegister() {
        #expect(Theme.registerFonts().isEmpty)
        for face in UsualFonts.faces {
            #expect(UsualFonts.isAvailable(face), "\(face.postScriptName) didn't register")
        }
        // Again is fine: registration happens once.
        #expect(Theme.registerFonts().isEmpty)
    }
}

/// The icons and the wallpaper are in their asset catalogs (this package's, or the design package's for the later inbox
/// icons) under the names the views ask for.
struct AssetTests {
    @Test func everyIconAndTheWallpaperAreBundled() {
        for icon in Icon.allCases {
            #expect(icon.catalog.image(forResource: icon.rawValue) != nil, "\(icon.rawValue) is missing")
        }
        #expect(Icon.bundle.image(forResource: "wallpaper") != nil)
    }
}

/// A list's items come into focus one after another, and none waits long.
struct MotionTests {
    @Test func staggerIsShortAndCapped() {
        #expect(Motion.delay(at: 0) == 0)
        #expect(abs(Motion.delay(at: 3) - 0.105) < 0.0001)
        #expect(Motion.delay(at: 100) == Motion.longestWait)
        #expect(Motion.longestWait <= 0.3)
    }
}
